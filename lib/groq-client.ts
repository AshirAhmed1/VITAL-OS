/**
 * VITAL OS — Groq client (primary inference leg).
 *
 * Plain fetch against Groq's OpenAI-compatible endpoints: no SDK, so the
 * serverless bundle stays small and every call accepts our AbortSignal.
 * Server-side only — never import from a client component.
 */

const GROQ_BASE_URL =
  process.env.GROQ_BASE_URL?.trim() || "https://api.groq.com/openai/v1";

/** Fast instruction-following model for transcript -> JSON intent parsing. */
export const GROQ_INTENT_MODEL =
  process.env.GROQ_INTENT_MODEL?.trim() || "llama-3.3-70b-versatile";

/** Whisper on Groq's LPUs — real-time-ish STT for the voice path. */
export const GROQ_WHISPER_MODEL =
  process.env.GROQ_WHISPER_MODEL?.trim() || "whisper-large-v3-turbo";

/** Groq rejects uploads above 25 MB on the free tier. */
export const GROQ_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface GroqErrorOptions {
  /** Overrides the status-derived default. */
  retryable?: boolean;
  /** Server-supplied backoff, in ms. Read by lib/llm-race.ts before it retries. */
  retryAfterMs?: number | null;
}

export class GroqError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number, opts: GroqErrorOptions = {}) {
    super(message);
    this.name = "GroqError";
    this.status = status;
    this.retryable = opts.retryable ?? (status === 429 || status >= 500);
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

/**
 * Retry-After is either delta-seconds or an HTTP date. Honouring it keeps our
 * backoff aligned with Groq's own rate limiter instead of guessing at it.
 */
function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    return Math.max(0, at - Date.now());
  }
  return null;
}

function groqApiKey(): string | null {
  return process.env.GROQ_API_KEY?.trim() || null;
}

/** Lets callers drop Groq out of the provider chain instead of racing a 401. */
export function isGroqConfigured(): boolean {
  return Boolean(groqApiKey());
}

function requireKey(): string {
  const key = groqApiKey();
  if (!key) {
    /* Not retryable: a missing key is a deploy problem, not an upstream blip.
       Without this override, status 503 would earn three pointless retries. */
    throw new GroqError("GROQ_API_KEY is not set on the server.", 503, {
      retryable: false,
    });
  }
  return key;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  return (
    body?.error?.message?.trim() ||
    `Groq request failed with HTTP ${res.status}.`
  );
}

export interface GroqChatJsonInput {
  system: string;
  user: string;
  signal: AbortSignal;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Chat completion pinned to JSON object output.
 * Returns the raw assistant string — the caller owns parsing and validation,
 * so a malformed payload can demote Groq to the fallback provider.
 */
export async function groqChatJson(input: GroqChatJsonInput): Promise<string> {
  const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model ?? GROQ_INTENT_MODEL,
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? 768,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
    signal: input.signal,
    cache: "no-store",
  });

  if (!res.ok) {
    throw new GroqError(await readError(res), res.status, {
      retryAfterMs: parseRetryAfter(res),
    });
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new GroqError("Groq returned an empty completion.", 502);
  }
  return text;
}

export interface GroqTranscribeInput {
  audio: Blob;
  filename: string;
  signal: AbortSignal;
  model?: string;
  /** ISO-639-1 hint; skipping auto-detect shaves latency. */
  language?: string;
  /** Domain vocabulary hint (drug names, CTAS levels, MRN format). */
  prompt?: string;
}

/** Whisper transcription. Returns plain text. */
export async function groqTranscribe(
  input: GroqTranscribeInput
): Promise<string> {
  if (input.audio.size === 0) {
    throw new GroqError("Empty audio payload.", 400);
  }
  if (input.audio.size > GROQ_MAX_AUDIO_BYTES) {
    throw new GroqError(
      `Audio is ${(input.audio.size / 1024 / 1024).toFixed(1)} MB; limit is 25 MB.`,
      413
    );
  }

  const form = new FormData();
  form.append("file", input.audio, input.filename);
  form.append("model", input.model ?? GROQ_WHISPER_MODEL);
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (input.language) form.append("language", input.language);
  if (input.prompt) form.append("prompt", input.prompt);

  const res = await fetch(`${GROQ_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    /* No Content-Type header: fetch sets the multipart boundary itself. */
    headers: { Authorization: `Bearer ${requireKey()}` },
    body: form,
    signal: input.signal,
    cache: "no-store",
  });

  if (!res.ok) {
    throw new GroqError(await readError(res), res.status, {
      retryAfterMs: parseRetryAfter(res),
    });
  }

  const json = (await res.json()) as { text?: string };
  const text = json.text?.trim();
  if (!text) {
    throw new GroqError("Whisper returned an empty transcript.", 502);
  }
  return text;
}
