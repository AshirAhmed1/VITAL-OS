/**
 * VITAL OS — provider race, latency budget, retry, and fallback primitives.
 *
 * Every model call on the voice path goes through here so that:
 *  1. no single provider can hold the clinician's mic hostage past its budget,
 *  2. a *transient* failure (429/5xx/socket reset) is retried inside that same
 *     budget before we give up on the provider,
 *  3. a timeout, hard error, or malformed payload demotes that provider
 *     and promotes the next one in the chain,
 *  4. the route can report which provider answered, after how many tries, and why.
 *
 * Server-side only.
 */

/** Latency budget for the primary (Groq) leg of the voice path. */
export const PRIMARY_TIMEOUT_MS = 2500;

/** Fallback legs get a longer budget: correctness beats speed once we are late. */
export const FALLBACK_TIMEOUT_MS = 8000;

/** Hard ceiling on calls to one provider per invocation, including the first. */
export const MAX_ATTEMPTS_PER_PROVIDER = 3;

/** First backoff step. Doubles per retry, then jitters. */
export const RETRY_BASE_DELAY_MS = 150;

/** Backoff never grows past this — the whole leg is on a 2.5s budget. */
export const RETRY_MAX_DELAY_MS = 1000;

/**
 * A retry is only worth starting if this much of the leg's budget survives the
 * backoff. Below it, demoting to the next provider is the better bet.
 */
export const MIN_RETRY_BUDGET_MS = 300;

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
  /**
   * Budget for this provider *in total*, retries and backoff included.
   * Defaults to PRIMARY_TIMEOUT_MS.
   */
  timeoutMs?: number;
  /** Calls to this provider, first attempt included. Defaults to MAX_ATTEMPTS_PER_PROVIDER. */
  maxAttempts?: number;
  /** Override the transient/permanent classifier for providers with odd error shapes. */
  isRetryable?: (err: unknown) => boolean;
  /** Fixed backoff instead of exponential+jitter. Mainly for tests. */
  retryDelayMs?: number;
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
  /** Wall clock for the whole leg: every try plus the backoff between them. */
  latencyMs: number;
  timedOut: boolean;
  error: string | null;
  /** Calls actually made to this provider. 1 means it was never retried. */
  tries: number;
};

export type LlmRetryRecord = {
  provider: string;
  /** Which try just failed (1 = the first call). */
  try: number;
  /** Backoff before the next try. */
  delayMs: number;
  /** Budget left on this leg when the retry was scheduled. */
  remainingMs: number;
  error: string;
};

export type LlmRaceResult<T> = {
  value: T;
  /** Provider that actually produced the value. */
  provider: string;
  /** Wall-clock time of the winning leg, retries included. */
  latencyMs: number;
  /** Null when the primary answered; otherwise why we fell back. */
  fallbackReason: string | null;
  attempts: LlmAttemptRecord[];
};

/* -------------------------------------------------------------------------
 * Transient vs permanent
 *
 * Duck-typed on purpose: GroqError carries `.retryable`, @google/genai's
 * ApiError carries `.status`, and undici hides socket codes under `.cause`.
 * Sniffing the shape keeps this module free of SDK imports, so CareerPilot's
 * LLM wrapper can lift the file as-is.
 * ---------------------------------------------------------------------- */

/** 429 is backpressure; 5xx and 408/425 are upstream hiccups. Everything else is our fault. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Socket-level failures from undici/node — the request never reached the model. */
const RETRYABLE_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function errorName(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : "";
}

/** True for an AbortSignal cancellation, whoever raised it. */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return errorName(err) === "AbortError" || code === "ABORT_ERR" || code === 20;
}

function numericStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const candidate =
    (err as { status?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

/** Walks the `cause` chain — undici hides ECONNRESET under `TypeError: fetch failed`. */
function transportCode(err: unknown, depth = 0): string | null {
  if (!err || typeof err !== "object" || depth > 3) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_TRANSPORT_CODES.has(code)) {
    return code;
  }
  return transportCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * Server-supplied backoff, in ms. Reads an explicit `retryAfterMs` (GroqError
 * parses the Retry-After header into it) so we honour 429 backpressure instead
 * of guessing at it.
 */
export function retryAfterHintMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const hint = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof hint === "number" && Number.isFinite(hint) && hint >= 0
    ? hint
    : null;
}

/**
 * Is another identical call plausibly going to succeed?
 *
 * Deliberately conservative — anything unrecognised demotes rather than
 * retries, because the fallback provider is a cheaper bet than repeating a
 * call we do not understand. Two cases are load-bearing:
 *
 *  - A 404 from a shut-down model ID (as with gemini-2.0-flash) is permanent.
 *    Retrying it would burn the whole latency budget on a certainty.
 *  - Malformed JSON demotes rather than re-rolls: a provider that just emitted
 *    an unparseable payload is a worse bet than the one with schema binding.
 */
export function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  /* The budget is already spent; a retry has nothing to spend. */
  if (err instanceof LlmTimeoutError) return false;
  /* Caller hung up. Nobody is waiting for the answer. */
  if (isAbortError(err)) return false;

  /* A provider client that classified its own error outranks our sniffing. */
  const declared = (err as { retryable?: unknown }).retryable;
  if (typeof declared === "boolean") return declared;

  const status = numericStatus(err);
  if (status !== null) return RETRYABLE_STATUS.has(status);

  if (transportCode(err)) return true;

  return false;
}

/* ---------------------------------------------------------------------- */

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

