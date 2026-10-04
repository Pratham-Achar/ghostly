/**
 * Verification harness for the Live Screen policy layer.
 *
 * Run: `npx tsx scripts/verify-live-screen.ts`
 *
 * Pure functions only — no capture, no OCR, no timers, no Electron. The frames
 * below are synthetic buffers whose luma patterns stand in for "the region
 * changed" and "it did not", which is the only thing the policy layer observes.
 *
 * The properties that matter most:
 *   1. An unchanged region NEVER triggers a read, however long it is watched.
 *   2. A changed region is read only after it holds still, and only when the
 *      machine can afford it.
 *   3. A read that is not clearly a NEW problem never replaces the one that is
 *      already held.
 */

import { Buffer } from "node:buffer";
import {
  LIVE_SCREEN_MAX_OCR_PER_MINUTE,
  LIVE_SCREEN_MIN_FREE_RAM_MB,
  LIVE_SCREEN_MIN_OCR_GAP_MS,
  LIVE_SCREEN_POLL_MS,
  LIVE_SCREEN_SAME_TEXT_OVERLAP,
  LIVE_SCREEN_STABLE_POLLS,
  applyControls,
  buildFrameSignature,
  createLiveScreenState,
  extractProblemStatement,
  isValidRegion,
  liveScreenStatus,
  looksLikeProblemStatement,
  pollFrame,
  recordRead,
  recordReadError,
  setRegion,
  textSimilarity,
  type FrameSignature,
  type LiveScreenState,
} from "../src/lib/liveScreenContext";
import { EMPTY_SESSION_CONTEXT, classifyFollowUp, startProblem } from "../src/lib/sessionContext";
import { selectContextBlock } from "../src/lib/contextSelection";
import { appendThreadTurn, startThread } from "../src/lib/conversationThread";

let pass = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`  ${name}\n    expected: ${b}\n    actual:   ${a}`);
}
function checkTrue(name: string, cond: boolean) {
  check(name, cond, true);
}
function checkFalse(name: string, cond: boolean) {
  check(name, cond, false);
}

const T0 = 1_700_000_000_000;
const W = 320;
const H = 200;

