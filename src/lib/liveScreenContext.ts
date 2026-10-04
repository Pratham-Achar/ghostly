/**
 * Live Screen — the policy layer for watching a screen region and keeping the
 * active problem fresh.
 *
 * ── What this module is, and what it is not ────────────────────────────────
 * This is ALL of the decision-making for Live Screen, expressed as pure
 * functions over a state object. It contains no timers, no capture, no OCR and
 * no Electron: the caller drives it. That split is deliberate, because the
 * whole risk of this feature is that it competes with Parakeet for a
 * memory-constrained machine, and logic that can be exercised 200 times in a
 * unit test is logic that will not quietly steal the CPU at 2 a.m.
 *
 * ── The core idea: a screenshot is almost never a change ───────────────────
 * The interviewer's screen changes constantly — a cursor blinks, a terminal
 * redraws, the page scrolls by one line. If any of that triggered a read, the
 * feature would OCR constantly and burn the machine for nothing. So the pipeline
 * is gated three times, in increasing order of cost:
 *
 *   1. CHANGE     — a 16×16 luma grid, ~256 samples. Sub-millisecond. An
 *                   unchanged region costs this and nothing else.
 *   2. STABILITY  — the new content must repeat for {@link LIVE_SCREEN_STABLE_POLLS}
 *                   consecutive polls before it is believed. This is what stops
 *                   a half-scrolled frame from being read as a new problem.
 *   3. BUDGET     — rate cap, minimum gap, and available RAM.
 *
 * OCR runs only after all three pass.
 *
 * ── The rule that matters most ─────────────────────────────────────────────
 * WHEN UNCERTAIN, KEEP THE EXISTING activeProblem. A missing context costs a
 * slightly vaguer answer. A wrong one makes the model answer "why did you use a
 * HashSet?" about a problem that has nothing to do with hash sets. So every
 * ambiguous case here resolves to "do not promote".
 *
 * ── Privacy ────────────────────────────────────────────────────────────────
 * Nothing here writes a file, logs a pixel, or calls a network API. Frames are
 * reduced to a 256-byte signature the moment they arrive; OCR text is kept in
 * memory only, exactly like the rest of the session context.
 */

import { threadContentWords } from "./conversationThread";
import { clipProblemText } from "./sessionContext";
import { Buffer } from "node:buffer";

// ── Timing ──────────────────────────────────────────────────────────────────

/**
 * How often the region is sampled, in ms.
 *
 * ~2s as specified. Slower would make the context stale behind a fast
 * interviewer; faster buys nothing, because the stability gate would reject the
 * extra frames anyway.
 */
export const LIVE_SCREEN_POLL_MS = 2000;

// ── Change detection ────────────────────────────────────────────────────────

/**
 * Samples per axis in the luma signature: 16×16 = 256 bytes per frame.
 *
 * Deliberately coarse. Fine enough that replacing a paragraph of text moves
 * many cells, coarse enough that antialiasing and a blinking cursor do not.
 */
export const LIVE_SCREEN_GRID = 16;

/**
 * Mean absolute luma difference (0–255) at which a frame counts as changed.
 *
 * 3.0 is low enough to catch a single line of text changing and high enough
 * that a cursor blink or a shadow does not trip it.
 */
export const LIVE_SCREEN_CHANGE_THRESHOLD = 3;

/**
 * Consecutive identical polls required before a change is believed.
 *
 * Two, i.e. the content must hold still across one full poll interval. This is
 * the whole defence against reading a frame that is mid-scroll.
 */
export const LIVE_SCREEN_STABLE_POLLS = 2;

// ── Budget ──────────────────────────────────────────────────────────────────

/** Hard cap on reads per rolling minute, regardless of what changed. */
export const LIVE_SCREEN_MAX_OCR_PER_MINUTE = 6;

/**
 * Minimum gap between two reads, in ms.
 *
 * 1.5s — slightly under one poll interval, so the cap and the gap agree with
 * each other instead of one silently dominating the other.
 */
export const LIVE_SCREEN_MIN_OCR_GAP_MS = 1500;

/**
 * Available RAM below which OCR is skipped, in MB.
 *
 * Parakeet is the memory hog in this app and transcription matters more than
 * context freshness, so a tight machine loses OCR refreshes, never audio.
 */
export const LIVE_SCREEN_MIN_FREE_RAM_MB = 512;

