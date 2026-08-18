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
 * independently decodable and Whisper rejects it with
 * "could not process file - is it a valid media file?".
 *
 * Each recording window owns its OWN chunk array. A shared buffer let a stale
 * drain and a live one interleave chunks from two different MediaRecorder
 * instances, producing exactly that error. Window-scoped buffers make the race
 * structurally impossible rather than merely unlikely.
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
   * Close the current utterance, upload it, and reopen a window for the next.
   * Returns null when there was nothing worth sending, which the caller should
   * read as "use the browser transcript".
   */
  finalize: (role: string) => Promise<TranscriptionOutcome | null>;
  /** Drop the current utterance and reopen a clean window. */
  discard: () => void;
  /** Release the microphone entirely. */
  stop: () => void;
  /** Abort an upload that is still in flight. */
  abortInFlight: () => void;
}

/** One recording window: a recorder plus the chunks only it may write to. */
type Window = {
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  mimeType: string;
  /** Set once this window has been drained, so it can never be drained twice. */
  closed: boolean;
};

export function useUtteranceRecorder(): UtteranceRecorder {
  const [status, setStatus] = React.useState<CaptureStatus>("idle");

  const streamRef = React.useRef<MediaStream | null>(null);
  const windowRef = React.useRef<Window | null>(null);
  const mimeRef = React.useRef<string>("audio/webm");
  const uploadAbortRef = React.useRef<AbortController | null>(null);
  /** Serialises finalize/discard so two drains can never overlap. */
  const opRef = React.useRef<Promise<unknown>>(Promise.resolve());

  const available = React.useMemo(() => {
    if (typeof window === "undefined") return false;
    if (typeof MediaRecorder === "undefined") return false;
    if (!navigator?.mediaDevices?.getUserMedia) return false;
    return pickRecorderMimeType((m) => MediaRecorder.isTypeSupported(m)) !== null;
  }, []);

  /** Runs fn after every previously queued operation, success or failure. */
  const enqueue = React.useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const next = opRef.current.then(fn, fn);
    opRef.current = next.catch(() => undefined);
    return next;
  }, []);

  /** Opens a fresh window over the existing stream. Assumes the mic is held. */
  const openWindow = React.useCallback((): boolean => {
    const stream = streamRef.current;
    if (!stream) return false;

    const recorder = new MediaRecorder(stream, { mimeType: mimeRef.current });
    const win: Window = {
      recorder,
      chunks: [],
      startedAt: Date.now(),
      mimeType: mimeRef.current,
      closed: false,
    };

    /* Closes over `win`, so chunks can only ever land in their own window. */
    recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) win.chunks.push(ev.data);
    };

    try {
      recorder.start(TIMESLICE_MS);
    } catch {
      return false;
    }
    windowRef.current = win;
    return true;
  }, []);

  const teardown = React.useCallback(() => {
    const win = windowRef.current;
    if (win && win.recorder.state !== "inactive") {
      try {
        win.recorder.stop();
      } catch {
        /* Already stopping. */
      }
    }
    windowRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = React.useCallback(async (): Promise<boolean> => {
    if (!available) {
      setStatus("unsupported");
      return false;
    }
    if (windowRef.current?.recorder.state === "recording") return true;

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
      /* SR surfaces its own permission error; do not double-report. */
      setStatus(name === "NotAllowedError" ? "denied" : "error");
      teardown();
      return false;
    }
  }, [available, openWindow, teardown]);

  /**
   * Closes one specific window and resolves with the audio IT buffered.
   * Takes the window as an argument rather than reading a ref, so a queued
   * drain cannot accidentally harvest a window opened after it was scheduled.
   */
  const drainWindow = React.useCallback(
    (win: Window): Promise<{ blob: Blob | null; durationMs: number }> => {
      if (win.closed || win.recorder.state === "inactive") {
        win.closed = true;
        return Promise.resolve({
          blob: win.chunks.length
            ? new Blob(win.chunks, { type: win.mimeType })
            : null,
          durationMs: Date.now() - win.startedAt,
        });
      }
      win.closed = true;

      return new Promise((resolve) => {
        let settled = false;
        let guard: ReturnType<typeof setTimeout> | undefined;

        const finish = () => {
          if (settled) return;
          settled = true;
          if (guard) clearTimeout(guard);
          resolve({
            blob: win.chunks.length
              ? new Blob(win.chunks, { type: win.mimeType })
              : null,
            durationMs: Date.now() - win.startedAt,
          });
        };

        /* onstop fires after the final ondataavailable, so the tail is included.
           The guard covers an encoder that never fires onstop — without it a
           wedged recorder would hold the submit path open indefinitely. */
        win.recorder.onstop = finish;
        guard = setTimeout(finish, STOP_DRAIN_TIMEOUT_MS);

        try {
          win.recorder.stop();
        } catch {
          finish();
        }
      });
    },
    []
  );

  const finalize = React.useCallback(
    (role: string): Promise<TranscriptionOutcome | null> =>
      enqueue(async () => {
        const win = windowRef.current;
        if (!win) return null;
        windowRef.current = null;

        const { blob, durationMs } = await drainWindow(win);

        /* Reopen immediately: the clinician may already be speaking the next
           command while this one is still uploading. */
        openWindow();

        if (!blob || durationMs < MIN_UTTERANCE_MS) return null;

        uploadAbortRef.current?.abort();
        const controller = new AbortController();
        uploadAbortRef.current = controller;

        const extension = win.mimeType.includes("mp4") ? "mp4" : "webm";
        return postUtterance({
          audio: blob,
          role,
          durationMs,
          filename: `utterance.${extension}`,
          signal: controller.signal,
        });
      }),
    [drainWindow, enqueue, openWindow]
  );

  const discard = React.useCallback(() => {
    void enqueue(async () => {
      const win = windowRef.current;
      if (!win) return;
      windowRef.current = null;
      await drainWindow(win);
      openWindow();
    });
  }, [drainWindow, enqueue, openWindow]);

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
