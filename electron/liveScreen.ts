/**
 * Live Screen — the main-process controller.
 *
 * ── Why the loop lives in main, not the renderer ───────────────────────────
 * The pixels never have to cross a process boundary. The renderer sends a
 * region and an on/off flag, and receives text and a status. A frame is
 * captured into main-process memory, reduced to a 256-byte signature, and
 * handed to OCR — and then it is gone. The renderer cannot log it, cannot put
 * it in history, and cannot accidentally attach it to an AI request, because it
 * never sees it.
 *
 * ── The single rule ────────────────────────────────────────────────────────
 * THIS NEVER CALLS AI. It captures, compares and reads text. Only an
 * interviewer question triggers the answer pipeline; a screen that changes ten
 * times produces ten local OCR reads and zero network requests.
 *
 * ── Yielding to transcription ──────────────────────────────────────────────
 * Parakeet is the memory hog in this app, and a missed context refresh costs a
 * vaguer answer while a missed transcription costs the interview. So the
 * controller asks the policy before it even captures, and the policy's very
 * first guard after the on/off checks is "is transcription live".
 */

import {
  applyControls,
  buildFrameSignature,
  createLiveScreenState,
  liveScreenStatus,
  pollFrame,
  recordRead,
  recordReadError,
  setRegion,
  LIVE_SCREEN_POLL_MS,
  type ScreenRegion,
} from "../src/lib/liveScreenContext";
import { readSystemMemory } from "../src/lib/systemMemory";
import { captureRegionBgra } from "./capture";
import { isOcrAvailable, recognizeBgraSync } from "./windowsOcr";

/** What the renderer is told when the active problem should change. */
export interface LiveScreenProblemUpdate {
  /** The confirmed problem statement to store, or null to leave it alone. */
  problemText: string | null;
  /** Why the problem did or did not change. Safe to show and to log. */
  reason: string;
}

/** A status snapshot. Contains no pixels and no screen text. */
export interface LiveScreenSnapshot {
  enabled: boolean;
  region: ScreenRegion | null;
  on: string;
  regionLabel: string;
  ocrLabel: string;
  contextLabel: string;
  /** True when the local OCR engine can run on this machine. */
  ocrAvailable: boolean;
  /** Why OCR is unavailable, when it is. */
  ocrUnavailableReason: string | null;
  polls: number;
  reads: number;
  framesSkipped: number;
  lastError: string | null;
}

export interface LiveScreenOptions {
  /** Called when a read changes (or fails to change) the active problem. */
  onProblem?: (update: LiveScreenProblemUpdate) => void;
  /** Called after every poll, so the UI can show the live reason. */
  onStatus?: () => void;
}

let state = createLiveScreenState();
let timer: NodeJS.Timeout | null = null;

/**
 * Whether transcription is currently live.
 *
 * Supplied by the renderer, which owns the interview session. It is a proxy for
 * "the ASR path is active" rather than a literal decode-in-progress flag,
 * because the decoder runs in a separate worker; being conservative here costs
 * a skipped context refresh, which is the cheap direction to be wrong in.
 */
let asrBusy = false;

/** Guards against a slow read overlapping the next tick. */
let tickInFlight = false;

const options: LiveScreenOptions = {};

/** Point the controller at its listeners. Call once, at startup. */
export function initLiveScreen(next: LiveScreenOptions): void {
  options.onProblem = next.onProblem;
  options.onStatus = next.onStatus;
}

/** Replace the region and/or the on/off state, and (re)start the timer. */
export function configureLiveScreen(config: {
  region?: ScreenRegion | null;
  enabled?: boolean;
}): void {
  if (config.region !== undefined) {
    state = setRegion(state, config.region);
  }
  state = applyControls(state, {
    enable: config.enabled ?? state.enabled,
    clearRegion: config.region === null,
  });

  stopTimer();
  if (state.enabled && state.region) startTimer();
  options.onStatus?.();
}

/** Tell the controller whether transcription is live. */
export function setLiveScreenAsrBusy(busy: boolean): void {
  asrBusy = busy;
}

function startTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, LIVE_SCREEN_POLL_MS);
}

function stopTimer(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Reset Interview: forget the region, the text, and the history — but keep the
 * toggle as the user left it, because whether Live Screen is on is a preference
 * about how they work, not a fact about the problem.
 */
export function resetLiveScreen(): void {
  stopTimer();
  state = applyControls(state, { enable: state.enabled, clearRegion: true });
  options.onStatus?.();
}

/** Stop the loop entirely, e.g. on app quit. */
export function disposeLiveScreen(): void {
  stopTimer();
}

async function tick(): Promise<void> {
  if (tickInFlight) return;
  if (!state.enabled || !state.region) return;

  tickInFlight = true;
  const region = state.region;
  try {
    const frame = captureRegionBgra(region);
    const signature = buildFrameSignature(frame.bgra, frame.width, frame.height);

    const memory = readSystemMemory();
    const { state: polled, decision } = pollFrame(state, signature, {
      now: Date.now(),
      parakeetDecoding: asrBusy,
      freeRamMb: memory.availableMb,
    });
    state = polled;

    if (decision.runOcr) {
      await readRegion(region, frame.bgra, frame.width, frame.height);
    }
    options.onStatus?.();
  } catch (err) {
    // A failed capture must never disturb the audio path or the context the
    // candidate is working on. Record it and keep going.
    state = recordReadError(
      state,
      err instanceof Error ? err.message : "region capture failed",
      Date.now(),
    );
    options.onStatus?.();
  } finally {
    tickInFlight = false;
  }
}

async function readRegion(
  region: ScreenRegion,
  bgra: Buffer,
  width: number,
  height: number,
): Promise<void> {
  try {
    const text = recognizeBgraSync(bgra, width, height);
    const { state: next, outcome } = recordRead(state, text, {
      now: Date.now(),
      activeProblem: null,
    });
    state = next;
    options.onProblem?.({
      problemText: outcome.promote ? outcome.problemText : null,
      reason: outcome.reason,
    });
  } catch (err) {
    state = recordReadError(
      state,
      err instanceof Error ? err.message : "local OCR failed",
      Date.now(),
    );
  }
}

/** A snapshot for the renderer. Safe to serialise: no pixels, no screen text. */
export function getLiveScreenSnapshot(): LiveScreenSnapshot {
  const status = liveScreenStatus(state);
  return {
    enabled: state.enabled,
    region: state.region,
    on: status.on,
    regionLabel: status.region,
    ocrLabel: status.ocr,
    contextLabel: status.context,
    ocrAvailable: isOcrAvailable(),
    ocrUnavailableReason: state.lastError,
    polls: state.polls,
    reads: state.reads,
    framesSkipped: state.framesSkipped,
    lastError: state.lastError,
  };
}