/** Backoff that gives up the instant the caller disconnects. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted during retry backoff.", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted during retry backoff.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Exponential backoff with half jitter, unless the server told us how long to
 * wait. Half rather than full jitter keeps a floor under the delay, so retries
 * cannot collapse back onto the same millisecond.
 */
function backoffDelayMs<T>(
  attempt: LlmAttempt<T>,
  failedTry: number,
  err: unknown
): number {
  const hinted = retryAfterHintMs(err);
  if (hinted !== null) return hinted;
  if (typeof attempt.retryDelayMs === "number") return attempt.retryDelayMs;

  const exponential = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** (failedTry - 1),
    RETRY_MAX_DELAY_MS
  );
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}

/** One call, raced against the budget it was handed. */
async function runOnce<T>(
  attempt: LlmAttempt<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<T> {
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
 * Races a single provider call against its latency budget.
 * On timeout the underlying request is aborted and LlmTimeoutError is thrown.
 * Single-shot: retries live in runWithFallback, not here.
 */
export async function withTimeout<T>(
  attempt: LlmAttempt<T>,
  externalSignal?: AbortSignal
): Promise<T> {
  return runOnce(
    attempt,
    attempt.timeoutMs ?? PRIMARY_TIMEOUT_MS,
    externalSignal
  );
}

type LegOutcome<T> =
  | { ok: true; value: T; tries: number }
  | { ok: false; error: unknown; tries: number };

/**
 * One provider, up to `maxAttempts` calls, all sharing a single deadline.
 *
 * The shared deadline is the whole point. Giving each retry a fresh
 * `timeoutMs` would turn a 2500ms primary leg into a 7500ms one and quietly
 * void the latency budget the voice path is built on. Instead every try gets
 * whatever is left, and a retry is only scheduled when the backoff plus a
 * usable remainder still fit inside the original budget.
 *
 * Throws only when the *caller* aborts; provider failures come back as
 * `{ ok: false }` so the chain can move on.
 */
async function runLeg<T>(
  attempt: LlmAttempt<T>,
  opts?: {
    signal?: AbortSignal;
    onRetry?: (record: LlmRetryRecord) => void;
  }
): Promise<LegOutcome<T>> {
  const budgetMs = attempt.timeoutMs ?? PRIMARY_TIMEOUT_MS;
  const maxTries = Math.max(1, attempt.maxAttempts ?? MAX_ATTEMPTS_PER_PROVIDER);
  const classify = attempt.isRetryable ?? isRetryableError;
  const deadline = Date.now() + budgetMs;

  let tries = 0;

  for (;;) {
    tries += 1;
    const remaining = Math.max(deadline - Date.now(), 1);

    try {
      const value = await runOnce(attempt, remaining, opts?.signal);
      return { ok: true, value, tries };
    } catch (err) {
      /* Caller hung up: stop burning tokens on a response nobody will read. */
      if (opts?.signal?.aborted) throw err;

      if (tries >= maxTries) return { ok: false, error: err, tries };
      if (!classify(err)) return { ok: false, error: err, tries };

      const left = deadline - Date.now();
      const delayMs = backoffDelayMs(attempt, tries, err);
      /* Not enough budget left for the backoff plus a real attempt — the next
         provider is a better use of the milliseconds that remain. */
      if (left - delayMs < MIN_RETRY_BUDGET_MS) {
        return { ok: false, error: err, tries };
      }

      opts?.onRetry?.({
        provider: attempt.provider,
        try: tries,
        delayMs,
        remainingMs: left,
        error: err instanceof Error ? err.message : String(err),
      });

      await sleep(delayMs, opts?.signal);
    }
  }
}

/**
 * Walks the provider chain in order until one returns a value inside its budget.
 * Ordering is the caller's policy decision (e.g. Groq first for latency,
 * Gemini second for reliability). Each provider gets its own bounded retry loop
 * before it is demoted.
 */
export async function runWithFallback<T>(
  attempts: Array<LlmAttempt<T> | null | undefined>,
  opts?: {
    signal?: AbortSignal;
    onAttempt?: (record: LlmAttemptRecord) => void;
    onRetry?: (record: LlmRetryRecord) => void;
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
    const outcome = await runLeg(attempt, {
      signal: opts?.signal,
      onRetry: opts?.onRetry,
    });

    if (outcome.ok) {
      const record: LlmAttemptRecord = {
        provider: attempt.provider,
        ok: true,
        latencyMs: Date.now() - startedAt,
        timedOut: false,
        error: null,
        tries: outcome.tries,
      };
      records.push(record);
      opts?.onAttempt?.(record);

      return {
        value: outcome.value,
        provider: attempt.provider,
        latencyMs: record.latencyMs,
        fallbackReason,
        attempts: records,
      };
    }

    const err = outcome.error;
    const timedOut = err instanceof LlmTimeoutError;
    const message =
      err instanceof Error ? err.message : String(err ?? "Unknown error");
    const record: LlmAttemptRecord = {
      provider: attempt.provider,
      ok: false,
      latencyMs: Date.now() - startedAt,
      timedOut,
      error: message,
      tries: outcome.tries,
    };
    records.push(record);
    opts?.onAttempt?.(record);

    const triesNote = outcome.tries > 1 ? ` after ${outcome.tries} tries` : "";
    fallbackReason = `${attempt.provider} ${
      timedOut ? "timed out" : "failed"
    }${triesNote}: ${message}`;
  }

  throw new AllProvidersFailedError(records);
}
