"use client";

/**
 * VITAL OS — STT diagnostic bench.  Route: /dev/stt-check
 *
 * Exists to answer one question before Whisper is wired into the live voice
 * loop: can SpeechRecognition and MediaRecorder hold the microphone at the
 * same time in this browser, on this machine, with this headset?
 *
 * Chrome's SR uses its own internal capture path and does not always share the
 * device cleanly with a getUserMedia consumer. That is not something unit tests
 * can tell us, so this page runs the three cases side by side and reports what
 * actually happened.
 *
 * Dev-only: returns 404 in production. Delete once the wiring is verified.
 */

import * as React from "react";
import { notFound } from "next/navigation";

import { useAuth } from "@/components/auth-provider";
import {
  chooseTranscript,
  pickRecorderMimeType,
  postUtterance,
  type TranscriptionOutcome,
} from "@/lib/whisper-stt";

/* Minimal SpeechRecognition typing — mirrors components/vital-os-client.tsx. */
interface SRAlt {
  transcript: string;
  confidence: number;
}
interface SRResult {
  0: SRAlt;
  isFinal: boolean;
  length: number;
}
interface SREvent {
  results: ArrayLike<SRResult> & { [k: number]: SRResult };
  resultIndex: number;
}
interface SRErrorEvent {
  error: string;
  message?: string;
}
interface SR {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SREvent) => void) | null;
  onerror: ((ev: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SRCtor = new () => SR;

type Mode = "recorder" | "recognition" | "both";

type LogLine = { at: number; tag: string; text: string };

const MODE_LABEL: Record<Mode, string> = {
  recorder: "A — MediaRecorder only",
  recognition: "B — SpeechRecognition only",
  both: "C — BOTH at once (the conflict test)",
};

export default function SttCheckPage() {
  /* Guard lives in a hook-free wrapper: an early return above hooks would be a
     rules-of-hooks violation even though NODE_ENV is fixed at build time. */
  if (process.env.NODE_ENV === "production") notFound();
  return <SttBench />;
}

function SttBench() {
  const { role: authRole } = useAuth();

  const [mode, setMode] = React.useState<Mode>("both");
  const [role, setRole] = React.useState<string>("doctor");
  const [running, setRunning] = React.useState(false);
  const [log, setLog] = React.useState<LogLine[]>([]);
  const [srInterim, setSrInterim] = React.useState("");
  const [srFinal, setSrFinal] = React.useState("");
  const [whisper, setWhisper] = React.useState<TranscriptionOutcome | null>(null);
  const [env, setEnv] = React.useState<string[]>([]);

  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const srRef = React.useRef<SR | null>(null);
  const startedAtRef = React.useRef(0);
  const mimeRef = React.useRef("audio/webm");
  const srResultCountRef = React.useRef(0);

  const push = React.useCallback((tag: string, text: string) => {
    setLog((prev) => [...prev, { at: Date.now(), tag, text }]);
  }, []);

  React.useEffect(() => {
    if (authRole) setRole(authRole);
  }, [authRole]);

  /* Environment probe — runs once on mount, client-side only. */
  React.useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: SRCtor;
      webkitSpeechRecognition?: SRCtor;
    };
    const mime =
      typeof MediaRecorder === "undefined"
        ? null
        : pickRecorderMimeType((m) => MediaRecorder.isTypeSupported(m));
    if (mime) mimeRef.current = mime;

    setEnv([
      `secure context: ${window.isSecureContext}`,
      `MediaRecorder: ${typeof MediaRecorder !== "undefined"}`,
      `getUserMedia: ${Boolean(navigator?.mediaDevices?.getUserMedia)}`,
      `chosen mime: ${mime ?? "NONE — recorder unavailable"}`,
      `SpeechRecognition: ${Boolean(
        w.SpeechRecognition ?? w.webkitSpeechRecognition
      )}`,
      `userAgent: ${navigator.userAgent}`,
    ]);
  }, []);

  const stopAll = React.useCallback(() => {
    try {
      srRef.current?.abort();
    } catch {
      /* noop */
    }
    srRef.current = null;
    try {
      if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
    } catch {
      /* noop */
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  React.useEffect(() => stopAll, [stopAll]);

  const start = React.useCallback(async () => {
    setLog([]);
    setSrInterim("");
    setSrFinal("");
    setWhisper(null);
    srResultCountRef.current = 0;
    chunksRef.current = [];
    setRunning(true);
    startedAtRef.current = Date.now();

    /* Order matters. SR is started FIRST so that if the recorder's
       getUserMedia steals the device, we see SR die rather than the reverse —
       which is the exact failure the live loop would hit. */
    if (mode === "recognition" || mode === "both") {
      const w = window as unknown as {
        SpeechRecognition?: SRCtor;
        webkitSpeechRecognition?: SRCtor;
      };
      const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
      if (!Ctor) {
        push("SR", "unavailable in this browser");
      } else {
        const rec = new Ctor();
        rec.lang = "en-US";
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.onstart = () => push("SR", "onstart");
        rec.onresult = (ev) => {
          srResultCountRef.current += 1;
          let interim = "";
          let finalDelta = "";
          for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
            const r = ev.results[i];
            if (r.isFinal) finalDelta += r[0].transcript;
            else interim += r[0].transcript;
          }
          if (finalDelta) {
            setSrFinal((p) => (p ? `${p} ${finalDelta.trim()}` : finalDelta.trim()));
            push("SR", `final: ${finalDelta.trim()}`);
          }
          setSrInterim(interim);
        };
        rec.onerror = (ev) => push("SR", `ERROR ${ev.error}`);
        rec.onend = () => push("SR", "onend");
        try {
          rec.start();
          srRef.current = rec;
        } catch (err) {
          push("SR", `start threw: ${(err as Error).message}`);
        }
      }
    }

    if (mode === "recorder" || mode === "both") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;
        push(
          "REC",
          `getUserMedia ok — track: ${stream.getAudioTracks()[0]?.label ?? "unlabelled"}`
        );

        const recorder = new MediaRecorder(stream, {
          mimeType: mimeRef.current,
        });
        recorder.ondataavailable = (ev) => {
          if (ev.data?.size) chunksRef.current.push(ev.data);
        };
        recorder.onstart = () => push("REC", "recording");
        recorder.onerror = () => push("REC", "recorder error");
        recorder.start(500);
        recorderRef.current = recorder;
      } catch (err) {
        push("REC", `getUserMedia FAILED: ${(err as Error).name}`);
      }
    }
  }, [mode, push]);

  const stopAndTranscribe = React.useCallback(async () => {
    const durationMs = Date.now() - startedAtRef.current;
    push("—", `stopping after ${durationMs}ms`);

    try {
      srRef.current?.stop();
    } catch {
      /* noop */
    }

    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        const guard = setTimeout(resolve, 1500);
        recorder.onstop = () => {
          clearTimeout(guard);
          resolve();
        };
        try {
          recorder.stop();
        } catch {
          clearTimeout(guard);
          resolve();
        }
      });
    }

    push(
      "—",
      `SR fired ${srResultCountRef.current} result events; recorder produced ${chunksRef.current.length} chunks`
    );

    if (chunksRef.current.length) {
      const blob = new Blob(chunksRef.current, { type: mimeRef.current });
      push("REC", `blob: ${blob.size} bytes, ${blob.type}`);

      const startedUpload = Date.now();
      const outcome = await postUtterance({
        audio: blob,
        role,
        durationMs,
        filename: mimeRef.current.includes("mp4")
          ? "utterance.mp4"
          : "utterance.webm",
      });
      setWhisper(outcome);
      push(
        "API",
        outcome.ok
          ? `ok via ${outcome.provider} in ${outcome.latencyMs}ms (round trip ${
              Date.now() - startedUpload
            }ms)`
          : `FAILED ${outcome.reason}: ${outcome.detail}`
      );
    }

    stopAll();
    setRunning(false);
  }, [push, role, stopAll]);

  const verdict = React.useMemo(() => {
    if (mode !== "both" || running || !log.length) return null;
    const srWorked = srResultCountRef.current > 0;
    const recWorked = whisper !== null;
    if (srWorked && recWorked) {
      return {
        tone: "ok" as const,
        text: "Both held the mic. SR produced results while MediaRecorder was capturing — the hybrid wiring is safe on this machine.",
      };
    }
    if (!srWorked && recWorked) {
      return {
        tone: "bad" as const,
        text: "MediaRecorder starved SpeechRecognition. The hybrid design will not work here — endpointing would have to move to an energy-based VAD.",
      };
    }
    if (srWorked && !recWorked) {
      return {
        tone: "bad" as const,
        text: "SpeechRecognition blocked the recorder. Whisper cannot run alongside SR on this machine.",
      };
    }
    return { tone: "bad" as const, text: "Neither path produced anything — check mic permissions." };
  }, [log.length, mode, running, whisper]);

  const choice =
    whisper !== null ? chooseTranscript(whisper, srFinal) : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 font-sans">
      <h1 className="text-xl font-semibold">STT diagnostic bench</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Verifies the Whisper round trip and whether SpeechRecognition and
        MediaRecorder can share the microphone. Dev-only.
      </p>

      <section className="mt-6 rounded-lg border border-border p-4">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
          Environment
        </h2>
        <ul className="mt-2 space-y-1 font-mono text-xs">
          {env.map((line) => (
            <li key={line} className="break-all">
              {line}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-4 flex flex-wrap items-center gap-3">
        <select
          className="rounded border border-border bg-background px-2 py-1 text-sm"
          value={mode}
          disabled={running}
          onChange={(e) => setMode(e.target.value as Mode)}
        >
          {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </select>

        <select
          className="rounded border border-border bg-background px-2 py-1 text-sm"
          value={role}
          disabled={running}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="doctor">x-vital-role: doctor</option>
          <option value="staff">x-vital-role: staff (expect 403)</option>
        </select>

        {!running ? (
          <button
            className="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground"
            onClick={() => void start()}
          >
            Start
          </button>
        ) : (
          <button
            className="rounded bg-destructive px-4 py-1.5 text-sm text-destructive-foreground"
            onClick={() => void stopAndTranscribe()}
          >
            Stop &amp; transcribe
          </button>
        )}
      </section>

      <p className="mt-3 text-xs text-muted-foreground">
        Say something with clinical vocabulary — &ldquo;start apixaban five
        milligrams twice daily for the patient in bed four&rdquo; — so the two
        transcripts can be compared on drug names, which is the whole reason for
        routing through Whisper.
      </p>

      {verdict && (
        <div
          className={`mt-4 rounded-lg border p-3 text-sm ${
            verdict.tone === "ok"
              ? "border-clinical-teal/40 text-clinical-teal"
              : "border-destructive/40 text-destructive"
          }`}
        >
          <strong>Verdict:</strong> {verdict.text}
        </div>
      )}

      <section className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-border p-4">
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
            Browser SpeechRecognition
          </h2>
          <p className="mt-2 text-sm">{srFinal || "—"}</p>
          <p className="mt-1 text-sm italic text-muted-foreground">
            {srInterim}
          </p>
        </div>

        <div className="rounded-lg border border-border p-4">
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
            Whisper via /api/transcribe
          </h2>
          <p className="mt-2 text-sm">
            {whisper?.ok ? whisper.text : whisper ? "—" : "not run"}
          </p>
          {whisper && !whisper.ok && (
            <p className="mt-1 text-xs text-destructive">
              {whisper.reason}: {whisper.detail}
            </p>
          )}
        </div>
      </section>

      {choice && (
        <section className="mt-4 rounded-lg border border-border p-4">
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
            chooseTranscript() would submit
          </h2>
          <p className="mt-2 text-sm">
            <span className="font-mono text-xs">[{choice.source}]</span>{" "}
            {choice.text || "(nothing)"}
          </p>
          {choice.degradedReason && (
            <p className="mt-1 text-xs text-muted-foreground">
              degraded: {choice.degradedReason}
            </p>
          )}
        </section>
      )}

      <section className="mt-4 rounded-lg border border-border p-4">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
          Event log
        </h2>
        <ol className="mt-2 space-y-1 font-mono text-xs">
          {log.map((line, i) => (
            <li key={`${line.at}-${i}`}>
              <span className="text-muted-foreground">
                +{String(line.at - (log[0]?.at ?? line.at)).padStart(5, " ")}ms
              </span>{" "}
              <span className="text-clinical-teal">{line.tag}</span> {line.text}
            </li>
          ))}
          {!log.length && <li className="text-muted-foreground">—</li>}
        </ol>
      </section>
    </main>
  );
}
