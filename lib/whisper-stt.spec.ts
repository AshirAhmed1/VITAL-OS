/**
 * Client-side Whisper transcription contract — run with: npm run test:stt
 */

import assert from "node:assert/strict";

import {
  chooseTranscript,
  MIN_UTTERANCE_BYTES,
  pickRecorderMimeType,
  postUtterance,
  RECORDER_MIME_CANDIDATES,
  TRANSCRIBE_ENDPOINT,
  type TranscriptionOutcome,
} from "./whisper-stt";

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`  ok  ${name}`);
}

/** A clip comfortably over the minimum-size floor. */
function clip(bytes = MIN_UTTERANCE_BYTES * 4): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "audio/webm" });
}

/** Minimal fetch double that records the request it was handed. */
function stubFetch(
  status: number,
  body: unknown,
  captured?: { req?: RequestInit }
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    if (captured) captured.req = init;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

async function run() {
  console.log("whisper-stt");

  await test("mime preference starts at opus-in-webm", () => {
    assert.equal(RECORDER_MIME_CANDIDATES[0], "audio/webm;codecs=opus");
    assert.equal(
      pickRecorderMimeType(() => true),
      "audio/webm;codecs=opus"
    );
  });

  await test("mime picker falls through to what Safari admits", () => {
    assert.equal(
      pickRecorderMimeType((m) => m === "audio/mp4"),
      "audio/mp4"
    );
  });

  await test("mime picker survives a throwing isTypeSupported", () => {
    assert.equal(
      pickRecorderMimeType((m) => {
        if (m !== "audio/mp4") throw new TypeError("bad mime");
        return true;
      }),
      "audio/mp4"
    );
  });

  await test("mime picker returns null when nothing is supported", () => {
    assert.equal(
      pickRecorderMimeType(() => false),
      null
    );
  });

  await test("a clip under the size floor never leaves the browser", async () => {
    let called = 0;
    const out = await postUtterance({
      audio: new Blob([new Uint8Array(64)], { type: "audio/webm" }),
      fetchImpl: (async () => {
        called += 1;
        return {} as Response;
      }) as unknown as typeof fetch,
    });

    assert.equal(called, 0);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, "too-short");
  });

  await test("a clip under the duration floor never leaves the browser", async () => {
    let called = 0;
    const out = await postUtterance({
      audio: clip(),
      durationMs: 120,
      fetchImpl: (async () => {
        called += 1;
        return {} as Response;
      }) as unknown as typeof fetch,
    });

    assert.equal(called, 0);
    assert.equal(out.ok === false && out.reason, "too-short");
  });

  await test("no role header is sent — the route reads the DB, not the client", async () => {
    const captured: { req?: RequestInit } = {};
    await postUtterance({
      audio: clip(),
      fetchImpl: stubFetch(200, { text: "start metoprolol" }, captured),
    });

    const headers = (captured.req?.headers ?? {}) as Record<string, string>;
    /* M2 step 6: /api/transcribe resolves role from the caller's clinicians
       row. A client-set header was forgeable -- Invoke-RestMethod with
       x-vital-role: doctor reached every doctor-only route. */
    assert.equal(headers["x-vital-role"], undefined);
    /* Content-Type must be absent so the browser can set the multipart boundary. */
    assert.equal(headers["Content-Type"], undefined);
    assert.equal(captured.req?.method, "POST");
  });

  await test("a successful response surfaces provider and latency", async () => {
    const out = await postUtterance({
      audio: clip(),
      fetchImpl: stubFetch(200, {
        text: "  start metoprolol 5 mg IV  ",
        provider: "groq-whisper",
        latencyMs: 412,
        fallbackReason: null,
      }),
    });

    assert.equal(out.ok, true);
    assert.equal(out.ok === true && out.text, "start metoprolol 5 mg IV");
    assert.equal(out.ok === true && out.provider, "groq-whisper");
    assert.equal(out.ok === true && out.latencyMs, 412);
  });

  await test("HTTP statuses map to branchable reasons", async () => {
    const cases: Array<[number, string]> = [
      [403, "forbidden"],
      [503, "unconfigured"],
      [413, "too-large"],
      [415, "unsupported-audio"],
      [502, "provider"],
      [400, "provider"],
    ];

    for (const [status, reason] of cases) {
      const out = await postUtterance({
        audio: clip(),
        fetchImpl: stubFetch(status, { error: `boom ${status}` }),
      });
      assert.equal(out.ok, false);
      assert.equal(
        out.ok === false && out.reason,
        reason,
        `HTTP ${status} should map to ${reason}`
      );
    }
  });

  await test("a 200 with no text is a failure, not an empty command", async () => {
    const out = await postUtterance({
      audio: clip(),
      fetchImpl: stubFetch(200, { text: "   " }),
    });
    assert.equal(out.ok === false && out.reason, "empty");
  });

  await test("a wedged upload is abandoned at the client budget", async () => {
    const out = await postUtterance({
      audio: clip(),
      timeoutMs: 60,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError")
            )
          );
        })) as unknown as typeof fetch,
    });

    assert.equal(out.ok === false && out.reason, "timeout");
    assert.match(out.ok === false ? out.detail : "", /60ms/);
  });

  await test("a network error is a value, not a thrown exception", async () => {
    const out = await postUtterance({
      audio: clip(),
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });

    assert.equal(out.ok === false && out.reason, "network");
  });

  await test("caller abort cancels the in-flight upload", async () => {
    const controller = new AbortController();
    const pending = postUtterance({
      audio: clip(),
      signal: controller.signal,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError")
            )
          );
        })) as unknown as typeof fetch,
    });

    controller.abort();
    const out = await pending;
    assert.equal(out.ok === false && out.reason, "network");
    assert.match(out.ok === false ? out.detail : "", /cancelled/);
  });

  await test("the endpoint is the transcription route", () => {
    assert.equal(TRANSCRIBE_ENDPOINT, "/api/transcribe");
  });

  /* ------------------------- transcript arbitration ------------------------ */

  await test("Whisper wins when it answers", () => {
    const whisper: TranscriptionOutcome = {
      ok: true,
      text: "start apixaban 5 milligrams",
      provider: "groq-whisper",
      latencyMs: 300,
      fallbackReason: null,
    };
    const choice = chooseTranscript(whisper, "start a pixie band 5 milligrams");

    assert.equal(choice.source, "whisper");
    assert.equal(choice.text, "start apixaban 5 milligrams");
    assert.equal(choice.degradedReason, null);
  });

  await test("a Whisper failure demotes to the browser transcript", () => {
    const choice = chooseTranscript(
      { ok: false, reason: "timeout", detail: "No transcript within 14000ms." },
      "  discharge bed four  "
    );

    assert.equal(choice.source, "browser");
    assert.equal(choice.text, "discharge bed four");
    assert.match(choice.degradedReason ?? "", /timeout/);
  });

  await test("both empty yields no command rather than a blank submit", () => {
    const choice = chooseTranscript(
      { ok: false, reason: "network", detail: "Upload failed." },
      "   "
    );

    assert.equal(choice.source, "none");
    assert.equal(choice.text, "");
  });

  console.log("\nall whisper-stt tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