// ── Text rules ──────────────────────────────────────────────────────────────

/** Text shorter than this is never treated as a problem statement. */
export const LIVE_SCREEN_MIN_PROBLEM_CHARS = 20;

/** At most this many OCR lines are joined into one problem statement. */
export const LIVE_SCREEN_MAX_PROBLEM_LINES = 4;

/**
 * Overlap at or above which two texts are "the same problem".
 *
 * 0.5 means half of the shorter text's content words appear in the other.
 */
export const LIVE_SCREEN_SAME_TEXT_OVERLAP = 0.5;

// ── Types ───────────────────────────────────────────────────────────────────

/** A screen rectangle in DEVICE pixels (not CSS pixels). */
export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A cheap perceptual fingerprint of one frame: one luminance byte per grid
 * cell. 256 bytes, so keeping the previous one costs nothing.
 */
export type FrameSignature = Uint8Array;

export interface LiveScreenState {
  region: ScreenRegion | null;
  enabled: boolean;
  /** Signature of the previous poll, kept only for change measurement. */
  lastSignature: FrameSignature | null;
  /**
   * The content currently "in effect" — what was last read, or the baseline.
   *
   * This is what `changed` is measured against. Measuring against the previous
   * FRAME instead would report the second sighting of new content as
   * "unchanged", and the read would never fire.
   */
  settledSignature: FrameSignature | null;
  /** Content currently being watched for stability before it is believed. */
  candidateSignature: FrameSignature | null;
  /** Consecutive polls the candidate signature has held. */
  stableCount: number;
  /** When the last read ran. 0 means "never". */
  lastOcrAt: number;
  /** Start of the current rate-limit window. */
  windowStart: number;
  ocrRunsInWindow: number;
  /** Text produced by the last successful read. In memory only. */
  lastText: string | null;
  /** Last OCR failure, for the diagnostic readout. Never a pixel. */
  lastError: string | null;
  /** Counters for the performance report. */
  polls: number;
  reads: number;
  framesSkipped: number;
}

export function createLiveScreenState(): LiveScreenState {
  return {
    region: null,
    enabled: false,
    lastSignature: null,
    settledSignature: null,
    candidateSignature: null,
    stableCount: 0,
    lastOcrAt: 0,
    windowStart: 0,
    ocrRunsInWindow: 0,
    lastText: null,
    lastError: null,
    polls: 0,
    reads: 0,
    framesSkipped: 0,
  };
}

// ── Frame signature ─────────────────────────────────────────────────────────

/**
 * Reduce a BGRA frame to a {@link FrameSignature}.
 *
 * Samples a bounded number of pixels per cell rather than averaging the whole
 * cell, so the cost is fixed by {@link LIVE_SCREEN_GRID} and not by the
 * resolution of the region.
 */
export function buildFrameSignature(
  bgra: Buffer,
  width: number,
  height: number,
): FrameSignature {
  const cells = LIVE_SCREEN_GRID;
  const signature = new Uint8Array(cells * cells);
  const samplesPerAxis = 3;
  const step = Math.max(1, Math.floor(samplesPerAxis / 1));

  for (let gy = 0; gy < cells; gy++) {
    const y0 = Math.floor((gy * height) / cells);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor(((gy + 1) * height) / cells)));
    for (let gx = 0; gx < cells; gx++) {
      const x0 = Math.floor((gx * width) / cells);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor(((gx + 1) * width) / cells)));

      let total = 0;
      let count = 0;
      const yStep = Math.max(1, Math.floor((y1 - y0) / samplesPerAxis));
      const xStep = Math.max(1, Math.floor((x1 - x0) / samplesPerAxis));
      for (let y = y0; y < y1; y += yStep) {
        for (let x = x0; x < x1; x += xStep) {
          const i = (y * width + x) * 4;
          // Rec. 601 luma. Alpha is ignored, matching BitmapAlphaMode.Ignore.
          total += 0.299 * bgra[i] + 0.587 * bgra[i + 1] + 0.114 * bgra[i + 2];
          count++;
        }
      }
      signature[gy * cells + gx] = count > 0 ? Math.round(total / count) : 0;
    }
  }
  void step;
  return signature;
}

