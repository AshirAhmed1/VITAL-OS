/**
 * Gemini-powered clinical intent parser (structured JSON only).
 * Server-side only — do not import from client components.
 */

import { Type } from "@google/genai";

import type { DemoPatient } from "@/lib/demo-patients";
import { formatRosterForPrompt, patientToSnapshot } from "@/lib/demo-patients";
import { normalizeClinicalIntent } from "@/lib/clinical-normalization";
import {
  getGemini,
  isGeminiConfigured,
  GEMINI_CLINICAL_MODEL,
} from "@/lib/gemini-client";
import { groqChatJson, isGroqConfigured } from "@/lib/groq-client";
import {
  FALLBACK_TIMEOUT_MS,
  PRIMARY_TIMEOUT_MS,
  runWithFallback,
} from "@/lib/llm-race";
import type { VitalMode } from "@/lib/vital-llm";

export const CLINICAL_INTENTS = [
  "open_patient_chart",
  "patient_summary",
  "medication_order",
  "update_problem_status",
  "discharge_patient",
  "admit_patient",
  "differential_diagnosis",
  "symptom_analysis",
  "roster_question",
  "analytics_question",
  "unknown",
] as const;

export type ClinicalIntentType = (typeof CLINICAL_INTENTS)[number];

export type IntentProvider = "groq" | "gemini";

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

export interface ParsedClinicalIntent {
  intent: ClinicalIntentType;
  patientName: string | null;
  patientId: string | null;
  medication: string | null;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  symptoms: string[];
  problem: string | null;
  status: string | null;
  requestedSections: string[];
  confidence: number;
  needsConfirmation: boolean;
  clarificationQuestion: string | null;
  reasoningSummary: string | null;
  originalTranscript: string;
  /** Which leg of the provider chain answered. */
  provider?: IntentProvider;
  /** Wall-clock time of the winning leg. */
  parseLatencyMs?: number;
  /** Null when Groq answered inside its budget; otherwise why we fell back. */
  fallbackReason?: string | null;
}

export interface ParseClinicalIntentInput {
  transcript: string;
  roster: DemoPatient[];
  activePatient?: DemoPatient | null;
  mode?: VitalMode;
  conversationHistory?: ConversationTurn[];
}

const INTENT_JSON_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      description: `One of: ${CLINICAL_INTENTS.join(", ")}`,
    },
    patientName: { type: Type.STRING, nullable: true },
    patientId: { type: Type.STRING, nullable: true },
    medication: { type: Type.STRING, nullable: true },
    dose: { type: Type.STRING, nullable: true },
    route: { type: Type.STRING, nullable: true },
    frequency: { type: Type.STRING, nullable: true },
    symptoms: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    problem: { type: Type.STRING, nullable: true },
    status: { type: Type.STRING, nullable: true },
    requestedSections: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    confidence: { type: Type.NUMBER },
    needsConfirmation: { type: Type.BOOLEAN },
    clarificationQuestion: { type: Type.STRING, nullable: true },
    reasoningSummary: { type: Type.STRING, nullable: true },
  },
  required: [
    "intent",
    "confidence",
    "needsConfirmation",
    "symptoms",
    "requestedSections",
  ],
};

const INTENT_SYSTEM_PROMPT = `You are the clinical command parser for VITAL OS — a hospital voice assistant.
Your ONLY job is to classify the clinician's latest utterance into a structured JSON intent. Do NOT write conversational replies.

Rules:
- Interpret meaning, not exact keywords. Paraphrases and colloquial drug names count (e.g. Advil/Motrin → medication ibuprofen in the medication field; the app normalizes later).
- Match patients using the roster: names (first, last, preferred), MRN, room. Use patientId from roster when confident.
- If multiple patients could match, set intent to "unknown", needsConfirmation true, confidence below 0.5, and ask a short clarificationQuestion listing options.
- medication_order: prescribing, giving, ordering, starting, or administering a drug — even polite phrasing ("can you prescribe", "put on", "order pain meds").
- open_patient_chart / patient_summary: pull up chart, show sections, summarize patient.
- differential_diagnosis / symptom_analysis: "what could this be", differential, why would patient have X, clinical reasoning about symptoms.
- discharge_patient: discharge, send home, remove from board.
- admit_patient: admit, register new patient.
- update_problem_status: mark problem active/resolved/monitoring/ruled out/pending.
- roster_question: how many patients, who is in room X, census.
- analytics_question: stats, trends, counts across roster (non-patient-specific).
- unknown: cannot determine safely.

For medication_order extract dose, route (PO/IV/etc), frequency when spoken.
Set needsConfirmation true for medication_order and discharge_patient.
requestedSections: use lowercase keys like overview, medications, allergies, vitals, labs, diagnoses, notes, plan.

Return JSON only.`;

