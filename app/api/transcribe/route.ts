import { NextResponse } from "next/server";

import { API_AI_RESTRICTED_MESSAGE, parseRoleFromRequest } from "@/lib/auth";
import {
  GEMINI_CLINICAL_MODEL,
  getGemini,
  isGeminiConfigured,
} from "@/lib/gemini-client";
import {
  GROQ_MAX_AUDIO_BYTES,
  GROQ_WHISPER_MODEL,
  groqTranscribe,
  isGroqConfigured,
} from "@/lib/groq-client";
import {
  FALLBACK_TIMEOUT_MS,
  PRIMARY_TIMEOUT_MS,
  runWithFallback,
} from "@/lib/llm-race";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Biases both providers toward clinical vocabulary instead of phonetic guesses. */
const CLINICAL_VOCAB_HINT =
  "Hospital voice command from a physician. Expect drug names (metoprolol, apixaban, ceftriaxone), " +
  "doses (5 mg IV q6h), CTAS acuity levels, MRN identifiers, room numbers, and patient names.";

const GEMINI_TRANSCRIBE_PROMPT = `${CLINICAL_VOCAB_HINT}
Transcribe the audio verbatim. Output only the transcript text — no commentary, labels, or timestamps.`;

const ACCEPTED_AUDIO = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-m4a|m4a|flac)/i;

async function transcribeWithGemini(
  bytes: ArrayBuffer,
  mimeType: string,
  signal: AbortSignal
): Promise<string> {
  const response = await getGemini().models.generateContent({
    model: GEMINI_CLINICAL_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType,
              data: Buffer.from(bytes).toString("base64"),
            },
          },
          { text: GEMINI_TRANSCRIBE_PROMPT },
        ],
      },
    ],
    config: {
      temperature: 0,
      maxOutputTokens: 512,
      abortSignal: signal,
    },
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error("Gemini returned an empty transcript.");
  }
  return text;
}

export async function POST(req: Request) {
  const role = parseRoleFromRequest(req);
  if (role !== "doctor") {
    return NextResponse.json(
      { error: API_AI_RESTRICTED_MESSAGE },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }

  if (!isGroqConfigured() && !isGeminiConfigured()) {
    return NextResponse.json(
      {
        error:
          "No speech provider configured. Set GROQ_API_KEY and/or GEMINI_API_KEY.",
        code: "MISSING_API_KEY",
      },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data with an 'audio' field." },
      { status: 400 }
    );
  }

  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json(
      { error: "Missing 'audio' file in form data." },
      { status: 400 }
    );
  }
  if (audio.size > GROQ_MAX_AUDIO_BYTES) {
    return NextResponse.json(
      { error: "Audio clip is too large. Keep utterances under 25 MB." },
      { status: 413 }
    );
  }

  const mimeType = audio.type || "audio/webm";
  if (!ACCEPTED_AUDIO.test(mimeType)) {
    return NextResponse.json(
      { error: `Unsupported audio type: ${mimeType}` },
      { status: 415 }
    );
  }

  /* Read once: Groq needs a Blob, Gemini needs base64 — a File stream is single-use. */
  const bytes = await audio.arrayBuffer();
  const language = (form.get("language") as string | null)?.trim() || "en";

  try {
    const race = await runWithFallback<string>(
      [
        isGroqConfigured()
          ? {
              provider: "groq-whisper",
              timeoutMs: PRIMARY_TIMEOUT_MS,
              run: (signal) =>
                groqTranscribe({
                  audio: new Blob([bytes], { type: mimeType }),
                  filename: audio.name || "utterance.webm",
                  language,
                  prompt: CLINICAL_VOCAB_HINT,
                  signal,
                }),
            }
          : null,
        isGeminiConfigured()
          ? {
              provider: "gemini",
              timeoutMs: FALLBACK_TIMEOUT_MS,
              run: (signal) => transcribeWithGemini(bytes, mimeType, signal),
            }
          : null,
      ],
      {
        signal: req.signal,
        onAttempt: (record) => {
          if (!record.ok) {
            console.warn("[TRANSCRIBE] provider demoted", record);
          }
        },
      }
    );

    return NextResponse.json(
      {
        text: race.value,
        provider: race.provider,
        model:
          race.provider === "groq-whisper"
            ? GROQ_WHISPER_MODEL
            : GEMINI_CLINICAL_MODEL,
        latencyMs: race.latencyMs,
        fallbackReason: race.fallbackReason,
        attempts: race.attempts,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Transcription failed.";
    console.error("[TRANSCRIBE] all providers failed:", message);
    return NextResponse.json(
      { error: "Speech recognition is unavailable right now.", detail: message },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export function GET() {
  return NextResponse.json(
    {
      service: "VITAL OS transcription",
      primary: isGroqConfigured() ? GROQ_WHISPER_MODEL : null,
      fallback: isGeminiConfigured() ? GEMINI_CLINICAL_MODEL : null,
      primaryTimeoutMs: PRIMARY_TIMEOUT_MS,
      fallbackTimeoutMs: FALLBACK_TIMEOUT_MS,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
