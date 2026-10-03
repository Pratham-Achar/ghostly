import type { PrimaryAsr } from "./primaryAsr";

/**
 * Whether the Start button and the start hotkey may run.
 *
 * ── Why this is its own function ────────────────────────────────────────────
 * Readiness must follow the PRIMARY engine. Moonshine and Parakeet each own the
 * truth about themselves — Moonshine via its worker's `ready` message, Parakeet
 * via its model-load result — and NEITHER may gate on the other. Coupling both
 * to Moonshine's loader is exactly what left the Live Interview UI stuck on
 * "Initializing AI engine…": under Parakeet primary, Moonshine is deliberately
 * never loaded, so its `ready` never arrives and a shared readiness flag stays
 * false forever.
 *
 * Keeping the rule here (rather than inline in the hook) is what makes it
 * testable without a browser: the four regression cases — Moonshine ready,
 * Parakeet ready, Parakeet not ready, and a stale Moonshine flag under Parakeet
 * primary — are all decided by this one expression.
 */
export function isInterviewStartReady(
  primaryAsr: PrimaryAsr | string,
  moonshineReady: boolean,
  parakeetReady: boolean,
): boolean {
  return primaryAsr === "parakeet" ? parakeetReady : moonshineReady;
}

/**
 * Whether selecting this engine requires Parakeet to be loaded eagerly.
 *
 * Only Parakeet does. Moonshine loads itself inside the worker-init effect, so
 * its readiness arrives on its own. Parakeet must be *asked* to load, and the
 * only other caller is `startInterview` — which the disabled Start button can
 * never reach while readiness is false. Loading Parakeet the moment the engine
 * is selected is therefore what breaks that circular wait, without ever touching
 * capture, VAD, the gate, the AI, or the fallback path.
 */
export function shouldEagerLoadParakeet(primaryAsr: PrimaryAsr | string): boolean {
  return primaryAsr === "parakeet";
}