/** Mean absolute difference between two signatures, 0–255. */
export function signatureDifference(
  a: FrameSignature | null,
  b: FrameSignature | null,
): number | null {
  if (!a || !b || a.length !== b.length) return null;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

// ── Polling ─────────────────────────────────────────────────────────────────

export type LiveScreenSkipReason =
  | "live screen is off"
  | "no region selected"
  | "parakeet is decoding"
  | "region unchanged"
  | "waiting for the region to settle"
  | "too soon after the last read"
  | "read rate capped"
  | "low memory"
  | "ready to read";

export interface LiveScreenDecision {
  /** Should a frame be captured at all? */
  capture: boolean;
  /** Did the region change since the previous poll? */
  changed: boolean;
  /** Should local OCR run on the frame we just took? */
  runOcr: boolean;
  reason: LiveScreenSkipReason;
  /** Measured luma difference, or null when there is nothing to compare to. */
  difference: number | null;
}

export interface LiveScreenPollInput {
  now: number;
  /** True while Parakeet is actively decoding — OCR yields to transcription. */
  parakeetDecoding: boolean;
  /** Available RAM in MB, from `readSystemMemory()`. */
  freeRamMb: number;
}

/**
 * Decide what to do with one sampled frame.
 *
 * The order of the guards is the design:
 *
 *   OFF → REGION → PARAKEET → CHANGE → STABILITY → GAP → RATE → RAM
 *
 * Parakeet comes before the cheap checks on purpose. If transcription is
 * active the frame is not even captured, so this feature cannot add latency to
 * the path that matters. The RAM guard sits last among the budget checks
 * because a rate-limited skip is the cheaper outcome anyway.
 */
export function pollFrame(
  state: LiveScreenState,
  signature: FrameSignature,
  input: LiveScreenPollInput,
): { state: LiveScreenState; decision: LiveScreenDecision } {
  const skip = (
    reason: LiveScreenSkipReason,
    capture: boolean,
    difference: number | null = null,
    state2: LiveScreenState = state,
  ) => ({ state: state2, decision: { capture, changed: false, runOcr: false, reason, difference } });

  if (!state.enabled) return skip("live screen is off", false);
  if (!state.region) return skip("no region selected", false);

  if (input.parakeetDecoding) {
    return skip("parakeet is decoding", false, null, {
      ...state,
      polls: state.polls + 1,
      framesSkipped: state.framesSkipped + 1,
    });
  }

  // "Changed" means "different from the content currently in effect".
  // `null` on the very first poll, when there is nothing in effect yet.
  const settledDelta = signatureDifference(state.settledSignature, signature);
  const changed = settledDelta === null || settledDelta >= LIVE_SCREEN_CHANGE_THRESHOLD;

  // Stability is tracked against a CANDIDATE signature, separately from the
  // content in effect: a frame differs from the content in effect while it is
  // still settling, and those two facts must not be the same test.
  let candidate = state.candidateSignature;
  let stableCount: number;
  const candidateDelta = signatureDifference(candidate, signature);
  if (candidateDelta === null || candidateDelta >= LIVE_SCREEN_CHANGE_THRESHOLD) {
    candidate = signature;
    stableCount = 1;
  } else {
    stableCount = state.stableCount + 1;
  }

  let next: LiveScreenState = {
    ...state,
    polls: state.polls + 1,
    lastSignature: signature,
    candidateSignature: candidate,
    stableCount,
  };

  // Rate-limit window rollover.
  if (input.now - next.windowStart >= 60_000) {
    next = { ...next, windowStart: input.now, ocrRunsInWindow: 0 };
  }

  const done = (
    runOcr: boolean,
    reason: LiveScreenSkipReason,
  ): { state: LiveScreenState; decision: LiveScreenDecision } => ({
    state: runOcr ? next : { ...next, framesSkipped: next.framesSkipped + 1 },
    decision: { capture: true, changed, runOcr, reason, difference: settledDelta },
  });

  if (!changed) return done(false, "region unchanged");
  if (stableCount < LIVE_SCREEN_STABLE_POLLS) {
    return done(false, "waiting for the region to settle");
  }
  if (input.now - next.lastOcrAt < LIVE_SCREEN_MIN_OCR_GAP_MS) {
    return done(false, "too soon after the last read");
  }
  if (next.ocrRunsInWindow >= LIVE_SCREEN_MAX_OCR_PER_MINUTE) {
    return done(false, "read rate capped");
  }
  if (input.freeRamMb < LIVE_SCREEN_MIN_FREE_RAM_MB) {
    return done(false, "low memory");
  }

  // The read is going ahead, so this content becomes the content in effect.
  // Recording the moment it STARTS means a slow read still occupies its slot in
  // the rate window and cannot be followed immediately by another.
  next = {
    ...next,
    settledSignature: signature,
    lastOcrAt: input.now,
    ocrRunsInWindow: next.ocrRunsInWindow + 1,
  };
  return { state: next, decision: { capture: true, changed, runOcr: true, reason: "ready to read", difference: settledDelta } };
}

// ── Reading the result ──────────────────────────────────────────────────────

/**
 * Structural vocabulary of a problem statement.
 *
 * Imperatives, "given", and I/O words. This is the grammar of stating work to
 * be done, NOT a list of topics: "given an array" and "given a linked list"
 * match for the same reason, and no algorithm name appears here.
 */
const PROBLEM_STATEMENT_CUES: RegExp[] = [
  /\bgiven\b/i,
  /\b(?:write|implement|solve|design|code|build)\s+(?:a|an|the|your|me)\b/i,
  /\b(?:find|return|compute|determine|calculate|count|print)\b/i,
  /\b(?:example|input|output|constraints?|sample|case)\b/i,
  /\b(?:array|list|string|matrix|graph|tree|integer|number|element)\b/i,
  /\b(?:time|space)\s+complexity\b/i,
  /\bhow\s+(?:would|do|can|will)\s+you\b/i,
];

/** True when the text reads like a problem statement rather than chrome. */
export function looksLikeProblemStatement(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length < LIVE_SCREEN_MIN_PROBLEM_CHARS) return false;
  return PROBLEM_STATEMENT_CUES.some((re) => re.test(t));
}

