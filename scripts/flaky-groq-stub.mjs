/**
 * Local stand-in for Groq's OpenAI-compatible API, used to exercise the retry
 * path in lib/llm-race.ts against a real HTTP round-trip rather than a mock.
 *
 *   node scripts/flaky-groq-stub.mjs
 *   # then in .env.local:  GROQ_BASE_URL=http://127.0.0.1:8787
 *   # restart the dev server, fire a clinical command, watch the logs
 *
 * Behaviour is set by MODE:
 *   flaky      (default) first call 503 + Retry-After, then succeeds  -> expect tries: 2
 *   ratelimit  every call 429 + Retry-After: 0                        -> expect tries: 3, then Gemini
 *   dead       every call 404 (shut-down model)                       -> expect tries: 1, then Gemini
 *   slow       hangs past the 2500ms budget                           -> expect timeout, no retry
 *
 * Dev-only. Never referenced by application code.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 8787);
const MODE = process.env.MODE ?? "flaky";

let calls = 0;

const INTENT_PAYLOAD = JSON.stringify({
  intent: "roster_question",
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
  confidence: 0.9,
  needsConfirmation: false,
  clarificationQuestion: null,
  reasoningSummary: "Answered by the local flaky-groq stub.",
});

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function fail(res, status, message, retryAfter) {
  send(
    res,
    status,
    { error: { message, type: "stub_error" } },
    retryAfter === undefined ? {} : { "Retry-After": String(retryAfter) }
  );
}

const server = createServer((req, res) => {
  if (!req.url?.includes("/chat/completions")) {
    fail(res, 404, `Stub does not implement ${req.url}`);
    return;
  }

  /* Drain the request body so the client sees a clean round-trip. */
  req.resume();
  calls += 1;
  const n = calls;

  const ok = () => {
    console.log(`  call ${n}: 200 (completion returned)`);
    /* Reset so the NEXT sequence starts flaky again — otherwise the first
       curl you fire eats the 503 and the real run looks healthy. */
    calls = 0;
    send(res, 200, {
      choices: [{ message: { role: "assistant", content: INTENT_PAYLOAD } }],
    });
  };

  switch (MODE) {
    case "ratelimit":
      console.log(`  call ${n}: 429 Retry-After: 0`);
      fail(res, 429, "Rate limit reached for stub.", 0);
      return;

    case "dead":
      console.log(`  call ${n}: 404 (model shut down)`);
      fail(res, 404, "The model `stub-model` has been decommissioned.");
      return;

    case "slow":
      console.log(`  call ${n}: hanging past the latency budget`);
      setTimeout(ok, 30_000).unref();
      return;

    case "flaky":
    default:
      if (n === 1) {
        console.log(`  call ${n}: 503 Retry-After: 1`);
        fail(res, 503, "Service temporarily unavailable.", 1);
        return;
      }
      ok();
      return;
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`flaky-groq stub listening on http://127.0.0.1:${PORT}  (MODE=${MODE})`);
  console.log("Set GROQ_BASE_URL to this origin in .env.local, then restart next dev.\n");
});