function buildUserPrompt(input: ParseClinicalIntentInput): string {
  const rosterBlock = formatRosterForPrompt(input.roster);
  const activeBlock = input.activePatient
    ? `\nACTIVE PATIENT (UI focus):\n${patientToSnapshot(input.activePatient)}\n`
    : "";
  const history = (input.conversationHistory ?? [])
    .slice(-12)
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join("\n");
  const historyBlock = history
    ? `\nCONVERSATION HISTORY (context only):\n${history}\n`
    : "";
  return `MODE: ${input.mode ?? "general"}
${historyBlock}
ROSTER:
${rosterBlock}
${activeBlock}
LATEST CLINICIAN UTTERANCE:
"""${input.transcript.trim()}"""

Classify this utterance.`;
}

function coerceIntent(raw: string | undefined): ClinicalIntentType {
  const v = (raw ?? "unknown").trim().toLowerCase();
  return (CLINICAL_INTENTS as readonly string[]).includes(v)
    ? (v as ClinicalIntentType)
    : "unknown";
}

function parseIntentJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1]?.trim() ?? trimmed;
  return JSON.parse(body) as Record<string, unknown>;
}

function toParsedIntent(
  raw: Record<string, unknown>,
  transcript: string
): ParsedClinicalIntent {
  const symptoms = Array.isArray(raw.symptoms)
    ? raw.symptoms.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const requestedSections = Array.isArray(raw.requestedSections)
    ? raw.requestedSections.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : [];

  let confidence =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? raw.confidence
      : 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  const intent = coerceIntent(
    typeof raw.intent === "string" ? raw.intent : undefined
  );

  return normalizeClinicalIntent({
    intent,
    patientName:
      typeof raw.patientName === "string" ? raw.patientName.trim() || null : null,
    patientId:
      typeof raw.patientId === "string" ? raw.patientId.trim() || null : null,
    medication:
      typeof raw.medication === "string" ? raw.medication.trim() || null : null,
    dose: typeof raw.dose === "string" ? raw.dose.trim() || null : null,
    route: typeof raw.route === "string" ? raw.route.trim() || null : null,
    frequency:
      typeof raw.frequency === "string" ? raw.frequency.trim() || null : null,
    symptoms,
    problem:
      typeof raw.problem === "string" ? raw.problem.trim() || null : null,
    status: typeof raw.status === "string" ? raw.status.trim() || null : null,
    requestedSections,
    confidence,
    needsConfirmation: Boolean(raw.needsConfirmation),
    clarificationQuestion:
      typeof raw.clarificationQuestion === "string"
        ? raw.clarificationQuestion.trim() || null
        : null,
    reasoningSummary:
      typeof raw.reasoningSummary === "string"
        ? raw.reasoningSummary.trim() || null
        : null,
    originalTranscript: transcript,
  });
}

/* -------------------------------------------------------------------------
 * Provider legs — Groq primary (latency), Gemini fallback (reliability).
 * Each leg parses and shape-checks its own output, so malformed JSON from one
 * provider demotes it to the next instead of reaching the clinician.
 * ---------------------------------------------------------------------- */

/** Groq has no server-side schema binding, so the contract lives in the prompt. */
const GROQ_JSON_CONTRACT = `Respond with a single JSON object, no prose and no markdown fences, using exactly these keys:
{
  "intent": one of ${CLINICAL_INTENTS.join(" | ")},
  "patientName": string or null,
  "patientId": string or null,
  "medication": string or null,
  "dose": string or null,
  "route": string or null,
  "frequency": string or null,
  "symptoms": array of strings,
  "problem": string or null,
  "status": string or null,
  "requestedSections": array of lowercase strings,
  "confidence": number between 0 and 1,
  "needsConfirmation": boolean,
  "clarificationQuestion": string or null,
  "reasoningSummary": string or null
}`;

