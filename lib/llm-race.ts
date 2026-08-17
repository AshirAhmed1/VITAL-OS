/**
 * VITAL OS — provider race, latency budget, and fallback primitives.
 *
 * Every model call on the voice path goes through here so that:
 *  1. no single provider can hold the clinician's mic hostage past its budget,
 *  2. a timeout, transport error, or malformed payload demotes that provider
 *     and promotes the next one in the chain,
 *  3. the route can report which provider actually answered and why.
 *
 * Server-side only.
 */

/** Latency budget for the primary (Groq) leg of the voice path. */
export const PRIMARY_TIMEOUT_MS = 2500;

/** Fallback legs get a longer budget: correctness beats speed once we are late. */
export const FALLBACK_TIMEOUT_MS = 8000;

export class LlmTimeoutError extends Error {
  readonly provider: string;
  readonly timeoutMs: number;

  constructor(provider: string, timeoutMs: number) {
    super(`${provider} exceeded its ${timeoutMs}ms latency budget.`);
    this.name = "LlmTimeoutError";
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

export class AllProvidersFailedError extends Error {
  readonly attempts: LlmAttemptRecord[];

  constructor(attempts: LlmAttemptRecord[]) {
    const detail = attempts
      .map((a) => `${a.provider}: ${a.error ?? "unknown error"}`)
      .join(" | ");
    super(`All model providers failed. ${detail}`);
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
  }
}

export type LlmAttempt<T> = {
  /** Stable id used in logs and in the API response, e.g. "groq" | "gemini". */
  provider: string;
  /** Per-leg latency budget. Defaults to PRIMARY_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * The actual call. MUST forward `signal` to fetch/SDK so an expired budget
   * cancels the in-flight request instead of leaking a socket.
   * Throwing (including on malformed JSON) demotes this provider.
   */
  run: (signal: AbortSignal) => Promise<T>;
};

export type LlmAttemptRecord = {
  provider: string;
  ok: boolean;
  latencyMs: number;
  timedOut: boolean;
  error: string | null;
};

export type LlmRaceResult<T> = {
  value: T;
  /** Provider that actually produced the value. */
  provider: string;
  /** Wall-clock time of the winning leg only. */
  latencyMs: number;
  /** Null when the primary answered; otherwise why we fell back. */
  fallbackReason: string | null;
  attempts: LlmAttemptRecord[];
};

/** Mirrors an external abort (client disconnect, route timeout) onto our controller. */
function linkAbort(
  external: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}

/**
 * Races a single provider call against its latency budget.
 * On timeout the underlying request is aborted and LlmTimeoutError is thrown.
 */
export async function withTimeout<T>(
  attempt: LlmAttempt<T>,
  externalSignal?: AbortSignal
): Promise<T> {
  const timeoutMs = attempt.timeoutMs ?? PRIMARY_TIMEOUT_MS;
  const controller = new AbortController();
  const unlink = linkAbort(externalSignal, controller);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LlmTimeoutError(attempt.provider, timeoutMs));
    }, timeoutMs);
  });

  const task = attempt.run(controller.signal);
  /* The losing leg may reject after the race settles — swallow it so it never
     surfaces as an unhandled rejection and kills the serverless invocation. */
  void task.catch(() => {});

  try {
    return await Promise.race([task, budget]);
  } finally {
    if (timer) clearTimeout(timer);
    unlink();
  }
}

/**
 * Walks the provider chain in order until one returns a value inside its budget.
 * Ordering is the caller's policy decision (e.g. Groq first for latency,
 * Gemini second for reliability).
 */
export async function runWithFallback<T>(
  attempts: Array<LlmAttempt<T> | null | undefined>,
  opts?: {
    signal?: AbortSignal;
    onAttempt?: (record: LlmAttemptRecord) => void;
  }
): Promise<LlmRaceResult<T>> {
  const chain = attempts.filter(
    (a): a is LlmAttempt<T> => Boolean(a) && typeof a!.run === "function"
  );

  if (!chain.length) {
    throw new Error(
      "runWithFallback: no providers configured. Check GROQ_API_KEY / GEMINI_API_KEY."
    );
  }

  const records: LlmAttemptRecord[] = [];
  let fallbackReason: string | null = null;

  for (const attempt of chain) {
    const startedAt = Date.now();
    try {
      const value = await withTimeout(attempt, opts?.signal);
      const record: LlmAttemptRecord = {
        provider: attempt.provider,
        ok: true,
        latencyMs: Date.now() - startedAt,
        timedOut: false,
        error: null,
      };
      records.push(record);
      opts?.onAttempt?.(record);

      return {
        value,
        provider: attempt.provider,
        latencyMs: record.latencyMs,
        fallbackReason,
        attempts: records,
      };
    } catch (err) {
      /* Caller hung up: stop burning tokens on a response nobody will read. */
      if (opts?.signal?.aborted) throw err;

      const timedOut = err instanceof LlmTimeoutError;
      const message =
        err instanceof Error ? err.message : String(err ?? "Unknown error");
      const record: LlmAttemptRecord = {
        provider: attempt.provider,
        ok: false,
        latencyMs: Date.now() - startedAt,
        timedOut,
        error: message,
      };
      records.push(record);
      opts?.onAttempt?.(record);

      fallbackReason = `${attempt.provider} ${
        timedOut ? "timed out" : "failed"
      }: ${message}`;
    }
  }

  throw new AllProvidersFailedError(records);
}
