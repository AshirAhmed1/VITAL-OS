/**
 * Latency budget + dual-provider fallback tests — run with: npm run test:llm
 */

import assert from "node:assert/strict";

import {
  AllProvidersFailedError,
  LlmTimeoutError,
  PRIMARY_TIMEOUT_MS,
  runWithFallback,
  withTimeout,
} from "./llm-race";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  console.log("\nall llm-race tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