/**
 * Pull a problem statement out of OCR text.
 *
 * OCR returns whatever was on screen, including a taskbar, a line number column
 * and half a code block. Rather than trying to understand the layout, this
 * keeps the lines that carry problem vocabulary and joins them.
 *
 * @returns the statement, or null when nothing on screen reads as one.
 */
export function extractProblemStatement(text: string): string | null {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 3)
    // Drop obvious chrome: bare punctuation, numbers and single symbols.
    .filter((line) => /[a-z]/i.test(line));

  const scored = lines
    .map((line, index) => ({
      line,
      index,
      score: PROBLEM_STATEMENT_CUES.filter((re) => re.test(line)).length,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, LIVE_SCREEN_MAX_PROBLEM_LINES)
    // Restore reading order — the screen's order is the author's order.
    .sort((a, b) => a.index - b.index);

  if (scored.length === 0) return null;
  const joined = scored.map((entry) => entry.line).join(" ").trim();
  if (!looksLikeProblemStatement(joined)) return null;
  return clipProblemText(joined);
}

/**
 * Fraction of `a`'s content words that also appear in `b`.
 *
 * Reuses the conversation-thread tokenizer so both layers agree on what a
 * content word is; a second, slightly different tokenizer would make the two
 * similarity numbers disagree for no visible reason.
 */
export function textSimilarity(a: string, b: string): number {
  const left = threadContentWords(a ?? "");
  if (left.length === 0) return 0;
  const right = new Set(threadContentWords(b ?? ""));
  if (right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return Math.round((shared / left.length) * 1000) / 1000;
}

export type LiveScreenPromoteReason =
  | "new problem on screen"
  | "no text on screen"
  | "same text as the previous read"
  | "no problem statement found"
  | "same problem as the active context"
  | "text is too short to be a problem";

export interface LiveScreenOutcome {
  promote: boolean;
  reason: LiveScreenPromoteReason;
  /** The text to store as the active problem. Only set when promoting. */
  problemText: string | null;
}

export interface RecordReadInput {
  now: number;
  /** The problem already held in session context, for the "same problem" test. */
  activeProblem: string | null;
}

/**
 * Decide what a completed read means for the active problem.
 *
 * Two "same" tests, and both of them refuse a change:
 *
 *   • same as the PREVIOUS READ — the screen settled on something already seen.
 *     This is what stops a region that keeps re-rendering from re-promoting on
 *     every poll.
 *   • same as the ACTIVE PROBLEM — the screen is showing the same problem with
 *     a different crop or a scrolled example. Scrolling must not replace the
 *     problem with "Example: Input: [1,2,3,2]".
 */
export function recordRead(
  state: LiveScreenState,
  text: string,
  input: RecordReadInput,
): { state: LiveScreenState; outcome: LiveScreenOutcome } {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  const settled: LiveScreenState = {
    ...state,
    reads: state.reads + 1,
    lastText: clean || null,
    lastError: null,
    lastOcrAt: input.now,
  };

  if (clean.length === 0) {
    return {
      state: settled,
      outcome: { promote: false, reason: "no text on screen", problemText: null },
    };
  }

  if (state.lastText && textSimilarity(clean, state.lastText) >= LIVE_SCREEN_SAME_TEXT_OVERLAP) {
    return {
      state: settled,
      outcome: {
        promote: false,
        reason: "same text as the previous read",
        problemText: null,
      },
    };
  }

  if (clean.length < LIVE_SCREEN_MIN_PROBLEM_CHARS) {
    return {
      state: settled,
      outcome: {
        promote: false,
        reason: "text is too short to be a problem",
        problemText: null,
      },
    };
  }

  const statement = extractProblemStatement(clean);
  if (!statement) {
    return {
      state: settled,
      outcome: {
        promote: false,
        reason: "no problem statement found",
        problemText: null,
      },
    };
  }

  if (
    input.activeProblem &&
    textSimilarity(statement, input.activeProblem) >= LIVE_SCREEN_SAME_TEXT_OVERLAP
  ) {
    return {
      state: settled,
      outcome: {
        promote: false,
        reason: "same problem as the active context",
        problemText: null,
      },
    };
  }

  return {
    state: settled,
    outcome: { promote: true, reason: "new problem on screen", problemText: statement },
  };
}

/**
 * Record a failed read.
 *
 * The previous context is deliberately left completely untouched — a failed OCR
 * must not blank the problem the candidate is currently working on.
 */
export function recordReadError(
  state: LiveScreenState,
  message: string,
  now: number,
): LiveScreenState {
  return {
    ...state,
    lastError: message,
    lastOcrAt: now,
    // `lastText` is deliberately preserved: the screen did not change, so the
    // previous reading is still the best description of it.
  };
}

// ── Region ──────────────────────────────────────────────────────────────────

/** Reject rectangles that cannot be captured or would mean nothing to OCR. */
export function isValidRegion(region: ScreenRegion | null): region is ScreenRegion {
  if (!region) return false;
  return (
    Number.isFinite(region.x) &&
    Number.isFinite(region.y) &&
    Number.isFinite(region.width) &&
    Number.isFinite(region.height) &&
    region.width > 0 &&
    region.height > 0
  );
}

export interface LiveScreenControls {
  enable: boolean;
  clearRegion: boolean;
}

/**
 * Apply the ON/OFF control and Reset, as one function.
 *
 * Reset Interview clears the region AND the learned text, so a new session
 * cannot inherit a problem read off the previous one's screen.
 */
export function applyControls(
  state: LiveScreenState,
  controls: LiveScreenControls,
): LiveScreenState {
  let next = state;
  if (controls.clearRegion) {
    next = {
      ...createLiveScreenState(),
      enabled: state.enabled,
    };
  }
  if (controls.enable !== state.enabled) {
    // Turning the toggle either way forgets the frame history, so a stale
    // signature cannot make the first poll after a toggle look "unchanged".
    next = { ...next, enabled: controls.enable, lastSignature: null, settledSignature: null, candidateSignature: null, stableCount: 0 };
  }
  return next;
}

/** Remember the selected region for this session. Never persisted. */
export function setRegion(
  state: LiveScreenState,
  region: ScreenRegion | null,
): LiveScreenState {
  return {
    ...state,
    region,
    lastSignature: null,
    settledSignature: null,
    candidateSignature: null,
    stableCount: 0,
  };
}

// ── Display ─────────────────────────────────────────────────────────────────

/** The exact strings the indicator shows. Part 13A. */
export function liveScreenStatus(state: LiveScreenState): {
  on: string;
  region: string;
  ocr: string;
  context: string;
} {
  return {
    on: `LIVE SCREEN: ${state.enabled ? "ON" : "OFF"}`,
    region: isValidRegion(state.region) ? "Region: Selected" : "Region: None",
    ocr: "OCR: Local",
    context: state.lastText ? "Context: Active" : "Context: None",
  };
}