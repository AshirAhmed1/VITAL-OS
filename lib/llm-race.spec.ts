/**
 * Latency budget + dual-provider fallback tests — run with: npm run test:llm
 */

import assert from "node:assert/strict";

import {
  AllProvidersFailedError,
  isRetryableError,
  LlmTimeoutError,
  MAX_ATTEMPTS_PER_PROVIDER,
  PRIMARY_TIMEOUT_MS,
  runWithFallback,
  withTimeout,
} from "./llm-race";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shaped like the errors we actually see in production: @google/genai's
 * ApiError carries a bare numeric `status`, and GroqError adds `retryAfterMs`.
 * Building them by hand keeps the spec free of SDK imports.
 */
function httpError(
  status: number,
  message = `HTTP ${status}`,
  retryAfterMs?: number
): Error {
  return Object.assign(new Error(message), {
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`  ok  ${name}`);
}

async function run() {
  console.log("llm-race");

  await test("primary latency budget is 2500ms", () => {
    assert.equal(PRIMARY_TIMEOUT_MS, 2500);
  });

  await test("withTimeout resolves when the call beats its budget", async () => {
    const value = await withTimeout({
      provider: "groq",
      timeoutMs: 60,
      run: async () => {
        await sleep(5);
        return "fast";
      },
    });
    assert.equal(value, "fast");
  });

  await test("withTimeout aborts the in-flight request on expiry", async () => {
    let observed: AbortSignal | null = null;
    await assert.rejects(
      withTimeout({
        provider: "groq",
        timeoutMs: 30,
        run: async (signal) => {
          observed = signal;
          await sleep(200);
          return "too-slow";
        },
      }),
      (err: unknown) =>
        err instanceof LlmTimeoutError && err.provider === "groq"
    );
    assert.ok(observed, "run() must receive an AbortSignal");
    assert.equal((observed as unknown as AbortSignal).aborted, true);
  });

  await test("slow primary falls back to the secondary provider", async () => {
    const result = await runWithFallback<string>([
      {
        provider: "groq",
        timeoutMs: 30,
        run: async () => {
          await sleep(200);
          return "groq";
        },
      },
      { provider: "gemini", timeoutMs: 200, run: async () => "gemini" },
    ]);

    assert.equal(result.value, "gemini");
    assert.equal(result.provider, "gemini");
    assert.match(result.fallbackReason ?? "", /groq timed out/);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].timedOut, true);
  });

  await test("throwing primary (malformed JSON) falls back", async () => {
    const result = await runWithFallback<string>([
      {
        provider: "groq",
        timeoutMs: 100,
        run: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
      },
      { provider: "gemini", timeoutMs: 200, run: async () => "gemini" },
    ]);

    assert.equal(result.provider, "gemini");
    assert.equal(result.attempts[0].timedOut, false);
    assert.match(result.fallbackReason ?? "", /groq failed/);
  });

  await test("healthy primary never calls the fallback", async () => {
    let fallbackCalls = 0;
    const result = await runWithFallback<string>([
      { provider: "groq", timeoutMs: 100, run: async () => "groq" },
      {
        provider: "gemini",
        timeoutMs: 100,
        run: async () => {
          fallbackCalls += 1;
          return "gemini";
        },
      },
    ]);

    assert.equal(result.provider, "groq");
    assert.equal(result.fallbackReason, null);
    assert.equal(fallbackCalls, 0);
    assert.equal(result.attempts.length, 1);
  });

  await test("unconfigured providers are skipped, not raced", async () => {
    const result = await runWithFallback<string>([
      null,
      { provider: "gemini", timeoutMs: 100, run: async () => "gemini" },
    ]);
    assert.equal(result.provider, "gemini");
    assert.equal(result.attempts.length, 1);
  });

  await test("both providers down throws AllProvidersFailedError", async () => {
    await assert.rejects(
      runWithFallback<string>([
        {
          provider: "groq",
          timeoutMs: 20,
          run: async () => {
            await sleep(100);
            return "x";
          },
        },
        {
          provider: "gemini",
          timeoutMs: 20,
          run: async () => {
            throw new Error("503 upstream");
          },
        },
      ]),
      (err: unknown) =>
        err instanceof AllProvidersFailedError && err.attempts.length === 2
    );
  });

  await test("client disconnect stops the chain immediately", async () => {
    const controller = new AbortController();
    let fallbackCalls = 0;

    const pending = runWithFallback<string>(
      [
        {
          provider: "groq",
          timeoutMs: 500,
          run: (signal) =>
            new Promise<string>((_, reject) => {
              signal.addEventListener("abort", () =>
                reject(new Error("aborted by caller"))
              );
            }),
        },
        {
          provider: "gemini",
          timeoutMs: 200,
          run: async () => {
            fallbackCalls += 1;
            return "gemini";
          },
        },
      ],
      { signal: controller.signal }
    );

    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, /aborted by caller/);
    assert.equal(fallbackCalls, 0);
  });


  /* ------------------- bounded retry on transient failures ------------------ */

  await test("retry ceiling is 3 calls per provider", () => {
    assert.equal(MAX_ATTEMPTS_PER_PROVIDER, 3);
  });

  await test("classifier: 429 and 5xx are transient, other 4xx are not", () => {
    assert.equal(isRetryableError(httpError(429)), true);
    assert.equal(isRetryableError(httpError(500)), true);
    assert.equal(isRetryableError(httpError(502)), true);
    assert.equal(isRetryableError(httpError(503)), true);
    assert.equal(isRetryableError(httpError(400)), false);
    assert.equal(isRetryableError(httpError(401)), false);
    assert.equal(isRetryableError(httpError(413)), false);
    /* The shut-down-model case: 404 is permanent, so retrying it would burn
       the whole latency budget on a certainty. */
    assert.equal(isRetryableError(httpError(404)), false);
  });

  await test("classifier: an explicit .retryable outranks the status", () => {
    const missingKey = Object.assign(new Error("GROQ_API_KEY is not set."), {
      status: 503,
      retryable: false,
    });
    assert.equal(isRetryableError(missingKey), false);
  });

  await test("classifier: undici socket resets hide under fetch failed", () => {
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      }),
    });
    assert.equal(isRetryableError(fetchFailed), true);
  });

  await test("classifier: timeouts and malformed JSON are never retried", () => {
    assert.equal(isRetryableError(new LlmTimeoutError("groq", 2500)), false);
    assert.equal(isRetryableError(new SyntaxError("Unexpected token <")), false);
  });

  await test("transient 503 is retried and the primary still wins", async () => {
    let calls = 0;
    let fallbackCalls = 0;

    const result = await runWithFallback<string>([
      {
        provider: "groq",
        timeoutMs: 1000,
        retryDelayMs: 10,
        run: async () => {
          calls += 1;
          if (calls === 1) throw httpError(503, "upstream unavailable");
          return "groq";
        },
      },
      {
        provider: "gemini",
        timeoutMs: 500,
        run: async () => {
          fallbackCalls += 1;
          return "gemini";
        },
      },
    ]);

    assert.equal(result.provider, "groq");
    assert.equal(result.fallbackReason, null);
    assert.equal(result.attempts[0].tries, 2);
    assert.equal(calls, 2);
    assert.equal(fallbackCalls, 0);
  });

  await test("permanent 401 demotes on the first failure", async () => {
    let calls = 0;
    const result = await runWithFallback<string>([
      {
        provider: "groq",
        timeoutMs: 500,
        retryDelayMs: 10,
        run: async () => {
          calls += 1;
          throw httpError(401, "Invalid API Key");
        },
      },
      { provider: "gemini", timeoutMs: 500, run: async () => "gemini" },
    ]);

    assert.equal(calls, 1);
    assert.equal(result.provider, "gemini");
    assert.equal(result.attempts[0].tries, 1);
    assert.match(result.fallbackReason ?? "", /groq failed: Invalid API Key/);
  });

  await test("a permanently rate-limited provider stops after 3 calls", async () => {
    let calls = 0;
    const result = await runWithFallback<string>([
      {
        provider: "groq",
        timeoutMs: 2000,
        retryDelayMs: 10,
        run: async () => {
          calls += 1;
          throw httpError(429, "Rate limit reached");
        },
      },
      { provider: "gemini", timeoutMs: 500, run: async () => "gemini" },
    ]);

    assert.equal(calls, MAX_ATTEMPTS_PER_PROVIDER);
    assert.equal(result.attempts[0].tries, 3);
    assert.equal(result.provider, "gemini");
    assert.match(result.fallbackReason ?? "", /groq failed after 3 tries/);
  });

  await test("maxAttempts is configurable per provider", async () => {
    let calls = 0;
    await runWithFallback<string>([
      {
        provider: "groq",
        timeoutMs: 500,
        maxAttempts: 1,
        retryDelayMs: 5,
        run: async () => {
          calls += 1;
          throw httpError(503);
        },
      },
      { provider: "gemini", timeoutMs: 300, run: async () => "gemini" },
    ]);
    assert.equal(calls, 1);
  });

  await test("retries share one deadline instead of resetting the clock", async () => {
    const budgetMs = 600;
    let calls = 0;

    const result = await runWithFallback<string>([
      {
        provider: "groq",
        timeoutMs: budgetMs,
        retryDelayMs: 10,
        run: async () => {
          calls += 1;
          /* Two quick 503s, then a hang that must be cut off by whatever is
             left of the ORIGINAL budget — not by a fresh one. */
          if (calls < 3) {
            await sleep(30);
            throw httpError(503, "upstream unavailable");
          }
          await sleep(10_000);
          return "groq";
        },
      },
      { provider: "gemini", timeoutMs: 400, run: async () => "gemini" },
    ]);

    const leg = result.attempts[0];
    assert.equal(leg.tries, 3);
    assert.equal(leg.timedOut, true);
    assert.ok(
      leg.latencyMs <= budgetMs + 150,
      `groq leg ran ${leg.latencyMs}ms against a ${budgetMs}ms budget`
    );

    /* The sharp assertion: the final try was granted the REMAINING budget,
       strictly less than the leg budget. A per-attempt timer would have
       handed it the full 600ms and made the worst case 3x the claim. */
    const granted = Number(/exceeded its (\d+)ms/.exec(leg.error ?? "")?.[1]);
    assert.ok(
      granted > 0 && granted < budgetMs,
      `final try was granted ${granted}ms, expected less than ${budgetMs}ms`
    );
  });

  await test("Retry-After that exceeds the budget demotes instead of waiting", async () => {
    let calls = 0;
    const result = await runWithFallback<string>([
      {
        provider: "groq",
        timeoutMs: 500,
        run: async () => {
          calls += 1;
          throw httpError(429, "Rate limit reached", 60_000);
        },
      },
      { provider: "gemini", timeoutMs: 300, run: async () => "gemini" },
    ]);

    assert.equal(calls, 1);
    assert.equal(result.provider, "gemini");
  });

  await test("a short Retry-After is honoured as the backoff", async () => {
    const startedAt = Date.now();
    const stamps: number[] = [];
    let calls = 0;

    await runWithFallback<string>([
      {
        provider: "groq",
        timeoutMs: 2000,
        retryDelayMs: 1,
        run: async () => {
          calls += 1;
          stamps.push(Date.now() - startedAt);
          if (calls === 1) throw httpError(429, "slow down", 120);
          return "groq";
        },
      },
    ]);

    assert.equal(calls, 2);
    assert.ok(
      stamps[1] >= 110,
      `retry fired after ${stamps[1]}ms, expected to wait ~120ms`
    );
  });

  await test("onRetry reports each demoted try, onAttempt only the leg", async () => {
    const retries: string[] = [];
    const legs: number[] = [];
    let calls = 0;

    await runWithFallback<string>(
      [
        {
          provider: "groq",
          timeoutMs: 1500,
          retryDelayMs: 10,
          run: async () => {
            calls += 1;
            if (calls < 3) throw httpError(502, "bad gateway");
            return "groq";
          },
        },
      ],
      {
        onRetry: (r) => retries.push(`${r.provider}#${r.try}`),
        onAttempt: (r) => legs.push(r.tries),
      }
    );

    assert.deepEqual(retries, ["groq#1", "groq#2"]);
    assert.deepEqual(legs, [3]);
  });

  await test("client disconnect during backoff stops the chain", async () => {
    const controller = new AbortController();
    let calls = 0;
    let fallbackCalls = 0;

    const pending = runWithFallback<string>(
      [
        {
          provider: "groq",
          timeoutMs: 1000,
          retryDelayMs: 200,
          run: async () => {
            calls += 1;
            throw httpError(503);
          },
        },
        {
          provider: "gemini",
          timeoutMs: 300,
          run: async () => {
            fallbackCalls += 1;
            return "gemini";
          },
        },
      ],
      { signal: controller.signal }
    );

    setTimeout(() => controller.abort(), 40);
    await assert.rejects(pending, /Aborted during retry backoff/);
    assert.equal(calls, 1);
    assert.equal(fallbackCalls, 0);
  });

  await test("withTimeout stays single-shot", async () => {
    let calls = 0;
    await assert.rejects(
      withTimeout({
        provider: "groq",
        timeoutMs: 100,
        run: async () => {
          calls += 1;
          throw httpError(503);
        },
      })
    );
    assert.equal(calls, 1);
  });

  console.log("\nall llm-race tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
