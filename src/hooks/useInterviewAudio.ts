import { useEffect, useRef, useState, useCallback } from "react";
import {
  useStore,
  type TranscriptMessage,
  type AsrComparison,
} from "../store/useStore";
import {
  normalizeTechnicalTerms,
  logNormalization,
} from "../lib/normalization";
import {
  correctTranscript,
  logCorrection,
} from "../lib/transcriptCorrection";
import {
  consumePendingStart,
  registerInterviewControls,
} from "../lib/interviewControls";
import { buildCandidateContext } from "../lib/transcriptVocabulary";
import { assessTranscriptQuality } from "../lib/transcriptQuality";
import {
  pushAudioLevel,
  resetAudioStatus,
  setAudioStatus,
} from "../lib/audioStatus";
import {
  buildVadWorkletCode,
  DEFAULT_VAD_CONFIG,
} from "../lib/vadWorklet";
import { openDeepgramSegment } from "../lib/deepgramClient";
import {
  buildKeyterms,
  redactForLog,
} from "../lib/deepgramKeyterms";
import { runGroqWhisperComparison } from "../lib/groqWhisperClient";
import {
  DEFAULT_GROQ_ASR_MODEL,
  formatGroqTelemetryForLog,
} from "../lib/groqWhisper";
import {
  loadParakeetModel,
  unloadParakeetModel,
  runParakeetComparison,
} from "../lib/parakeetClient";
import {
  describeClipping,
  float32ToWavWithClipping,
  isDebugWavEnabled,
  setDebugWavEnabled,
} from "../lib/debugWav";
import {
  createAsrDrain,
  DRAIN_STEP_MS,
  registerAsrDrain,
  type DrainResult,
  type FlushTransport,
} from "../lib/asrDrain";

export type ChatMessage = TranscriptMessage;

// Inline AudioWorklet to bypass Vite/Electron worker bundling issues.
//
// Besides voice-activity detection (emitting a complete clip when a phrase
// ends), this emits a rolling *partial* snapshot while speech is ongoing, which
// is what gives Moonshine the Parakeet-style "text appears while they talk"
// feel instead of waiting for a full second of silence.
//
// The source and its thresholds live in `lib/vadWorklet.ts` rather than inline
// here, because they are the thing the fragmentation measurement runs against
// (see `simulateSegmentation`) — a threshold that cannot be imported cannot be
// measured, and an unmeasured `MAX_SILENCE_SECONDS` is exactly how a question
// ends up split across three separately-decoded fragments.
const vadWorkletCode = buildVadWorkletCode(DEFAULT_VAD_CONFIG);

/**
 * Below this RMS (or peak) a 16 kHz buffer is treated as silence and never
 * sent to the ASR. Moonshine hallucinates on near-silent audio, which is where
 * strings like "(no speech recognised)" came from.
 */
const MIN_SEND_RMS = 0.003;
const MIN_SEND_PEAK = 0.01;

/** Root-mean-square and peak amplitude of a Float32 buffer. */
function analyseLevels(samples: Float32Array): { rms: number; peak: number } {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sum / samples.length), peak };
}

/**
 * The single owner of an AudioContext's lifetime.
 *
 * ── Exact cause of the runtime `InvalidStateError: Cannot close a closed
 * AudioContext` ────────────────────────────────────────────────────────────
 * Before this, FOUR independent code paths could call `close()` on the SAME
 * context, and none of them checked its state first:
 *
 *   1. the session `teardown` (device change / stop / unmount),
 *   2. the `catch` block of `startInterview` when acquisition threw,
 *   3. `stopInterview`'s legacy `(window as any)._interviewStreams[1].close()`,
 *   4. the unmount effect.
 *
 * `close()` is ASYNCHRONOUS, and `AudioContext.state` does not change until
 * the returned promise settles. The real race is therefore:
 *
 *   Path A: sees state === "running"  → calls close()
 *   Path B: sees state === "running"  → calls close()   ← rejects
 *
 * There is no intermediate state to test for: `AudioContextState` is
 * `"suspended" | "running" | "closed"` (plus `"interrupted"` in newer specs).
 * Nothing named `"closing"` exists, so a state check alone cannot prevent the
 * double close.
 *
 * The fix is ownership: the SYNCHRONOUS `done` flag is what actually prevents
 * the second call, because it flips before any await point can be reached. The
 * `state === "closed"` check is only a cheap fast-path for a context that was
 * already closed by someone else.
 */
function createIdempotentContextCloser(
  ctx: AudioContext,
): () => void {
  let done = false;
  return () => {
    // Synchronous guard — this, not the state check, is what prevents the
    // double close.
    if (done) return;
    done = true;
    if (ctx.state === "closed") return;
    void ctx.close().catch(() => {
      /* already gone — nothing left to release */
    });
  };
}

