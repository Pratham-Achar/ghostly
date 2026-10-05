/**
 * Which question a Solve press is answering.
 *
 * ── Why this is not decided inline ─────────────────────────────────────────
 * Ctrl+Enter is ONE action with two legitimate inputs: the interviewer's
 * spoken question, and the screenshot sitting in the strip. Which one wins is a
 * product decision, and getting it wrong is what produced the reported
 * "screenshot taken, no answer received" failure:
 *
 *   The interview panel being OPEN was enough to route the press down the
 *   live-audio path. With the transcript gate saying "wait" — no speech, an
 *   incomplete utterance, a conversational aside — the run returned the WAIT
 *   notice and the accumulated screenshot was never sent to any provider. Solve
 *   therefore required an audio submission it did not need, which is exactly
 *   what it is not supposed to do.
 *
 * So the rule is explicit and lives here: a screenshot is a question in its own
 * right, and Solve must answer it whenever there is no answerable spoken
 * question to answer instead.
 */

/** A screenshot entry is only usable if it is a non-empty string. */
export function isUsableScreenshot(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Every screenshot the run may send, with payload-less entries discarded. */
export function usableScreenshots(screenshots: readonly unknown[]): string[] {
  return screenshots.filter(isUsableScreenshot);
}

/**
 * The newest screenshot actually worth attaching to a run.
 *
 * `screenshots[length - 1]` was used before. A single payload-less entry at the
 * end of the list therefore suppressed the image entirely, and the provider was
 * asked to read a picture that was never transmitted.
 */
export function lastUsableScreenshot(
  screenshots: readonly unknown[],
): string | undefined {
  for (let i = screenshots.length - 1; i >= 0; i--) {
    const candidate = screenshots[i];
    if (isUsableScreenshot(candidate)) return candidate;
  }
  return undefined;
}

export type SolveTarget = "interview" | "screenshot";

export interface SolveTargetDecision {
  target: SolveTarget;
  /** Closed vocabulary, safe to log. Never question or answer text. */
  reason:
    | "interview question wins"
    | "no live question — solving the screenshot"
    | "screenshot solve is not possible";
}

export interface SolveTargetInput {
  /** Was there a transcript to gate at all (i.e. is the panel open)? */
  hasTurn: boolean;
  /** Did the local question gate accept the transcript? */
  gateSaysAnswer: boolean;
  /** How many screenshots are actually attachable. */
  usableScreenshots: number;
}

/**
 * Decide what a Solve press answers.
 *
 * The interview question always wins when there is one — that is the live path
 * and it must not change. The screenshot is the fallback, so a screenshot plus
 * Solve produces an answer with no audio submission, no Live Screen and no
 * ASR involved.
 */
export function decideSolveTarget(
  input: SolveTargetInput,
): SolveTargetDecision {
  const canSolveScreenshot = input.usableScreenshots > 0;
  const hasLiveQuestion = input.hasTurn && input.gateSaysAnswer;

  if (hasLiveQuestion) {
    return { target: "interview", reason: "interview question wins" };
  }
  if (canSolveScreenshot) {
    return {
      target: "screenshot",
      reason: "no live question — solving the screenshot",
    };
  }
  return {
    target: "interview",
    reason: "screenshot solve is not possible",
  };
}
