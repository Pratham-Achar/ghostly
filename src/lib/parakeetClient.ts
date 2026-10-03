/**
 * The renderer-side Parakeet comparison client.
 *
 * ── What this is allowed to do ─────────────────────────────────────────────
 * Submit one already-captured 16 kHz `Float32Array` — the exact buffer Moonshine
 * received — and receive a transcript for the developer comparison table. That
 * is the whole surface.
 *
 * ── What it is NOT ─────────────────────────────────────────────────────────
 * Parakeet is a DEVELOPMENT COMPARISON ENGINE. It is never the production
 * default and never a fallback for Moonshine. Its transcript goes to the
 * isolated `asrComparisons` slice ONLY: it is never added to
 * `interviewMessages`, never passed to the question gate, never corrected into
 * the transcript, and never included in a prompt. There is deliberately no
 * function here that can do any of those things.
 *
 * ── Never throws ───────────────────────────────────────────────────────────
 * Every failure path reports through `onError` (or returns a result object).
 * A comparison engine that can interrupt an interview would be worse than no
 * comparison at all, so no failure here is allowed to propagate into the
 * capture path that calls it.
 */

/** Lifecycle state of the model in the main process. */
export type ParakeetStatus =
  | "disabled"
  | "missing"
  | "loading"
  | "ready"
  | "error";

export interface ParakeetTranscript {
  ok: boolean;
  text?: string;
  decodeMs?: number;
  loadMs?: number;
  rssMb?: number;
  rtf?: number;
  code?: string;
  message?: string;
}

export interface ParakeetComparisonCallbacks {
  onResult: (result: ParakeetTranscript) => void;
  onError: (message: string) => void;
}

function bridge(): Window["ghostly"]["parakeetTranscribe"] | null {
  if (typeof window === "undefined") return null;
  return window.ghostly?.parakeetTranscribe ?? null;
}

/** Whether the main-process bridge exists at all (it may be absent in tests). */
export function isParakeetBridgeAvailable(): boolean {
  return typeof window !== "undefined" && !!window.ghostly?.parakeetStatus;
}

/**
 * Ask the main process for the model status. Never loads anything.
 *
 * Returns `"disabled"` when the dev setting is off or the app is packaged, so
 * the settings UI can honestly show "off" rather than "broken".
 */
export async function getParakeetStatus(): Promise<ParakeetStatus> {
  if (!isParakeetBridgeAvailable()) return "disabled";
  try {
    const result = await window.ghostly.parakeetStatus();
    return result?.status ?? "error";
  } catch {
    return "error";
  }
}

/**
 * Load the model. Called on Start Interview, NOT at app launch.
 *
 * Measured cold load is ~6 s and several hundred MB of RSS, so paying it at
 * launch — while nobody is transcribing — would be a real cost for every user
 * of a feature that is off by default.
 */
export async function loadParakeetModel(): Promise<ParakeetTranscript> {
  if (!isParakeetBridgeAvailable()) {
    return { ok: false, code: "disabled", message: "Parakeet bridge unavailable." };
  }
  try {
    return await window.ghostly.parakeetLoad();
  } catch {
    return { ok: false, code: "crashed", message: "Parakeet load failed." };
  }
}

/** Release the model. Called on Stop Interview. */
export async function unloadParakeetModel(): Promise<void> {
  if (!isParakeetBridgeAvailable()) return;
  try {
    await window.ghostly.parakeetUnload();
  } catch {
    /* unloading is best-effort; the idle timeout is the backstop */
  }
}

/** Dev diagnostics: counts and timings only, never audio or model contents. */
export async function getParakeetDiagnostics(): Promise<{
  status: string;
  loadMs: number | null;
  rssMb: number | null;
  queued: number;
  inFlight: number;
  consecutiveFailures: number;
} | null> {
  if (!isParakeetBridgeAvailable()) return null;
  try {
    return await window.ghostly.parakeetDiagnostics();
  } catch {
    return null;
  }
}

/**
 * Transcribe one already-captured segment for comparison.
 *
 * Not awaited by callers: it must never delay the local engine. The audio is
 * the SAME buffer Moonshine gets, so the columns are comparable — the padding
 * the host applies is applied to a copy inside the host, never to this buffer.
 */
export async function runParakeetComparison(
  audio: Float32Array,
  callbacks: ParakeetComparisonCallbacks,
): Promise<void> {
  if (!bridge()) {
    callbacks.onError("Parakeet bridge unavailable.");
    return;
  }
  if (audio.length === 0) {
    callbacks.onError("Empty segment.");
    return;
  }

  let response: ParakeetTranscript;
  try {
    response = await window.ghostly.parakeetTranscribe({
      samples: audio,
      sampleRate: 16000,
    });
  } catch {
    // The handler is written never to throw; if something does, the comparison
    // is simply skipped.
    callbacks.onError("Parakeet comparison failed.");
    return;
  }

  if (!response || typeof response !== "object") {
    callbacks.onError("Parakeet returned an unexpected response.");
    return;
  }
  callbacks.onResult(response);
}