export function useInterviewAudio() {
  // Interview transcript lives in the global store so the overlay (Home) can
  // read it and submit it via Ctrl+Enter — single source of truth.
  const messages = useStore((s) => s.interviewMessages);
  const interim = useStore((s) => s.interviewInterim);
  const addInterviewMessage = useStore((s) => s.addInterviewMessage);
  const clearInterviewMessages = useStore((s) => s.clearInterviewMessages);
  const setInterviewInterim = useStore((s) => s.setInterviewInterim);

  const [isRecording, setIsRecording] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [isModelReady, setIsModelReady] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  // We'll store debug audio blobs in logs too, so if text fails, you still get
  // the audio. Populated ONLY while the dev-only WAV dump is explicitly
  // enabled (see `lib/debugWav.ts`) — never in a production build.
  const [debugAudios, setDebugAudios] = useState<
    { name: string; url: string }[]
  >([]);
  const [debugWavOn, setDebugWavOn] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  // Transcription can finish out of order (a partial started before its own
  // final). These ids stop a late partial from resurrecting the interim line
  // after the final for that phrase was already committed — which would look
  // like "the interviewer is still speaking" forever.
  const lastFinalPhraseIdRef = useRef(-1);
  const interimPhraseIdRef = useRef(-1);
  const asrModel = useStore(
    (s) => s.settings.whisperModel ?? "onnx-community/moonshine-base-ONNX",
  );

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [
      ...prev.slice(-49),
      `${new Date().toLocaleTimeString()} - ${msg}`,
    ]);
  }, []);

  const addDebugAudio = useCallback((name: string, url: string) => {
    setDebugAudios((prev) => [...prev.slice(-9), { name, url }]);
  }, []);

  // Tracks whether non-silent audio is currently reaching us, so we log the
  // transition once (instead of spamming a level reading every frame).
  const audioActiveRef = useRef(false);
  // Idempotent teardown for the CURRENT capture session (stream tracks,
  // AudioContext, and the device/track listeners). `null` when nothing is
  // running, so calling it twice is a no-op.
  const teardownRef = useRef<(() => void) | null>(null);
  // Guards against an endless capture/restart loop when a device keeps
  // flapping between "connected" and "disconnected".
  const restartingRef = useRef(false);
  // Whether capture is *supposed* to be running. An automatic reacquire that
  // finishes after the user pressed Stop must tear itself down again instead of
  // resurrecting a capture session nobody asked for.
  const runningRef = useRef(false);
  // Lets the restart path call the current `startInterview` without the
  // listener capturing a stale closure.
  const startRef = useRef<() => Promise<void>>(async () => {});
  // The Start/Stop hotkey bridge (see `lib/interviewControls.ts`) reads these
  // through refs so its registration never captures a stale closure and never
  // has to re-register on every render.
  const stopRef = useRef<() => void>(() => {});
  const isRecordingRef = useRef(false);
  const modelReadyRef = useRef(false);

  // ── Drain barrier plumbing ───────────────────────────────────────────────
  // `Ctrl+Enter` reads the transcript synchronously, so a final still decoding
  // in the worker would be missing from the submitted question. The hotkey path
  // calls `drainAsr()` first, which asks the worker to report when its queue
  // reaches a marker and waits — bounded — for that to happen.
  //
  // `pendingFinalsRef` is the renderer's own count of finals it has sent but
  // not yet had committed. It is the authority on "is the current phrase
  // actually in the store yet", independent of what the worker reports.
  const pendingFinalsRef = useRef(0);
  // Monotonic id so a `flushed` reply can only satisfy the flush that asked
  // for it. Without this, a late reply from a previous flush could mark a
  // newer drain as complete while work was still outstanding.
  const flushRequestIdRef = useRef(0);
  const flushWaitersRef = useRef<Map<number, (pending: number) => void>>(new Map());
  const lastReportedPendingRef = useRef(0);

  /**
   * Create-or-update the comparison row for one captured phrase.
   *
   * All engines key on the same `phraseId`, so whichever engine reports first
   * creates the row and the others fill their own cell. The store performs an
   * upsert by id, so this never produces duplicate rows.
   */
  const upsertComparison = useCallback(
    (
      phraseId: number,
      patch: Partial<AsrComparison> & { audioSeconds: number },
    ) => {
      const state = useStore.getState();
      const existing = state.asrComparisons.find((c) =>
        c.id.startsWith(`${phraseId}-`),
      );
      const base: AsrComparison =
        existing ?? {
          id: `${phraseId}-${Date.now()}`,
          audioSeconds: patch.audioSeconds,
          moonshineText: "",
          deepgramText: "",
          deepgramTelemetry: null,
          moonshineMs: null,
          timestamp: Date.now(),
        };
      state.addAsrComparison({
        ...base,
        ...patch,
        id: base.id,
        timestamp: base.timestamp,
      });
    },
    [],
  );

  // ── Optional second engine: Deepgram, for comparison only ────────────────
  //
  // Invoked with the SAME buffer Moonshine receives, so both engines decode
  // identical audio and the comparison is meaningful. Strictly fire-and-
  // forget: every failure path here is silent to the rest of the app, because
  // Deepgram is a diagnostic and must never be able to break transcription.
  //
  // The result lands in `asrComparisons`, a slice the AI pipeline never reads.
  const compareWithDeepgram = useCallback(
    (audio: Float32Array, speechSeconds: number, phraseId: number) => {
      const { settings } = useStore.getState();

      // Feature flag. Off by default, and off in production builds.
      if (!settings.asrCompareMode) return;
      if (!import.meta.env.DEV) return;
      if (!settings.deepgramKey) return;

      // Keyterms come from the candidate’s own settings only (role, company,
      // typed skills). Never parsed out of resume prose. The URL is built with
      // REPEATED keyterm params, which is the only form Deepgram accepts.
      const keyterms = buildKeyterms({
        role: settings.interviewType,
        company: settings.companyName,
        skills: settings.language,
      });

      void openDeepgramSegment(
        { keyterms: keyterms.terms },
        {
          onFinal: (text, telemetry) => {
            // Moonshine’s text is filled in when its final lands; until then
            // the row shows Deepgram’s result against an empty cell.
            upsertComparison(phraseId, {
              audioSeconds: speechSeconds,
              deepgramText: text,
              deepgramTelemetry: telemetry,
            });
            console.log(
              `[Deepgram] comparison phraseId=${phraseId} keyterms ${redactForLog(keyterms)}`,
            );
          },
          onError: (message) => {
            // Category-level message only — never a transcript or a key.
            console.warn(`[Deepgram] comparison skipped: ${message}`);
          },
        },
      ).then((segment) => {
        if (!segment) return;
        // One utterance per socket: push the whole segment, then close and
        // wait for Deepgram’s final.
        segment.push(audio);
        void segment.finish();
      });
    },
    [upsertComparison],
  );

  // ── Optional third engine: Groq Whisper, for comparison only ─────────────
  //
  // Given the SAME buffer as Moonshine and Deepgram. Strictly fire-and-forget:
  // a missing key, a slow network or any HTTP error is reported in the dev
  // diagnostics only and can never affect the default transcription path. The
  // result is corrected by the shared, engine-agnostic correction engine and
  // stored in `asrComparisons`, which the AI pipeline never reads.
  const compareWithGroq = useCallback(
    (audio: Float32Array, speechSeconds: number, phraseId: number) => {
      const { settings } = useStore.getState();

      // Feature flag. Off by default, and off in production builds.
      if (!settings.asrCompareGroq) return;
      if (!import.meta.env.DEV) return;

      const keyterms = buildKeyterms({
        role: settings.interviewType,
        company: settings.companyName,
        skills: settings.language,
      });

      void runGroqWhisperComparison(
        audio,
        {
          model: settings.groqAsrModel || DEFAULT_GROQ_ASR_MODEL,
          promptTerms: keyterms.terms,
        },
        {
          onResult: (result, telemetry) => {
            // The SHARED correction engine — no Groq-specific rules.
            const correction = correctTranscript({
              rawText: result.text,
              source: "system",
              candidateContext: buildCandidateContext(
                useStore.getState().settings,
              ),
            });
            logCorrection(correction);
            upsertComparison(phraseId, {
              audioSeconds: speechSeconds,
              groqText: result.text,
              groqCorrectedText: correction.correctedText,
              groqTelemetry: telemetry,
            });
            console.log(
              `[Groq] comparison phraseId=${phraseId} ${formatGroqTelemetryForLog(telemetry)} promptTerms ${redactForLog(keyterms)}`,
            );
          },
          onError: (message) => {
            // Category-level message only — never a transcript or a key.
            console.warn(`[Groq] comparison skipped: ${message}`);
          },
        },
      );
    },
    [upsertComparison],
  );

  // ── Optional fourth engine: Parakeet (LOCAL, dev comparison only) ────────
  //
  // Given the SAME buffer as Moonshine, Deepgram and Groq, so all four engines
  // decode identical audio. Strictly fire-and-forget: the load, the decode, the
  // queue and every failure belong to the host in the main process, and nothing
  // here can delay or alter the Moonshine path.
  //
  // ISOLATION — the important part: the result is written ONLY to
  // `asrComparisons`, via `upsertComparison`. It is never added to
  // `interviewMessages`, never corrected into the transcript, never read by the
  // question gate, and never included in a prompt. Moonshine stays the
  // production engine and there is no fallback in either direction.
  const compareWithParakeet = useCallback(
    (audio: Float32Array, speechSeconds: number, phraseId: number) => {
      const { settings } = useStore.getState();

      // Feature flag. Off by default, and off in production builds.
      if (!settings.asrCompareParakeet) return;
      if (!import.meta.env.DEV) return;

      void runParakeetComparison(audio, {
        onResult: (result) => {
          if (!result.ok) {
            // Record WHY there is no text. A silently blank column would be
            // indistinguishable from "Parakeet heard nothing", which is exactly
            // the kind of quiet failure that makes a comparison meaningless.
            upsertComparison(phraseId, {
              audioSeconds: speechSeconds,
              parakeetStatus: result.code ?? "error",
            });
            // Category-level message only — never a transcript.
            console.warn(
              `[Parakeet] comparison skipped: code=${result.code ?? "error"}`,
            );
            return;
          }
          upsertComparison(phraseId, {
            audioSeconds: speechSeconds,
            parakeetText: result.text ?? "",
            parakeetMs: result.decodeMs ?? null,
            parakeetStatus: "ok",
          });
          console.log(
            `[Parakeet] comparison phraseId=${phraseId} decodeMs=${result.decodeMs ?? "?"} rssMb=${result.rssMb ?? "?"}`,
          );
        },
        onError: (message) => {
          // Category-level message only — never a transcript.
          console.warn(`[Parakeet] comparison skipped: ${message}`);
        },
      });
    },
    [upsertComparison],
  );

  const handleLevel = useCallback(
    (sample: { rms: number; peak: number; speaking: boolean }) => {
      // Feed the meter + state machine on EVERY sample (no React render).
      pushAudioLevel(sample.rms, sample.speaking);

      // Log only the transitions, never every sample.
      const active = sample.peak >= 0.01;
      if (active === audioActiveRef.current) return;
      audioActiveRef.current = active;
      addLog(
        active
          ? `System audio detected (level ${sample.peak.toFixed(3)}).`
          : `System audio is silent (level ${sample.peak.toFixed(3)}) — no sound is reaching Ghostly.`,
      );
    },
    [addLog],
  );

  // Worker Initialization — re-runs whenever the chosen ASR model changes
  useEffect(() => {
    setIsModelReady(false);
    workerRef.current?.terminate();

    workerRef.current = new Worker(
      new URL("../lib/asr.worker.ts", import.meta.url),
      {
        type: "module",
      },
    );

    workerRef.current.onmessage = (e) => {
      const {
        type,
        message,
        source,
        text,
        audioUrl,
        progress,
        phraseId,
        requestId,
        pending,
      } = e.data;
      const id: number = phraseId ?? 0;
      if (type === "log") addLog(message);
      if (type === "progress") {
        setDownloadProgress(Math.min(Math.round(progress ?? 0), 99));
      }
      if (type === "ready") {
        addLog("AI Engine Ready.");
        setIsModelReady(true);
        setDownloadProgress(null);
      }
      if (type === "error") {
        setIsModelReady(false);
        setDownloadProgress(null);
      }

      // ── Drain barrier replies ──────────────────────────────────────────
      // The worker reached the marker we queued, so every final sent before
      // that flush has been decoded. `flushed` carries the worker's own view of
      // what is still queued; the renderer's own `pendingFinalsRef` count is
      // the tie-breaker when the two disagree (it is never lower, because the
      // worker cannot know about finals the renderer has not posted yet).
      if (type === "flushQueued") {
        lastReportedPendingRef.current = Math.max(0, pending ?? 0);
        return;
      }
      if (type === "flushed") {
        const resolve = flushWaitersRef.current.get(requestId);
        if (resolve) {
          flushWaitersRef.current.delete(requestId);
          resolve(Math.max(0, pendingFinalsRef.current, pending ?? 0));
        }
        return;
      }
      // Live interim text — replaced by the final result when the phrase ends.
      if (type === "partial") {
        // Belongs to a phrase that is already finalized — stale, drop it.
        if (id < lastFinalPhraseIdRef.current) return;
        if (text) {
          interimPhraseIdRef.current = id;
          setInterviewInterim({ source, text });
        }
      }
      if (type === "final") {
        // Comparison mode only: pair Moonshine's result with the Deepgram /
        // Groq / Parakeet results already recorded for this same phraseId, so
        // the developer view shows every engine on identical audio. A no-op
        // when the feature flags are off, which is the default.
        if (
          import.meta.env.DEV &&
          (useStore.getState().settings.asrCompareMode ||
            useStore.getState().settings.asrCompareGroq ||
            useStore.getState().settings.asrCompareParakeet)
        ) {
          const target = useStore
            .getState()
            .asrComparisons.find((c) => c.id.startsWith(`${id}-`));
          if (target) {
            upsertComparison(id, {
              audioSeconds: target.audioSeconds,
              moonshineText: text,
            });
          }
        }
        // This final is now accounted for, whatever happens to it below: it is
        // committed, or deliberately dropped by the quality gate, or empty. The
        // drain barrier must never be left waiting on a final that already
        // arrived, so the counter is decremented FIRST — before any early
        // return — not last.
        if (pendingFinalsRef.current > 0) pendingFinalsRef.current--;

        // Only finalized utterances are logged (never the 0.7s partial stream),
        // and only finals are ever allowed to reach the AI.
        console.log(
          `[STT] final (${source}): ${text || "(no speech recognised)"}`,
        );
        lastFinalPhraseIdRef.current = Math.max(
          lastFinalPhraseIdRef.current,
          id,
        );
        // Decoding for this final is over. The next level sample (20/s) refines
        // the state to LISTENING / SPEECH / NO AUDIO from here.
        setAudioStatus("listening");
        // Clear the live line only if it belongs to this phrase or older.
        if (id >= interimPhraseIdRef.current) setInterviewInterim(null);
        if (text) {
          // ── Structural ASR-artefact gate ───────────────────────────────
          // Moonshine sometimes returns an engine sentinel ("(no speech
          // recognised)") or a phrase doubled verbatim instead of speech.
          // Drop those here so they are never committed to the store at all,
          // rather than relying on the question gate to reject them later.
          // Structure-only checks — see `transcriptQuality.ts`.
          const quality = assessTranscriptQuality(text);
          if (!quality.ok) {
            console.warn(
              `[ASR] discarded final (${source}): ${quality.detail}`,
            );
            addLog(`[ASR] ignored unusable segment — ${quality.detail}`);
            return;
          }

          // ── Context-aware ASR repair + technical-term normalization ──────
          // Runs on FINAL transcripts only, and before anything reads the
          // transcript. The store is the single source the question gate
          // (`evaluateInterviewTurn`) reads from, so repairing here means the
          // gate, the detected-question banner, the prompt and the answer card
          // all see the corrected terminology.
          //
          // The raw ASR text is PRESERVED (`rawText`) — only the corrected form
          // is used downstream. The generic correction engine is open-world:
          // candidate context (resume / projects / skills) is a boost, never a
          // whitelist, and weak-evidence spans are left exactly as heard.
          //
          // Interim/partial text is deliberately left untouched: it is
          // display-only and must never influence detection or generation.
          // Build a candidate-signal from the candidate's own profile for the
          // candidate-correction engine. Same module the manual-text path uses,
          // so there is one source of truth. The candidate is only applied when
          // the strong-evidence floor is met; it is never appended.
          const companyName = useStore.getState().settings.companyName;
          const candidateSignal = companyName ? { text: companyName } : undefined;

          const correction = correctTranscript({
            rawText: text,
            source,
            candidateContext: buildCandidateContext(useStore.getState().settings),
            candidateSignal,
          });
          // Deterministic telemetry (never the transcript itself).
          logCorrection(correction);
          if (import.meta.env.DEV && correction.changed) {
            console.log(`[ASR-CORRECTION] RAW:       "${text}"`);
            console.log(`[ASR-CORRECTION] CORRECTED: "${correction.correctedText}"`);
          }
          const normalized = normalizeTechnicalTerms(correction.correctedText);
          logNormalization(correction.correctedText, normalized);
          addInterviewMessage({
            id: crypto.randomUUID(),
            source,
            text: normalized,
            timestamp: Date.now(),
            audioUrl,
            rawText: text,
            correction: {
              applied: correction.changed,
              confidence: correction.confidence,
              details: correction.corrections.map((c) => ({
                from: c.from,
                to: c.to,
                confidence: c.confidence,
                reason: c.reason,
              })),
              reason: correction.reason,
            },
          });
        } else {
          addLog(`[WARNING] No speech recognised in ${source} clip`);
        }
      }
    };

    workerRef.current.postMessage({ type: "load", model: asrModel });

    return () => workerRef.current?.terminate();
  }, [addLog, addInterviewMessage, setInterviewInterim, asrModel, upsertComparison]);

  const startInterview = async () => {
    if (!isModelReady) {
      addLog("Cannot start: AI Model not ready yet.");
      return;
    }
    runningRef.current = true;

    // Fresh transcript for each new session.
    clearInterviewMessages();
    lastFinalPhraseIdRef.current = -1;
    interimPhraseIdRef.current = -1;
    audioActiveRef.current = false;
    // A final still decoding from the PREVIOUS session must not be counted
    // against this one, and must never be committed to the fresh transcript.
    // Dropping the waiters here is what makes a late final from a cancelled
    // session inert: it has nothing left to satisfy.
    pendingFinalsRef.current = 0;
    flushWaitersRef.current.forEach((resolve) => resolve(0));
    flushWaitersRef.current.clear();
    setIsRecording(true);
    addLog("Starting system audio capture (interviewer only)...");

    // ── Parakeet: load the model HERE, not at app launch ────────────────
    // Cold load measured ~6 s and several hundred MB of RSS. Doing it on Start
    // keeps that cost off app launch, where a session with the feature off
    // would pay it for nothing. Fire-and-forget with a result log: capture
    // continues regardless, because this is a diagnostic, not a dependency.
    if (import.meta.env.DEV && useStore.getState().settings.asrCompareParakeet) {
      void loadParakeetModel().then((result) => {
        if (result.ok) {
          addLog(
            `Parakeet comparison model ready (${result.loadMs ?? "?"} ms, ${result.rssMb ?? "?"} MB RSS).`,
          );
        } else {
          addLog(`Parakeet comparison unavailable: ${result.code ?? "error"}.`);
        }
      });
    }

    let closeContext: (() => void) | null = null;
    let displayStream: MediaStream | null = null;

    try {
      // Ask for a 16 kHz context so Moonshine receives its native rate directly
      // (Chromium resamples with a proper filter). Falls back to the device rate.
      let ctx: AudioContext;
      try {
        ctx = new window.AudioContext({ sampleRate: 16000 });
      } catch {
        ctx = new window.AudioContext();
      }
      // The ONE owner of this context's lifetime. Every other exit path below
      // goes through this function — never `ctx.close()` directly.
      closeContext = createIdempotentContextCloser(ctx);

      // ---- Capture system (loopback) audio ----
      // Primary path: getDisplayMedia, resolved by the main-process
      // setDisplayMediaRequestHandler with `audio: 'loopback'`. This is
      // Electron's supported, reliable route for system audio on Windows.
      let audioTracks: MediaStreamTrack[] = [];
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        audioTracks = displayStream.getAudioTracks();
        addLog(
          `Display capture: ${displayStream.getVideoTracks().length} video / ${audioTracks.length} audio track(s)`,
        );
      } catch (err) {
        addLog(`getDisplayMedia failed: ${err}`);
      }

      // Fallback path: legacy desktop constraint, in case loopback isn't granted.
      if (audioTracks.length === 0) {
        displayStream?.getTracks().forEach((t) => t.stop());
        displayStream = null;
        try {
          const sources = await window.ghostly.getDesktopSources();
          addLog(`Fallback: found ${sources.length} desktop sources`);
          const screenSource =
            sources.find(
              (s) =>
                s.name === "Entire Screen" ||
                s.name.includes("Screen") ||
                s.name.includes("Display"),
            ) || sources[0];

          if (screenSource) {
            addLog(`Fallback using source: ${screenSource.name}`);
            displayStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                mandatory: {
                  chromeMediaSource: "desktop",
                  chromeMediaSourceId: screenSource.id,
                },
              } as any,
              video: {
                mandatory: {
                  chromeMediaSource: "desktop",
                  chromeMediaSourceId: screenSource.id,
                },
              } as any,
            });
            audioTracks = displayStream.getAudioTracks();
            addLog(`Fallback capture: ${audioTracks.length} audio track(s)`);
          }
        } catch (err) {
          addLog(`Legacy system-audio capture failed: ${err}`);
        }
      }

      if (!displayStream || audioTracks.length === 0) {
        addLog(
          "No system audio track available. Make sure the interviewer's voice is playing through your default output device (speakers or headphones), then press Start again.",
        );
        setAudioStatus("error", "no system audio track");
        setIsRecording(false);
        closeContext?.();
        return;
      }

      const audioTrack = audioTracks[0];
      addLog(
        `Audio track "${audioTrack.label || "unknown"}" enabled=${audioTrack.enabled} muted=${audioTrack.muted}`,
      );

      // IMPORTANT: do NOT stop the video track. Tearing down desktop capture's
      // video track can silence/kill the loopback audio track on Windows.

      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      addLog(`AudioContext: state=${ctx.state} sampleRate=${ctx.sampleRate}`);

      // Load Worklet
      const blob = new Blob([vadWorkletCode], {
        type: "application/javascript",
      });
      const workletUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      // Feed only the audio track into the graph, but keep the full display
      // stream stored below so the capture session stays alive.
      const audioOnly = new MediaStream([audioTrack]);
      const sysSource = ctx.createMediaStreamSource(audioOnly);
      setupVADWorklet(
        ctx,
        sysSource,
        "system",
        workerRef,
        addLog,
        addDebugAudio,
        handleLevel,
        () => setInterviewInterim(null),
        () => {
          pendingFinalsRef.current++;
        },
        compareWithDeepgram,
        compareWithGroq,
        compareWithParakeet,
      );
      addLog("System (interviewer) audio capture started.");

      // ── Audio-source lifecycle ─────────────────────────────────────────
      // Windows loopback follows the *default render device*. Plugging earbuds
      // in or out (or any other default-device change) can end or silence the
      // existing track. Previously nothing listened for that, so capture died
      // silently for the rest of the interview.
      //
      // Cleanup is registered as one idempotent function so the track, the
      // context and both listeners are always released together — never a stale
      // MediaStream, AudioContext or listener left behind.
      const teardown = () => {
        navigator.mediaDevices.removeEventListener(
          "devicechange",
          onDeviceChange,
        );
        audioTrack.removeEventListener("ended", onTrackEnded);
        try {
          displayStream?.getTracks().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
        // Single owner — idempotent, and never called twice for one context.
        closeContext?.();
        teardownRef.current = null;
      };
      teardownRef.current = teardown;

      const reacquire = (why: string) => {
        if (restartingRef.current || !runningRef.current) return;
        restartingRef.current = true;
        addLog(`${why} — reacquiring system audio automatically…`);
        console.warn(`[ASR] system audio source lost (${why}) — reacquiring`);
        try {
          teardown();
        } catch {
          /* ignore */
        }
        void startRef
          .current()
          .catch((err) => addLog(`Reacquire failed: ${err}`))
          .finally(() => {
            restartingRef.current = false;
          });
      };

      const onTrackEnded = () => {
        setAudioStatus("disconnected", "audio device removed");
        reacquire("system audio track ended (output device changed)");
      };
      const onDeviceChange = () => {
        addLog(
          `Audio output device change detected — track ${audioTrack.readyState}`,
        );
        if (audioTrack.readyState === "ended") {
          setAudioStatus("disconnected", "audio device changed");
          reacquire("system audio track ended after a device change");
        }
      };

      audioTrack.addEventListener("ended", onTrackEnded);
      navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);

      (window as any)._interviewStreams = [displayStream, ctx];

      // Stop may have been pressed while we were acquiring. Do not leave an
      // orphaned capture session behind.
      if (!runningRef.current) {
        addLog("Capture finished after Stop was pressed — releasing it.");
        teardown();
        return;
      }

      // Capture is live and healthy again (fresh stream OR after a device
      // reacquisition).
      setAudioStatus("listening");
    } catch (err) {
      addLog(`Failed to start audio: ${err}`);
      setAudioStatus(
        "error",
        err instanceof Error ? err.message : String(err),
      );
      setIsRecording(false);
      // Route through the single owner instead of closing the context here.
      closeContext?.();
      try {
        displayStream?.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      (window as any)._interviewStreams = null;
    }
  };

  // Keep the restart path pointed at the current implementation.
  startRef.current = startInterview;
  isRecordingRef.current = isRecording;
  modelReadyRef.current = isModelReady;

  // ── The drain barrier the hotkey awaits ──────────────────────────────────
  //
  // Called by `Home.tsx` immediately before it reads the transcript. Returns
  // without ever rejecting: a barrier that could fail would turn "the tail of
  // the question is missing" into "the hotkey does nothing", which is worse.
  const drainAsr = useCallback(async (): Promise<DrainResult> => {
    const worker = workerRef.current;
    if (!worker) {
      return {
        outcome: "noWorker",
        waitedMs: 0,
        attempts: 0,
        timedOut: false,
      };
    }

    const transport: FlushTransport = {
      pending: () => pendingFinalsRef.current,
      flush: () =>
        new Promise<number | null>((resolve) => {
          const requestId = ++flushRequestIdRef.current;
          let settled = false;
          // A safety net so a lost `flushed` reply can never leave the hotkey
          // waiting on a promise that will not resolve. The barrier's own
          // deadline is the outer bound; this is the inner one.
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            flushWaitersRef.current.delete(requestId);
            resolve(null); // unknown — the barrier re-checks and retries
          }, DRAIN_STEP_MS * 2);
          flushWaitersRef.current.set(requestId, (pending) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(pending);
          });
          worker.postMessage({ type: "flush", requestId });
        }),
    };

    return createAsrDrain(transport).drain();
  }, []);

  // Publish the barrier for the `Ctrl+Enter` handler, which lives in `Home.tsx`
  // and cannot see this hook. Unregistered on unmount so a closed interview
  // panel can never leave a barrier pointing at a dead worker.
  useEffect(() => {
    registerAsrDrain(drainAsr);
    return () => registerAsrDrain(null);
  }, [drainAsr]);

  // Never leave a capture session (tracks + AudioContext) running on unmount.
  useEffect(
    () => () => {
      teardownRef.current?.();
    },
    [],
  );

  const stopInterview = () => {
    runningRef.current = false;
    setIsRecording(false);
    audioActiveRef.current = false;
    restartingRef.current = true; // suppress any in-flight reacquire
    setInterviewInterim(null);
    // Nothing is owed any more: release every outstanding drain waiter so a
    // final that is still decoding cannot keep a barrier pending after the
    // user has already stopped and moved on.
    pendingFinalsRef.current = 0;
    flushWaitersRef.current.forEach((resolve) => resolve(0));
    flushWaitersRef.current.clear();
    addLog("Stopped Interview.");
    // Release the Parakeet model immediately rather than waiting for the idle
    // timeout: the interview is over, and on an 8 GB laptop held during a call
    // the resident memory is worth having back now.
    if (import.meta.env.DEV && useStore.getState().settings.asrCompareParakeet) {
      void unloadParakeetModel();
    }
    // The ONLY path that releases the context. It must not also call
    // `.close()` on the legacy handle, or the same AudioContext is closed twice.
    teardownRef.current?.();
    (window as any)._interviewStreams = null;
    resetAudioStatus();
    restartingRef.current = false;
  };

  // ── Start/Stop hotkey bridge ─────────────────────────────────────────────
  // Publish the current controls so `Home.tsx`'s global shortcut can drive
  // capture without owning the hook. Registered once; the getters read live
  // values through refs.
  stopRef.current = stopInterview;
  useEffect(() => {
    registerInterviewControls({
      start: () => {
        void startRef.current();
      },
      stop: () => stopRef.current(),
      isRecording: () => isRecordingRef.current,
      canStart: () => modelReadyRef.current,
    });
    return () => registerInterviewControls(null);
  }, []);

  // A Start/Stop press that arrived while the ASR model was still loading (or
  // while this hook was unmounted) is honoured as soon as it can be.
  useEffect(() => {
    if (isModelReady && consumePendingStart()) {
      void startRef.current();
    }
  }, [isModelReady]);

  return {
    messages,
    interim,
    isRecording,
    logs,
    debugAudios,
    /** Whether the dev-only WAV dump is currently recording. */
    debugWavOn,
    /**
     * Opt in/out of the debug WAV dump. Dev builds only — a production build
     * refuses the request, so this can never start recording interview audio
     * in a shipped app.
     */
    setDebugWav: (on: boolean) => {
      setDebugWavEnabled(on);
      setDebugWavOn(isDebugWavEnabled());
      addLog(
        on
          ? "Debug WAV recording ON — captured audio is being held in memory as local blob URLs. Nothing is uploaded or written to disk automatically."
          : "Debug WAV recording OFF.",
      );
    },
    isModelReady,
    downloadProgress,
    startInterview,
    stopInterview,
    /**
     * The bounded ASR drain barrier. `Home.tsx` awaits this before reading the
     * transcript on `Ctrl+Enter`, so a final that is still decoding cannot make
     * the submitted question miss its last words.
     */
    drainAsr,
  };
}

