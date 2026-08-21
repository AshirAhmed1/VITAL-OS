/**
 * VITAL OS — client-side Whisper transcription contract.
 *
 * Pure module: no React, no MediaRecorder, no browser globals at import time.
 * Everything that can be unit-tested lives here; hooks/use-utterance-recorder.ts
 * owns the browser glue.
 *
 * The route (`POST /api/transcribe`) races Groq Whisper (2500ms) against a
 * Gemini audio fallback (8000ms), so the client budget has to clear both legs
 * plus upload time or we would abort a request that was about to succeed.
 */

export const TRANSCRIBE_ENDPOINT = "/api/transcribe";

/**
 * Server worst case is PRIMARY_TIMEOUT_MS + FALLBACK_TIMEOUT_MS = 10.5s, and
 * each leg may now retry inside its own budget. 14s leaves room for the upload
 * without letting a wedged request hold the mic forever.
 */
export const TRANSCRIBE_CLIENT_TIMEOUT_MS = 14_000;

/** Below this, the clip is a click or a breath — not worth a round trip. */
export const MIN_UTTERANCE_BYTES = 2_048;
export const MIN_UTTERANCE_MS = 350;

/** Mirrors GROQ_MAX_AUDIO_BYTES so we fail locally instead of eating a 413. */
export const MAX_UTTERANCE_BYTES = 25 * 1024 * 1024;

/**
 * Ordered by preference. Opus in WebM is what Chrome and Edge produce and what
 * Whisper handles best; audio/mp4 is the Safari escape hatch. Every entry is
 * inside the route's ACCEPTED_AUDIO regex — keep the two in sync.
 */
export const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

/** First candidate the platform admits, or null if none (fall back to browser STT). */
export function pickRecorderMimeType(
  isTypeSupported: (mime: string) => boolean
): string | null {
  for (const mime of RECORDER_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      /* Safari throws on some strings rather than returning false. */
    }
  }
  return null;
}

export type TranscriptionFailure =
  | "too-short"
  | "forbidden"
  | "unconfigured"
  | "unsupported-audio"
  | "too-large"
  | "timeout"
  | "network"
  | "provider"
  | "empty";

export type TranscriptionOutcome =
  | {
      ok: true;
      text: string;
      provider: string;
      latencyMs: number;
      fallbackReason: string | null;
    }
  | { ok: false; reason: TranscriptionFailure; detail: string };

type TranscribeRouteBody = {
  text?: unknown;
  provider?: unknown;
  latencyMs?: unknown;
  fallbackReason?: unknown;
  error?: unknown;
  detail?: unknown;
  code?: unknown;
};

/** HTTP status -> a reason the caller can branch on without string matching. */
function failureForStatus(status: number): TranscriptionFailure {
  if (status === 403) return "forbidden";
  if (status === 503) return "unconfigured";
  if (status === 413) return "too-large";
  if (status === 415) return "unsupported-audio";
  return "provider";
}

export interface PostUtteranceInput {
  audio: Blob;
  durationMs?: number;
  language?: string;
  filename?: string;
  /** Caller's abort (barge-in, unmount, new utterance). */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Uploads one utterance and normalises every outcome into a value.
 * Never throws for a network or provider failure — STT falling over must not
 * take down the voice session, it must demote to the browser transcript.
 */
export async function postUtterance(
  input: PostUtteranceInput
): Promise<TranscriptionOutcome> {
  const { audio } = input;

  if (audio.size < MIN_UTTERANCE_BYTES) {
    return {
      ok: false,
      reason: "too-short",
      detail: `Clip is ${audio.size} bytes, below the ${MIN_UTTERANCE_BYTES}-byte floor.`,
    };
  }
  if (
    typeof input.durationMs === "number" &&
    input.durationMs < MIN_UTTERANCE_MS
  ) {
    return {
      ok: false,
      reason: "too-short",
      detail: `Clip is ${Math.round(input.durationMs)}ms, below the ${MIN_UTTERANCE_MS}ms floor.`,
    };
  }
  if (audio.size > MAX_UTTERANCE_BYTES) {
    return {
      ok: false,
      reason: "too-large",
      detail: `Clip is ${(audio.size / 1024 / 1024).toFixed(1)} MB; limit is 25 MB.`,
    };
  }

  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? TRANSCRIBE_CLIENT_TIMEOUT_MS;

  const onExternalAbort = () => controller.abort();
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const form = new FormData();
  form.append("audio", audio, input.filename ?? "utterance.webm");
  form.append("language", input.language ?? "en");

  try {
    const res = await doFetch(TRANSCRIBE_ENDPOINT, {
      method: "POST",
      /* No Content-Type: the browser sets the multipart boundary itself, and
         no role header: /api/transcribe reads the caller's clinicians row. */
      body: form,
      signal: controller.signal,
      cache: "no-store",
    });

    const body = (await res.json().catch(() => null)) as TranscribeRouteBody | null;

    if (!res.ok) {
      const detail =
        (typeof body?.error === "string" && body.error) ||
        (typeof body?.detail === "string" && body.detail) ||
        `Transcription failed with HTTP ${res.status}.`;
      return { ok: false, reason: failureForStatus(res.status), detail };
    }

    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) {
      return {
        ok: false,
        reason: "empty",
        detail: "Transcription returned no text.",
      };
    }

    return {
      ok: true,
      text,
      provider: typeof body?.provider === "string" ? body.provider : "unknown",
      latencyMs: typeof body?.latencyMs === "number" ? body.latencyMs : 0,
      fallbackReason:
        typeof body?.fallbackReason === "string" ? body.fallbackReason : null,
    };
  } catch (err) {
    if (timedOut) {
      return {
        ok: false,
        reason: "timeout",
        detail: `No transcript within ${timeoutMs}ms.`,
      };
    }
    /* Caller aborted (barge-in / unmount) — surface it as its own reason so
       the UI does not show a scary error for something the user did. */
    const name = (err as { name?: string } | null)?.name;
    if (name === "AbortError") {
      return { ok: false, reason: "network", detail: "Upload was cancelled." };
    }
    return {
      ok: false,
      reason: "network",
      detail: err instanceof Error ? err.message : "Upload failed.",
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export type TranscriptChoice = {
  text: string;
  source: "whisper" | "browser" | "none";
  /** Null when Whisper won. Otherwise why we used the browser transcript. */
  degradedReason: string | null;
};

/**
 * Whisper is authoritative; the browser transcript is the safety net.
 *
 * A clinician mid-round must never lose a command because STT had a bad
 * second, so any Whisper failure demotes to the text SpeechRecognition already
 * produced rather than surfacing an error. The one asymmetry: if Whisper
 * succeeded, we take it even when the browser disagrees — that is the whole
 * point of routing clinical vocabulary through Whisper.
 */
export function chooseTranscript(
  whisper: TranscriptionOutcome,
  browserText: string
): TranscriptChoice {
  const fallback = browserText.trim();

  if (whisper.ok && whisper.text) {
    return { text: whisper.text, source: "whisper", degradedReason: null };
  }

  const reason = whisper.ok
    ? "Whisper returned an empty transcript."
    : `${whisper.reason}: ${whisper.detail}`;

  if (fallback) {
    return { text: fallback, source: "browser", degradedReason: reason };
  }
  return { text: "", source: "none", degradedReason: reason };
}