function assertIntentShape(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Model returned a non-object intent payload.");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.intent !== "string" || !obj.intent.trim()) {
    throw new Error("Model intent payload is missing 'intent'.");
  }
  if (obj.confidence !== undefined && typeof obj.confidence !== "number") {
    throw new Error("Model intent payload has a non-numeric 'confidence'.");
  }
  return obj;
}

async function parseIntentWithGroq(
  input: ParseClinicalIntentInput,
  signal: AbortSignal
): Promise<ParsedClinicalIntent> {
  const text = await groqChatJson({
    system: `${INTENT_SYSTEM_PROMPT}\n\n${GROQ_JSON_CONTRACT}`,
    user: buildUserPrompt(input),
    signal,
    temperature: 0.2,
    maxTokens: 768,
  });
  return toParsedIntent(
    assertIntentShape(parseIntentJson(text)),
    input.transcript.trim()
  );
}

async function parseIntentWithGemini(
  input: ParseClinicalIntentInput,
  signal: AbortSignal
): Promise<ParsedClinicalIntent> {
  const response = await getGemini().models.generateContent({
    model: GEMINI_CLINICAL_MODEL,
    contents: buildUserPrompt(input),
    config: {
      systemInstruction: INTENT_SYSTEM_PROMPT,
      temperature: 0.2,
      maxOutputTokens: 768,
      responseMimeType: "application/json",
      responseJsonSchema: INTENT_JSON_SCHEMA,
      abortSignal: signal,
    },
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error("Gemini returned an empty intent parse.");
  }
  return toParsedIntent(
    assertIntentShape(parseIntentJson(text)),
    input.transcript.trim()
  );
}

/** Safe terminal state: ask rather than act on an intent we could not parse. */
function unknownIntent(
  transcript: string,
  reason: string
): ParsedClinicalIntent {
  return normalizeClinicalIntent({
    intent: "unknown",
    patientName: null,
    patientId: null,
    medication: null,
    dose: null,
    route: null,
    frequency: null,
    symptoms: [],
    problem: null,
    status: null,
    requestedSections: [],
    confidence: 0,
    needsConfirmation: false,
    clarificationQuestion:
      "I did not catch that clearly. Could you say it again?",
    reasoningSummary: reason,
    originalTranscript: transcript,
    fallbackReason: reason,
  });
}

/**
 * Transcript -> structured clinical intent.
 * Groq answers inside 2500ms or it is cancelled and Gemini takes the turn.
 */
export async function parseClinicalIntent(
  input: ParseClinicalIntentInput,
  opts?: { signal?: AbortSignal }
): Promise<ParsedClinicalIntent> {
  const transcript = input.transcript?.trim();
  if (!transcript) {
    throw new Error("Empty transcript.");
  }

  try {
    const race = await runWithFallback<ParsedClinicalIntent>(
      [
        isGroqConfigured()
          ? {
              provider: "groq",
              timeoutMs: PRIMARY_TIMEOUT_MS,
              run: (signal) => parseIntentWithGroq(input, signal),
            }
          : null,
        isGeminiConfigured()
          ? {
              provider: "gemini",
              timeoutMs: FALLBACK_TIMEOUT_MS,
              run: (signal) => parseIntentWithGemini(input, signal),
            }
          : null,
      ],
      {
        signal: opts?.signal,
        onAttempt: (record) => {
          if (!record.ok) {
            console.warn("[INTENT PARSE] provider demoted", record);
          }
        },
        onRetry: (record) => {
          console.warn("[INTENT PARSE] transient failure, retrying", record);
        },
      }
    );

    return {
      ...race.value,
      provider: race.provider as IntentProvider,
      parseLatencyMs: race.latencyMs,
      fallbackReason: race.fallbackReason,
    };
  } catch (err) {
    /* Caller hung up — propagate instead of pretending we parsed something. */
    if (opts?.signal?.aborted) throw err;

    const message =
      err instanceof Error ? err.message : "Intent parsing failed.";
    console.error("[INTENT PARSE] all providers failed:", message);
    return unknownIntent(transcript, message);
  }
}