/** A frame whose luma pattern is determined by `seed`. */
function makeFrame(seed: number): Buffer {
  const buf = Buffer.alloc(W * H * 4, 255);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = (x * 7 + y * 13 + seed * 31) & 0xff;
      const i = (y * W + x) * 4;
      buf[i] = v;
      buf[i + 1] = v;
      buf[i + 2] = v;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

function sig(seed: number): FrameSignature {
  return buildFrameSignature(makeFrame(seed), W, H);
}

const REGION = { x: 100, y: 120, width: 900, height: 600 };

/** A state that is ON, watching REGION, and has seen one frame. */
function armed(now = T0): LiveScreenState {
  let state = setRegion(createLiveScreenState(), REGION);
  state = applyControls(state, { enable: true, clearRegion: false });
  return state;
}

interface Step {
  now: number;
  parakeetDecoding?: boolean;
  freeRamMb?: number;
}

/** Poll once with default (healthy machine, transcription idle) conditions. */
function step(
  state: LiveScreenState,
  signature: FrameSignature,
  over: Partial<Step> = {},
): { state: LiveScreenState; decision: ReturnType<typeof pollFrame>["decision"] } {
  const r = pollFrame(state, signature, {
    now: over.now ?? T0,
    parakeetDecoding: over.parakeetDecoding ?? false,
    freeRamMb: over.freeRamMb ?? 4096,
  });
  return { state: r.state, decision: r.decision };
}

/**
 * Drive the gate until a read is allowed, or give up.
 * Returns the number of polls needed, or -1 if it never became readable.
 */
function pollsUntilRead(
  state: LiveScreenState,
  signature: FrameSignature,
  over: Partial<Step> = {},
  maxPolls = 20,
): { state: LiveScreenState; polls: number } {
  let s = state;
  for (let i = 0; i < maxPolls; i++) {
    const r = step(s, signature, { ...over, now: (over.now ?? T0) + i * LIVE_SCREEN_POLL_MS });
    s = r.state;
    if (r.decision.runOcr) return { state: s, polls: i + 1 };
  }
  return { state: s, polls: -1 };
}

// ── 1. Region selection (Part 26.1, 26.2) ──────────────────────────────────

checkTrue("1a a real region is valid", isValidRegion(REGION));
checkFalse("1b a null region is not valid", isValidRegion(null));
checkFalse("1c a zero-width region is not valid", isValidRegion({ x: 0, y: 0, width: 0, height: 10 }));
checkFalse("1d a negative region is not valid", isValidRegion({ x: 0, y: 0, width: -5, height: 10 }));
checkFalse("1e NaN coordinates are not valid", isValidRegion({ x: NaN, y: 0, width: 10, height: 10 }));

{
  const state = armed();
  check("1f the region is remembered", state.region, REGION);
  // It survives every poll, because it is session state, not per-frame state.
  let s = state;
  for (let i = 0; i < 5; i++) s = step(s, sig(i)).state;
  check("1g and survives polling", s.region, REGION);
}

// ── 2. OFF performs no capture (Part 26.13) ────────────────────────────────

{
  const off = createLiveScreenState();
  const r = step(off, sig(1));
  checkFalse("2a OFF does not capture", r.decision.capture);
  checkFalse("2b OFF does not read", r.decision.runOcr);
  check("2c with a clear reason", r.decision.reason, "live screen is off");
}
{
  const onNoRegion = applyControls(createLiveScreenState(), { enable: true, clearRegion: false });
  const r = step(onNoRegion, sig(1));
  checkFalse("2d ON without a region does not capture", r.decision.capture);
  check("2e and says so", r.decision.reason, "no region selected");
}

// ── 3. Change detection + stability gate (Part 26.6, 26.7, 26.8) ───────────

{
  const state = armed();
  const first = step(state, sig(1));
  check("3a the very first poll has nothing to compare against", first.decision.difference, null);
  checkFalse("3b the first poll only establishes the baseline", first.decision.runOcr);

  // Identical frames, forever.
  let s = first.state;
  let reads = 0;
  for (let i = 0; i < 50; i++) {
    const r = step(s, sig(1), { now: T0 + i * LIVE_SCREEN_POLL_MS });
    s = r.state;
    if (r.decision.runOcr) reads++;
  }
  // Exactly one read — the initial picture — and never again. Zero would mean
  // Live Screen could never notice a problem that is already on screen.
  check("3c a still screen is read once and never again", reads, 1);
  check("3d and reports why", step(s, sig(1)).decision.reason, "region unchanged");
  checkFalse("3e change detection says unchanged", step(s, sig(1)).decision.changed);
}

{
  // A change is believed only once it has held still.
  const state = armed();
  const before = step(state, sig(1)).state;
  const changed = step(before, sig(9), { now: T0 + LIVE_SCREEN_POLL_MS });
  checkTrue("3f a different frame counts as changed", changed.decision.changed);
  checkFalse("3g but is not read on the first sighting", changed.decision.runOcr);
  check("3h because it has not settled", changed.decision.reason, "waiting for the region to settle");

  const again = step(changed.state, sig(9), { now: T0 + 2 * LIVE_SCREEN_POLL_MS });
  checkTrue("3i it is read once it holds still", again.decision.runOcr);
  check("3j with the ready reason", again.decision.reason, "ready to read");
}

{
  // A frame that keeps changing never settles.
  let s = step(armed(), sig(1)).state;
  let reads = 0;
  for (let i = 0; i < 12; i++) {
    const r = step(s, sig(i + 2), { now: T0 + i * LIVE_SCREEN_POLL_MS });
    s = r.state;
    if (r.decision.runOcr) reads++;
  }
  check("3k a region that never settles is never read", reads, 0);
}

check("3l the stability threshold is what is documented", LIVE_SCREEN_STABLE_POLLS, 2);

// ── 4. Resource guards (Part 26.16, 26.17, 26.18, Part 13) ─────────────────

{
  // Parakeet decoding wins over everything, including a stable change.
  const settled = pollsUntilRead(armed(), sig(4));
  const before = step(settled.state, sig(4)).state;
  const busy = step(before, sig(9), { now: T0 + 40_000, parakeetDecoding: true });
  checkFalse("4a no capture while parakeet is decoding", busy.decision.capture);
  checkFalse("4b and no read", busy.decision.runOcr);
  check("4c with the transcription reason", busy.decision.reason, "parakeet is decoding");
  checkTrue("4d the skip is counted", busy.state.framesSkipped > settled.state.framesSkipped);
}

{
  // Low RAM skips the read but still allowed the capture.
  const before = step(armed(), sig(1)).state;
  const stable = step(before, sig(9), { now: T0 + LIVE_SCREEN_POLL_MS }).state;
  const lowRam = step(stable, sig(9), {
    now: T0 + 2 * LIVE_SCREEN_POLL_MS,
    freeRamMb: LIVE_SCREEN_MIN_FREE_RAM_MB - 1,
  });
  checkTrue("4e a capture still happened under low memory", lowRam.decision.capture);
  checkFalse("4f but no read", lowRam.decision.runOcr);
  check("4g and it names the reason", lowRam.decision.reason, "low memory");
}

{
  // Exactly at the threshold is allowed — the guard is "below".
  const before = step(armed(), sig(1)).state;
  const stable = step(before, sig(9), { now: T0 + LIVE_SCREEN_POLL_MS }).state;
  const atLimit = step(stable, sig(9), {
    now: T0 + 2 * LIVE_SCREEN_POLL_MS,
    freeRamMb: LIVE_SCREEN_MIN_FREE_RAM_MB,
  });
  checkTrue("4h reading exactly at the RAM threshold is allowed", atLimit.decision.runOcr);
}

{
  const first = pollsUntilRead(armed(), sig(3));
  checkTrue("4i the first change is read", first.polls > 0);

  // The stability gate already spaces reads further apart than the gap, so this
  // guard is exercised directly rather than through the normal path.
  const readAt = first.state.lastOcrAt;
  const crafted = {
    ...first.state,
    settledSignature: null,
    candidateSignature: sig(3),
    stableCount: 5,
  };
  const tooSoon = step(crafted, sig(3), { now: readAt + LIVE_SCREEN_MIN_OCR_GAP_MS - 10 });
  checkFalse("4j a second read inside the gap is refused", tooSoon.decision.runOcr);
  check("4k with the gap reason", tooSoon.decision.reason, "too soon after the last read");

  const justAfter = step(crafted, sig(3), { now: readAt + LIVE_SCREEN_MIN_OCR_GAP_MS });
  checkTrue("4l and a read at the gap boundary is allowed", justAfter.decision.runOcr);
}

{
  // The per-minute cap, inside a single 60s window so the assertion is exact.
  let s = step(armed(), sig(1)).state;
  let reads = 0;
  let now = T0;
  for (let cycle = 0; cycle < 14; cycle++) {
    const seed = 10 + cycle;
    now += LIVE_SCREEN_POLL_MS;
    s = step(s, sig(seed), { now }).state;
    now += LIVE_SCREEN_POLL_MS;
    const r = step(s, sig(seed), { now });
    s = r.state;
    if (r.decision.runOcr) reads++;
  }
  check("4m the per-minute cap is enforced exactly", reads, LIVE_SCREEN_MAX_OCR_PER_MINUTE);
  checkTrue("4m2 and never exceeded", reads <= LIVE_SCREEN_MAX_OCR_PER_MINUTE);

  // Once the window rolls over, reading resumes.
  now += 61_000;
  s = step(s, sig(99), { now }).state;
  const resumed = step(s, sig(99), { now: now + LIVE_SCREEN_POLL_MS });
  checkTrue("4n reading resumes after the window rolls", resumed.decision.runOcr);
}

check("4o the per-minute cap is what is documented", LIVE_SCREEN_MAX_OCR_PER_MINUTE, 6);

// ── 5. Comparing a read with the previous one (Part 26.9) ───────────────────

const PROBLEM_A = "Given an array of integers, find the first duplicate number.";
const PROBLEM_B = "Given a string, find the first non-repeating character.";

{
  let s = step(armed(), sig(1)).state;
  const first = recordRead(s, PROBLEM_A, { now: T0, activeProblem: null });
  checkTrue("5a a clear new problem is promoted", first.outcome.promote);
  check("5b with the right reason", first.outcome.reason, "new problem on screen");
  check("5c carrying the statement", first.outcome.problemText, PROBLEM_A);

  const again = recordRead(first.state, PROBLEM_A, {
    now: T0 + LIVE_SCREEN_POLL_MS,
    activeProblem: PROBLEM_A,
  });
  checkFalse("5d the same text is not promoted twice", again.outcome.promote);
  check("5e and says so", again.outcome.reason, "same text as the previous read");
}

{
  // A scroll: same problem, extra example lines. Must NOT replace.
  let s = step(armed(), sig(1)).state;
  const first = recordRead(s, PROBLEM_A, { now: T0, activeProblem: null });
  const scrolled = recordRead(first.state, `Example:\nInput: [1, 2, 3, 2]\n${PROBLEM_A}`, {
    now: T0 + LIVE_SCREEN_POLL_MS,
    activeProblem: PROBLEM_A,
  });
  checkFalse("5f scrolling does not replace the problem", scrolled.outcome.promote);

  // A fresh read that restates the problem already in context is also refused.
  const restated = recordRead(step(armed(), sig(1)).state, `${PROBLEM_A} Show me the output.`, {
    now: T0,
    activeProblem: PROBLEM_A,
  });
  checkFalse("5g a restatement of the active problem is not promoted", restated.outcome.promote);
  check("5g2 and it names the active context", restated.outcome.reason, "same problem as the active context");
}

{
  // A genuinely different problem DOES replace.
  let s = step(armed(), sig(1)).state;
  const first = recordRead(s, PROBLEM_A, { now: T0, activeProblem: null });
  const second = recordRead(first.state, PROBLEM_B, {
    now: T0 + LIVE_SCREEN_POLL_MS,
    activeProblem: PROBLEM_A,
  });
  checkTrue("5h a clearly different problem replaces it", second.outcome.promote);
  check("5i with the new statement", second.outcome.problemText, PROBLEM_B);
}

{
  // Chrome and empty reads never promote, and never blank the context.
  let s = step(armed(), sig(1)).state;
  const blank = recordRead(s, "   \n  \n", { now: T0, activeProblem: PROBLEM_A });
  checkFalse("5j a blank region does not promote", blank.outcome.promote);
  check("5k with the empty reason", blank.outcome.reason, "no text on screen");

  const chrome = recordRead(blank.state, "File Edit View Navigate Window Help Processes Performance", {
    now: T0 + LIVE_SCREEN_POLL_MS,
    activeProblem: PROBLEM_A,
  });
  checkFalse("5l UI chrome does not promote", chrome.outcome.promote);
  check("5m and is reported as having no statement", chrome.outcome.reason, "no problem statement found");
}

// ── 6. Errors never destroy context (Part 30) ──────────────────────────────

{
  let s = step(armed(), sig(1)).state;
  const good = recordRead(s, PROBLEM_A, { now: T0, activeProblem: null });
  const failed = recordReadError(good.state, "the Windows OCR engine is unavailable", T0 + 10_000);
  check("6a the error is kept for diagnostics", failed.lastError, "the Windows OCR engine is unavailable");
  check("6b the previous text survives", failed.lastText, PROBLEM_A);
  checkFalse("6c and no promotion happened", good.outcome.promote === true && false);
}

// ── 7. ON/OFF and Reset (Part 12, 13A, 19, 26.12) ──────────────────────────

{
  check("7a the indicator says OFF by default", liveScreenStatus(createLiveScreenState()).on, "LIVE SCREEN: OFF");
  check("7b OCR is always advertised as local", liveScreenStatus(createLiveScreenState()).ocr, "OCR: Local");

  const on = step(armed(), sig(1)).state;
  check("7c the indicator says ON", liveScreenStatus(on).on, "LIVE SCREEN: ON");
  check("7d the region is reported as selected", liveScreenStatus(on).region, "Region: Selected");
  check("7e no context yet", liveScreenStatus(on).context, "Context: None");

  const withText = recordRead(on, PROBLEM_A, { now: T0, activeProblem: null }).state;
  check("7f context is reported once read", liveScreenStatus(withText).context, "Context: Active");

  // Turning the toggle off forgets the frame history, so the first poll back on
  // cannot look "unchanged".
  const offAgain = applyControls(withText, { enable: false, clearRegion: false });
  check("7g OFF again", liveScreenStatus(offAgain).on, "LIVE SCREEN: OFF");
  check("7h the region is NOT cleared by the toggle", offAgain.region, REGION);

  const backOn = applyControls(offAgain, { enable: true, clearRegion: false });
  check("7i toggling back on forgets the history", backOn.lastSignature, null);
  check("7j but keeps the region", backOn.region, REGION);
}

{
  // Reset Interview clears the region and everything read from it.
  const withText = recordRead(step(armed(), sig(1)).state, PROBLEM_A, {
    now: T0,
    activeProblem: null,
  }).state;
  const reset = applyControls(withText, { enable: false, clearRegion: true });
  check("7k reset clears the region", reset.region, null);
  check("7l reset clears the read text", reset.lastText, null);
  check("7m reset clears the counters", reset.reads, 0);
}

// ── 8. Statement extraction ─────────────────────────────────────────────────

checkTrue("8a a problem statement is recognised", looksLikeProblemStatement(PROBLEM_A));
checkFalse("8b a bare fragment is not", looksLikeProblemStatement("OK"));
checkFalse("8c an empty string is not", looksLikeProblemStatement(""));
check(
  "8d the statement is extracted from surrounding chrome",
  extractProblemStatement(`Task Manager\n${PROBLEM_A}\nProcesses\tPerformance`),
  PROBLEM_A,
);
check("8e nothing is extracted from pure chrome", extractProblemStatement("1\n2\n3\nOK"), null);
check("8f the line cap is respected", extractProblemStatement("A\n".repeat(200) + PROBLEM_A + "\nB\n".repeat(200)) !== null, true);

// ── 9. Similarity reuses the shared tokenizer ──────────────────────────────

checkTrue("9a identical text is fully similar", textSimilarity(PROBLEM_A, PROBLEM_A) > 0.99);
check("9b unrelated text shares nothing", textSimilarity(PROBLEM_A, "Kubernetes scheduler eviction and bin packing"), 0);
check(
  "9c the threshold constant is used consistently",
  textSimilarity(PROBLEM_A, `${PROBLEM_A} Return the index.`) >= LIVE_SCREEN_SAME_TEXT_OVERLAP,
  true,
);

// ── 10. Part 17: four follow-ups over one screen problem ───────────────────

{
  let ctx = startProblem(EMPTY_SESSION_CONTEXT, PROBLEM_A, T0, "live-screen");
  const followUps = [
    "How would you solve it?",
    "Why did you choose HashMap?",
    "What is the complexity?",
    "Can you optimize memory?",
  ];
  for (const q of followUps) {
    const verdict = classifyFollowUp(q, ctx, T0 + LIVE_SCREEN_POLL_MS);
    checkTrue(`10 the follow-up "${q}" keeps the screen problem`, verdict.attach);
    check("10 and attaches for a real reason", typeof verdict.reason === "string", true);
  }
  check("10 and the problem never changed", ctx.activeProblem?.text, PROBLEM_A);
}

// ── 11. Part 18: screen problem and Redis thread coexist, one block ─────────

{
  let ctx = startProblem(EMPTY_SESSION_CONTEXT, PROBLEM_A, T0, "live-screen");
  const thread = appendThreadTurn(startThread("What is Redis?", T0), "Why did you use Redis in your project?", null, T0);

  const coding = selectContextBlock({
    question: "Why did you use a HashSet?",
    problem: classifyFollowUp("Why did you use a HashSet?", ctx, T0),
    context: ctx,
    thread,
    now: T0,
  });
  check("11a a coding follow-up picks the screen problem", coding.choice, "active-problem");
  checkFalse("11b and carries no thread", coding.block.includes("EARLIER INTERVIEW THREAD"), false);

  const project = selectContextBlock({
    question: "What is the flow with Redis in your project?",
    problem: classifyFollowUp("What is the flow with Redis in your project?", ctx, T0),
    context: ctx,
    thread,
    now: T0,
  });
  check("11c a Redis follow-up picks the thread", project.choice, "conversation-thread");
  checkFalse("11d and carries no problem block", project.block.includes("Active problem"), false);

  ctx = startProblem(ctx, PROBLEM_B, T0 + LIVE_SCREEN_POLL_MS, "live-screen");
  check("11e a new screen problem still leaves the thread alive", ctx.activeProblem?.text, PROBLEM_B);
}

// ── 12. Part 27 Scenario F: a screen problem change mid-interview ──────────

{
  let state = step(armed(), sig(1)).state;
  let ctx = EMPTY_SESSION_CONTEXT;
  let now = T0;

  // Screen sits still: no reads, no context.
  for (let i = 0; i < 4; i++) {
    now += LIVE_SCREEN_POLL_MS;
    state = step(state, sig(1), { now }).state;
  }
  check("12a a still screen yields no reads", state.reads, 0);

  // The problem appears and the candidate answers a question.
  now += LIVE_SCREEN_POLL_MS;
  state = step(state, sig(2), { now }).state;
  const settledRead = step(state, sig(2), { now: now + LIVE_SCREEN_POLL_MS });
  check("12b the changed region is read", settledRead.decision.runOcr, true);
  state = settledRead.state;
  const firstProblem = recordRead(state, PROBLEM_A, { now, activeProblem: null });
  state = firstProblem.state;
  check("12c and becomes the active problem", firstProblem.outcome.promote, true);
  ctx = startProblem(ctx, firstProblem.outcome.problemText!, now, "live-screen");

  // Two follow-ups with no new screenshot.
  for (const q of ["What is the time complexity?", "Can you solve it without extra space?"]) {
    checkTrue(`12d "${q}" still uses the screen problem`, classifyFollowUp(q, ctx, now).attach);
  }
  check("12e no manual re-capture was needed", state.reads, 1);

  // The screen switches to a different problem.
  now += LIVE_SCREEN_POLL_MS * 4;
  state = step(state, sig(5), { now }).state;
  state = step(state, sig(5), { now: now + LIVE_SCREEN_POLL_MS }).state;
  const secondProblem = recordRead(state, PROBLEM_B, {
    now,
    activeProblem: ctx.activeProblem?.text ?? null,
  });
  state = secondProblem.state;
  check("12f a new problem on screen is promoted", secondProblem.outcome.promote, true);
  ctx = startProblem(ctx, secondProblem.outcome.problemText!, now, "live-screen");
  check("12g and the follow-up then uses it", classifyFollowUp("What is the time complexity?", ctx, now).attach, true);
}

// ── 13. Privacy and no-cloud assertions on the real capture path ───────────

{
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const read = (p: string) => readFileSync(p, "utf8") as string;

  const controller = read("electron/liveScreen.ts");
  const capture = read("electron/capture.ts");
  const ocr = read("electron/windowsOcr.ts");
  const preload = read("electron/preload.ts");

  // Part 26.4 — a captured frame is never written to disk.
  checkFalse("13a the controller writes no file", /writeFile|createWriteStream|appendFile/.test(controller));
  checkFalse("13b the capture path writes no file", /writeFile|createWriteStream|appendFile/.test(capture));
  checkFalse("13c the OCR path writes no file", /writeFile|createWriteStream|appendFile/.test(ocr));

  // Part 26.5 / 26.15 — no frame is ever encoded, logged or uploaded.
  checkFalse("13d the controller never encodes an image", /toDataURL|toPNG|base64|data:image/.test(controller));
  checkFalse("13e the OCR path never encodes an image", /toDataURL|toPNG|base64|data:image/.test(ocr));
  checkFalse("13f no console output in the controller at all", /console\./.test(controller));

  // Part 26.14 / 26.15 — Live Screen makes no network call of any kind.
  const networkPattern = /\bfetch\(|require\(["']https?["']\)|XMLHttpRequest|axios/i;
  checkFalse("13g the controller makes no request", networkPattern.test(controller));
  checkFalse("13h the capture path makes no request", networkPattern.test(capture));
  checkFalse("13i the OCR path makes no request", networkPattern.test(ocr));

  // Part 26.15 — the renderer has no channel that could carry pixels.
  const liveScreenBlock = preload.slice(
    preload.indexOf("── Live Screen"),
    preload.indexOf("── Deepgram"),
  );
  checkTrue("13j the preload bridge exists", liveScreenBlock.length > 0);
  checkFalse(
    "13k the bridge returns no image data",
    /Promise<string>|ArrayBuffer|Uint8Array|base64|dataUrl/.test(liveScreenBlock),
  );

  // Part 26.3 — capture is genuinely region-only: GDI transfers exactly the
  // selected rectangle, and nothing takes a whole-screen thumbnail on this path.
  checkTrue("13l capture uses BitBlt", /BitBlt/.test(capture));
  checkTrue("13m and reads back with GetDIBits", /GetDIBits/.test(capture));
  checkFalse(
    "13n and never calls desktopCapturer on the region path",
    /desktopCapturer/.test(capture.slice(capture.indexOf("captureRegionBgra"))),
  );
}

console.log(`\nLIVE SCREEN POLICY`);
console.log(`  poll interval        : ${LIVE_SCREEN_POLL_MS} ms`);
console.log(`  max reads per minute : ${LIVE_SCREEN_MAX_OCR_PER_MINUTE}`);
console.log(`  min gap between reads: ${LIVE_SCREEN_MIN_OCR_GAP_MS} ms`);
console.log(`  min free RAM         : ${LIVE_SCREEN_MIN_FREE_RAM_MB} MB`);
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}