// Resample to Moonshine's native 16 kHz using OfflineAudioContext, which applies
// a proper anti-aliasing filter. The previous version dropped every Nth sample
// with no filtering, which aliased high frequencies and hurt accuracy.
async function resampleTo16k(
  audioBuffer: Float32Array,
  originalSampleRate: number,
  targetSampleRate = 16000,
): Promise<Float32Array> {
  if (originalSampleRate === targetSampleRate || audioBuffer.length === 0) {
    return audioBuffer;
  }
  const length = Math.max(
    1,
    Math.ceil((audioBuffer.length * targetSampleRate) / originalSampleRate),
  );
  const offline = new OfflineAudioContext(1, length, targetSampleRate);
  const buffer = offline.createBuffer(
    1,
    audioBuffer.length,
    originalSampleRate,
  );
  // `copyToChannel` is typed as taking `Float32Array<ArrayBuffer>`; the plain
  // `Float32Array` alias is `Float32Array<ArrayBufferLike>` under TS 5.7. The
  // buffer here is always a real ArrayBuffer-backed view, so the cast is safe.
  buffer.copyToChannel(audioBuffer as Float32Array<ArrayBuffer>, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

// AudioWorklet VAD Implementation
function setupVADWorklet(
  audioCtx: AudioContext,
  sourceNode: AudioNode,
  sourceName: "mic" | "system",
  workerRef: React.MutableRefObject<Worker | null>,
  addLog: (msg: string) => void,
  addDebugAudio: (name: string, url: string) => void,
  onLevel: (sample: { rms: number; peak: number; speaking: boolean }) => void,
  onPhraseEnd: () => void,
  /**
   * Called the moment a final is handed to the worker, before the post.
   * Feeds the renderer's own in-flight count, which is what the drain barrier
   * re-checks between flush attempts.
   */
  onFinalQueued: () => void,
  /**
   * Optional second-engine comparison. Fires with the SAME buffer Moonshine
   * receives, so both engines transcribe identical audio.
   */
  onCompareWithDeepgram: (
    audio: Float32Array,
    speechSeconds: number,
    phraseId: number,
  ) => void,
  /**
   * Optional third-engine comparison. Fires with the SAME buffer as the other
   * engines so all three transcribe identical audio.
   */
  onCompareWithGroq: (
    audio: Float32Array,
    speechSeconds: number,
    phraseId: number,
  ) => void,
  /**
   * Optional fourth engine (local Parakeet, dev comparison only). Fires with
   * the SAME buffer as the other engines.
   */
  onCompareWithParakeet: (
    audio: Float32Array,
    speechSeconds: number,
    phraseId: number,
  ) => void,
) {
  const workletNode = new AudioWorkletNode(audioCtx, "vad-processor");

  sourceNode.connect(workletNode);
  // The worklet only processes while it is pulled by the graph, so it must
  // reach the destination — but route it through a 0-gain node so the captured
  // system audio is NOT played back (otherwise it echoes for the user).
  const silentSink = audioCtx.createGain();
  silentSink.gain.value = 0;
  workletNode.connect(silentSink);
  silentSink.connect(audioCtx.destination);

  // Highest phrase id we've already finalized. Partials that arrive after their
  // phrase ended must not resurrect a stale interim line.
  let lastClosedPhraseId = -1;

  workletNode.port.onmessage = async (e) => {
    if (e.data.type === "log") {
      addLog(e.data.message);
      return;
    }
    if (e.data.type === "level") {
      onLevel({
        rms: (e.data.rms as number) ?? 0,
        peak: (e.data.peak as number) ?? 0,
        speaking: !!e.data.speaking,
      });
      return;
    }

    const phraseId = (e.data.phraseId as number) ?? 0;

    // A phrase was closed by the worklet, whether or not it produced audio.
    // Without this, a discarded phrase left its interim text on screen and the
    // gate saw "interviewer still speaking" indefinitely.
    if (e.data.type === "phraseClosed") {
      lastClosedPhraseId = phraseId;
      onPhraseEnd();
      return;
    }

    // ---- Interim snapshot: transcribe the utterance so far, best-effort ----
    if (e.data.type === "partial") {
      if (phraseId <= lastClosedPhraseId) return;
      const merged = e.data.buffer as Float32Array;
      const speechSeconds =
        (e.data.seconds as number) || merged.length / audioCtx.sampleRate;
      if (speechSeconds < 0.3) return;
      try {
        const downsampled = await resampleTo16k(
          merged,
          audioCtx.sampleRate,
          16000,
        );
        workerRef.current?.postMessage({
          type: "partial",
          audio: downsampled,
          source: sourceName,
          phraseId,
        });
      } catch (err) {
        addLog(`Resample failed: ${err}`);
      }
      return;
    }

    if (e.data.type !== "speech") return;

    // ---- Phrase finished: commit the final transcript ----
    lastClosedPhraseId = phraseId;
    onPhraseEnd(); // drop the interim line; the final result supersedes it

    const merged = e.data.buffer as Float32Array;
    // Use the worklet's measured speech time (the buffer also contains the
    // trailing pause, which would otherwise inflate this).
    const speechSeconds =
      (e.data.seconds as number) || merged.length / audioCtx.sampleRate;

    if (speechSeconds < 0.3) {
      addLog(`Speech too short (${speechSeconds.toFixed(2)}s), discarding`);
      return;
    }

    try {
      const downsampled = await resampleTo16k(
        merged,
        audioCtx.sampleRate,
        16000,
      );

      // ── Do not send near-silence to the ASR ───────────────────────────
      // The VAD already gated on RMS, but a long stretch of very low level
      // audio still reaches here and Moonshine reliably hallucinates on it
      // ("(no speech recognised)", invented words). Re-check after resampling
      // and skip. Deliberately permissive (0.003) so only genuinely silent
      // buffers are dropped.
      const { rms, peak } = analyseLevels(downsampled);
      const durationMs = Math.round(
        (downsampled.length / 16000) * 1000,
      );

      console.log(
        `[ASR] source=${sourceName} sampleRate=16000 channels=1 durationMs=${durationMs} rms=${rms.toFixed(5)} peak=${peak.toFixed(4)} samples=${downsampled.length} phraseId=${phraseId}`,
      );

      if (rms < MIN_SEND_RMS || peak < MIN_SEND_PEAK) {
        // Nothing usable here — drop the interim line so the UI stops saying
        // "transcribing" for a segment that will never produce text.
        onPhraseEnd();
        console.warn(
          `[ASR] ignored silent segment — rms=${rms.toFixed(5)} peak=${peak.toFixed(4)} below floor`,
        );
        addLog(
          `Ignored a silent ${durationMs}ms clip (rms ${rms.toFixed(4)}) — nothing to transcribe.`,
        );
        return;
      }

      // ── Debug WAV (dev-only, opt-in) ───────────────────────────────────
      // The recording is the ground truth for "what did the ASR actually
      // receive", so it must not be produced by default: it is the interviewer's
      // voice, written to a local blob. Production builds compile this out, and
      // a dev session must still opt in explicitly.
      //
      // It is also where clipping becomes visible — the writer reports
      // out-of-full-scale samples instead of quietly flattening them.
      let audioUrl: string | undefined;
      if (isDebugWavEnabled()) {
        const { blob, clipping } = float32ToWavWithClipping(downsampled, 16000);
        audioUrl = URL.createObjectURL(blob);
        const debugName = `${sourceName} - ${speechSeconds.toFixed(1)}s`;
        addDebugAudio(debugName, audioUrl);
        const clippingNote = describeClipping(clipping);
        // Amplitude statistics only. Never the audio itself, never a path.
        console.log(
          `[ASR] debug wav ${debugName} durationMs=${durationMs} ${clippingNote}`,
        );
        if (clipping.clippedSamples > 0) {
          // A clipped take is unusable as a corpus sample AND means the capture
          // path is losing signal — say so rather than filing it silently.
          console.warn(
            `[ASR] captured audio is clipping — ${clipping.clippedSamples} samples over full scale. Gain staging / headroom is needed before this is usable as evidence.`,
          );
        }
      }

      addLog(
        `Captured ${speechSeconds.toFixed(1)}s (rms ${rms.toFixed(
          3,
        )}, peak ${peak.toFixed(3)}), sending to AI...`,
      );
      // A final segment is now decoding — surface that in the status bar.
      setAudioStatus("transcribing");

      // ── Optional second/third engines (comparison only) ───────────────
      // Hand the SAME buffer to Deepgram and Groq Whisper so all engines
      // transcribe identical audio. Not awaited: neither must delay the local
      // engine, and their failures must never affect the Moonshine path.
      onCompareWithDeepgram(downsampled, speechSeconds, phraseId);
      onCompareWithGroq(downsampled, speechSeconds, phraseId);
      onCompareWithParakeet(downsampled, speechSeconds, phraseId);

      // Count it as owed BEFORE posting, so there is no window in which a
      // hotkey pressed between this line and the post sees an empty queue.
      onFinalQueued();
      workerRef.current?.postMessage({
        type: "transcribe",
        audio: downsampled,
        source: sourceName,
        audioUrl,
        phraseId,
      });
    } catch (err) {
      addLog(`Resample failed: ${err}`);
    }
  };
}
