/**
 * Server-side Gemini client (fallback inference leg).
 * Do not import from client components.
 */

import { GoogleGenAI } from "@google/genai";

let client: GoogleGenAI | null = null;

/** Lets the provider chain skip Gemini instead of racing a guaranteed 401. */
export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

/**
 * Lazy singleton. A missing key must fail the request, not the module import —
 * an import-time throw takes down every route in the bundle, including the ones
 * that could still be served by Groq.
 */
export function getGemini(): GoogleGenAI {
  if (client) return client;

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    const err = new Error(
      "Missing GEMINI_API_KEY environment variable"
    ) as Error & { code?: string };
    err.code = "MISSING_API_KEY";
    throw err;
  }

  client = new GoogleGenAI({ apiKey });
  return client;
}

export const GEMINI_CLINICAL_MODEL =
  process.env.GEMINI_CLINICAL_MODEL?.trim() || "gemini-3.5-flash";
