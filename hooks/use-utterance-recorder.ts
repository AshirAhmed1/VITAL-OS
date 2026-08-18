"use client";

/**
 * VITAL OS — per-utterance audio capture for the Whisper STT path.
 *
 * Runs alongside SpeechRecognition rather than replacing it. SR stays the
 * voice-activity detector (interim text, barge-in over TTS, the 1600ms silence
 * endpoint); this hook records the same window so the transcript that actually
 * reaches the clinical parser comes from Whisper.
 *
 * One blob per utterance. The recorder is stopped and restarted at every
 * endpoint instead of slicing a rolling buffer, because only the first chunk
 * of a WebM stream carries the container header — a sliced tail is not
 * independently decodable and Whisper would reject it.
 */

import * as React from "react";

import {
  MIN_UTTERANCE_MS,
  pickRecorderMimeType,
  postUtterance,
  type TranscriptionOutcome,
} from "@/lib/whisper-stt";

/** Chunk cadence. Small enough that a stop lands promptly, large enough to stay cheap. */
const TIMESLICE_MS = 500;

/** Guard against a stuck ondataavailable wedging the submit path forever. */
const STOP_DRAIN_TIMEOUT_MS = 1500;

export type CaptureStatus =
  | "idle"
  | "unsupported"
  | "denied"
  | "recording"
  | "error";

export interface UtteranceRecorder {
  status: CaptureStatus;
  /** False when the platform cannot record — caller should stay on browser STT. */
  available: boolean;
  /** Acquire the mic and begin an utterance window. Safe to call repeatedly. */
  start: () => Promise<boolean>;
  /**
   * Close the current utterance, upload it, and immediately reopen a window for
   * the next one. Returns null when there was nothing worth sending, which the
   * caller should read as "use the browser transcript".
   */
  finalize: (role: string) => Promise<TranscriptionOutcome | null>;
  /** Drop the current utterance without uploading (barge-in, mute, cancel). */
  discard: () => void;
  /** Release the microphone entirely. */
  stop: () => void;
  /** Abort an upload that is still in flight. */
  abortInFlight: () => void;
}

type RecorderLike = MediaRecorder | null;

export function useUtteranceRecorder(): UtteranceRecorder {
  const [status, setStatus] = React.useState<CaptureStatus>("idle");

  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<RecorderLike>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const mimeRef = React.useRef<string>("audio/webm");
  const startedAtRef = React.useRef<number>(0);
  const uploadAbortRef = React.useRef<AbortController | null>(null);
  /* Set while finalize() is draining, so a concurrent discard cannot race it. */
  const drainingRef = React.useRef(false);

  const available = React.useMemo(() => {
    if (typeof window === "undefined") return false;
    if (typeof MediaRecorder === "undefined") return false;
    if (!navigator?.mediaDevices?.getUserMedia) return false;
    return pickRecorderMimeType((m) => MediaRecorder.isTypeSupported(m)) !== null;
  }, []);

  const teardown = React.useCallback(() => {
    try {
      recorderRef.current?.stop();
    } catch {
      /* Already inactive. */
    }
    recorderRef.current = null;
    chunksRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  /** Opens a fresh recorder over the existing stream. Assumes the mic is held. */
  const openWindow = React.useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return false;

    const recorder = new MediaRecorder(stream, { mimeType: mimeRef.current });
    chunksRef.current = [];
    startedAtRef.current = Date.now();

    recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };

    recorder.start(TIMESLICE_MS);
    recorderRef.current = recorder;
    return true;
  }, []);

  const start = React.useCallback(async (): Promise<boolean> => {
    if (!available) {
      setStatus("unsupported");
      return false;
    }
    if (recorderRef.current?.state === "recording") return true;

    try {
      if (!streamRef.current) {
        const mime = pickRecorderMimeType((m) =>
          MediaRecorder.isTypeSupported(m)
        );
        if (!mime) {
          setStatus("unsupported");
          return false;
        }
        mimeRef.current = mime;
        /* Echo cancellation matters here: the TTS voice must not be recorded
           back and transcribed as if the clinician had said it. */
        streamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }

      if (!openWindow()) {
        setStatus("error");
        return false;
      }
      setStatus("recording");
      return true;
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      /* SR has already surfaced its own permission error; do not double-report. */
      setStatus(name === "NotAllowedError" ? "denied" : "error");
      teardown();
      return false;
    }
  }, [available, openWindow, teardown]);

  /** Closes the recorder and resolves with everything it buffered. */
  const drain = React.useCallback((): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return Promise.resolve(null);
    }

    return new Promise<Blob | null>((resolve) => {
      let settled = false;
      let guard: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (guard) clearTimeout(guard);
        const parts = chunksRef.current;
        chunksRef.current = [];
        resolve(
          parts.length ? new Blob(parts, { type: mimeRef.current }) : null
        );
      };

      /* onstop fires after the final ondataavailable, so the tail is included.
         The guard covers a recorder that never fires onstop — without it a
         wedged encoder would hold the submit path open indefinitely. */
      recorder.onstop = finish;
      guard = setTimeout(finish, STOP_DRAIN_TIMEOUT_MS);

      try {
        recorder.stop();
      } catch {
        finish();
      }
    });
  }, []);

  const finalize = React.useCallback(
    async (role: string): Promise<TranscriptionOutcome | null> => {
      if (!recorderRef.current) return null;

      drainingRef.current = true;
      const durationMs = Date.now() - startedAtRef.current;
      const blob = await drain();
      drainingRef.current = false;

      /* Reopen immediately: the clinician may already be speaking the next
         command while this one is still uploading. */
      openWindow();

      if (!blob || durationMs < MIN_UTTERANCE_MS) return null;

      uploadAbortRef.current?.abort();
      const controller = new AbortController();
      uploadAbortRef.current = controller;

      const extension = mimeRef.current.includes("mp4") ? "mp4" : "webm";
      return postUtterance({
        audio: blob,
        role,
        durationMs,
        filename: `utterance.${extension}`,
        signal: controller.signal,
      });
    },
    [drain, openWindow]
  );

  const discard = React.useCallback(() => {
    if (drainingRef.current) return;
    chunksRef.current = [];
    startedAtRef.current = Date.now();
  }, []);

  const abortInFlight = React.useCallback(() => {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
  }, []);

  const stop = React.useCallback(() => {
    abortInFlight();
    teardown();
    setStatus("idle");
  }, [abortInFlight, teardown]);

  React.useEffect(() => {
    return () => {
      uploadAbortRef.current?.abort();
      teardown();
    };
  }, [teardown]);

  return {
    status,
    available,
    start,
    finalize,
    discard,
    stop,
    abortInFlight,
  };
}
