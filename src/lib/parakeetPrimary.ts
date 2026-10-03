/**
 * Everything about Parakeet-as-primary that is a POLICY rather than plumbing.
 *
 * Kept out of the hook on purpose. The two decisions below — what happens to a
 * segment that arrives while the model is still loading, and how long the submit
 * drain may wait for a Parakeet decode — are the two places where being wrong
 * either loses a question or hangs the hotkey. Both are pure state machines, so
 * both are exercised directly by the test harness against a fake clock.
 */

/**
 * Ceiling on segments buffered while the model is still loading.
 *
 * ── Why queue rather than fall back ──────────────────────────────────────────
 * The obvious alternative is to send every early segment to Moonshine. That is
 * the wrong trade on this machine: Moonshine's WASM/q8 path was measured at
 * ~22 s to load (far slower than Parakeet's ~7 s), so "fall back immediately"
 * would mean triggering a much longer load than the one it is avoiding. Queueing
 * is strictly faster here, and it keeps a single decode path.
 *
 * ── Why a bound is still needed ─────────────────────────────────────────────
 * The load is ~7 s and a phrase is ~2-3 s, so at most two or three segments can
 * plausibly arrive first. But "plausibly" is not a guarantee: a cold model on a
 * loaded machine can take far longer, and an unbounded queue holding 16 kHz
 * `Float32Array`s is unbounded memory in the renderer. Four is generous enough
 * to cover the normal cold start and small enough that the worst case is a few
 * seconds of audio.
 *
 * ── Which end overflow drops ────────────────────────────────────────────────
 * The OLDEST. A segment's job is to carry the question; the newest one is the
 * one whose tail is the actual ask, and the tail is also the part the drain
 * barrier is designed to protect. Dropping the newest would discard exactly what
 * the user is about to submit.
 */
export const PARAKEET_PRIMARY_QUEUE_LIMIT = 4;

/** A segment waiting for the model to finish loading. */
export interface QueuedParakeetSegment<T> {
  /** Monotonic, supplied by the caller — the VAD phraseId. */
  phraseId: number;
  payload: T;
}

export interface SegmentQueueSnapshot {
  /** Segments currently buffered. */
  size: number;
  /** Segments discarded because the queue was full. Never silently forgotten. */
  dropped: number;
}

export interface ParakeetSegmentQueue<T> {
  /**
   * Buffer a segment.
   *
   * Returns `true` if it was accepted, `false` if the queue was full and this
   * segment displaced an older one. A `false` return is a real loss and must be
   * surfaced to the user, never swallowed.
   */
  push(segment: QueuedParakeetSegment<T>): boolean;
  /** Remove and return the oldest segment, or `null` when empty. */
  shift(): QueuedParakeetSegment<T> | null;
  /** Buffer length. */
  size(): number;
  /** Counters, for the diagnostics line and the on-screen log. */
  snapshot(): SegmentQueueSnapshot;
  /** Forget everything, e.g. on Stop Interview. */
  clear(): void;
}

export function createParakeetSegmentQueue<T>(
  limit: number = PARAKEET_PRIMARY_QUEUE_LIMIT,
): ParakeetSegmentQueue<T> {
  const items: QueuedParakeetSegment<T>[] = [];
  let dropped = 0;

  return {
    push(segment) {
      if (items.length >= limit) {
        items.shift();
        dropped++;
        items.push(segment);
        return false;
      }
      items.push(segment);
      return true;
    },
    shift() {
      return items.shift() ?? null;
    },
    size() {
      return items.length;
    },
    snapshot() {
      return { size: items.length, dropped };
    },
    clear() {
      items.length = 0;
    },
  };
}

// ── Submit drain ────────────────────────────────────────────────────────────

/**
 * Cap on how long the submit drain waits for an in-flight PARAKEET decode.
 *
 * ── Why Parakeet needs a different budget from Moonshine ─────────────────────
 * The drain exists to stop the tail of a question being submitted without its
 * last words. Its deadline (900 ms) was sized against Moonshine, whose measured
 * decode is ~0.6 s for a real utterance. Parakeet's decode measured 326-2231 ms
 * live on this machine — its worst case is more than double the entire budget.
 * Leaving 900 ms in place would mean the barrier times out on most turns, which
 * reintroduces exactly the truncation it was built to prevent.
 *
 * 2500 ms sits above the observed worst case (2231 ms) with headroom for IPC,
 * while still being short enough that a human pressing a hotkey does not think
 * the app has hung.
 *
 * MOONSHINE'S 900 ms IS DELIBERATELY UNTOUCHED. This constant is only ever
 * passed to `createAsrDrain` on the Parakeet-primary path.
 *
 * Phase 8 is expected to measure how often this cap is actually reached.
 */
export const PARAKEET_DRAIN_DEADLINE_MS = 2500;

/**
 * Flush attempts allowed within {@link PARAKEET_DRAIN_DEADLINE_MS}.
 *
 * `createAsrDrain` caps attempts independently of the deadline, so a longer
 * deadline with the default 4 attempts would still stop early — 4 x 150 ms is
 * 600 ms of waiting regardless of the 2500 ms cap. Derived from the deadline so
 * the two can never disagree.
 */
export const PARAKEET_DRAIN_MAX_ATTEMPTS = Math.ceil(
  PARAKEET_DRAIN_DEADLINE_MS / 150,
);
