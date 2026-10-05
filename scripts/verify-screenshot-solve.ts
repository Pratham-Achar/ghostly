/**
 * Regression harness for the Screenshot -> Solve answer path.
 *
 * Run: `npx tsx scripts/verify-screenshot-solve.ts`
 *
 * The reported failure was "I took a screenshot and no answer arrived". Two
 * separate defects sat behind it, and this harness pins both:
 *
 *   1. The tray's "Capture Screen" item emitted `ghostly:screenshot` with NO
 *      payload. The renderer appended `undefined` to its screenshot list, so
 *      `screenshots.length > 0` satisfied the "you forgot to capture" guard
 *      while the provider was asked to read a picture that was never sent.
 *      `runAIStream` also took `screenshotList[length - 1]`, so one bad entry
 *      suppressed the image entirely.
 *
 *   2. `onSolve` routed on "is the interview panel open" rather than on "is
 *      there a live question to answer". With the panel open and the local gate
 *      saying WAIT, the run stopped at the WAIT notice and the screenshot was
 *      never sent. Solve therefore required an audio submission it does not
 *      need, and does not need Live Screen or Parakeet either.
 *
 * The decision itself (`lib/solveTarget.ts`) and the real store action are
 * exercised directly — not mocked — and the wiring that connects them to the
 * answer-generation call is asserted against the actual source, so this
 * harness fails if the UI path is broken even while the helpers stay green.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  decideSolveTarget,
  isUsableScreenshot,
  lastUsableScreenshot,
  usableScreenshots,
} from "../src/lib/solveTarget";
import { useStore } from "../src/store/useStore";

let pass = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`  ${name}\n    expected: ${b}\n    actual:   ${a}`);
}
function checkTrue(name: string, cond: boolean): void {
  check(name, cond, true);
}

const root = process.cwd();
const read = (p: string): string => readFileSync(path.join(root, p), "utf8");

const IMG = "data:image/png;base64,iVBORw0KGgo=";
const IMG2 = "data:image/png;base64,iVBORw0KGgp=";

console.log("SCREENSHOT -> SOLVE");

// ── A. The screenshot list only ever holds attachable images ───────────────

check("A1 a non-empty data URL is usable", isUsableScreenshot(IMG), true);
check("A2 undefined is not usable", isUsableScreenshot(undefined), false);
check("A3 the empty string is not usable", isUsableScreenshot(""), false);

check(
  "A4 payload-less entries are filtered out",
  usableScreenshots([IMG, undefined, IMG2]),
  [IMG, IMG2],
);

// The exact shape the tray menu used to produce.
check(
  "A5 a list holding only a payload-less entry yields nothing to send",
  usableScreenshots([undefined]),
  [],
);
check(
  "A6 the newest ATTACHABLE screenshot is used, not merely the last entry",
  lastUsableScreenshot([IMG, IMG2, undefined]),
  IMG2,
);
check(
  "A7 no usable screenshot at all resolves to undefined",
  lastUsableScreenshot([undefined, ""]),
  undefined,
);

// ── B. The real store action rejects a payload-less screenshot ─────────────
// Exercised against the actual zustand store, not a stand-in.

const store = useStore.getState();
store.clearScreenshots();
store.addScreenshot(undefined as unknown as string);
check("B1 a payload-less screenshot never enters the store", useStore.getState().screenshots, []);
store.addScreenshot(IMG);
check("B2 a real screenshot does enter the store", useStore.getState().screenshots, [IMG]);
check("B3 the store exposes it as the current screenshot", useStore.getState().currentScreenshot, IMG);
store.clearScreenshots();

// ── C. What a Solve press answers ──────────────────────────────────────────

check(
  "C1 a live question wins over an available screenshot",
  decideSolveTarget({ hasTurn: true, gateSaysAnswer: true, usableScreenshots: 1 }),
  { target: "interview", reason: "interview question wins" },
);
check(
  "C2 with no transcript the screenshot is solved — no audio required",
  decideSolveTarget({ hasTurn: false, gateSaysAnswer: false, usableScreenshots: 1 }),
  { target: "screenshot", reason: "no live question — solving the screenshot" },
);
check(
  "C3 an open panel whose gate said WAIT no longer swallows the screenshot",
  decideSolveTarget({ hasTurn: true, gateSaysAnswer: false, usableScreenshots: 1 }),
  { target: "screenshot", reason: "no live question — solving the screenshot" },
);
check(
  "C4 with nothing to solve from, the live path is left completely unchanged",
  decideSolveTarget({ hasTurn: true, gateSaysAnswer: false, usableScreenshots: 0 }),
  { target: "interview", reason: "screenshot solve is not possible" },
);
check(
  "C5 a panel-less press with no screenshot keeps the 'capture one first' error",
  decideSolveTarget({ hasTurn: false, gateSaysAnswer: false, usableScreenshots: 0 }),
  { target: "interview", reason: "screenshot solve is not possible" },
);

// ── D. The wiring that actually reaches the answer-generation call ─────────

const home = read("src/pages/Home.tsx");
const storeSrc = read("src/store/useStore.ts");
const hotkeys = read("electron/hotkeys.ts");
const main = read("electron/main.ts");

checkTrue(
  "D1 the Solve handler routes through the tested decision",
  /decideSolveTarget\(\{[\s\S]{0,300}?gateSaysAnswer/.test(home),
);
checkTrue(
  "D2 the Solve handler hands the decision's target to the answer pipeline",
  /runAIStream\(shots,\s*decision\.target === "interview" \? turn : undefined\)/.test(home),
);
checkTrue(
  "D3 the screenshot actually attached to the run is the newest usable one",
  /const latestScreenshot = lastUsableScreenshot\(screenshotList\)/.test(home),
);
checkTrue(
  "D4 the 'capture a screenshot first' guard counts attachable screenshots",
  /usableScreenshots\(screenshotList\)\.length === 0/.test(home),
);
checkTrue(
  "D5 the attached image is what reaches the orchestrator",
  /base64Image: latestScreenshot/.test(home),
);
checkTrue(
  "D6 the store refuses a payload-less screenshot",
  /if \(typeof b64 !== "string" \|\| b64\.length === 0\)/.test(storeSrc),
);

// ── E. Screenshot capture always produces an image ─────────────────────────

checkTrue(
  "E1 both capture entry points share one implementation",
  /export async function captureAndSendScreenshot/.test(hotkeys) &&
    /await captureAndSendScreenshot\(win\)/.test(hotkeys) &&
    /captureAndSendScreenshot\(mainWindow\)/.test(main),
);
checkTrue(
  "E2 the tray menu no longer emits a payload-less screenshot",
  !/send\("ghostly:screenshot"\)/.test(main),
);
const screenshotSends = [
  ...hotkeys.matchAll(/send\("ghostly:screenshot"([^)]*)\)/g),
].map((m) => m[1].trim());
checkTrue(
  "E3 every ghostly:screenshot send carries the captured image",
  screenshotSends.length >= 1 &&
    screenshotSends.every((args) => args.startsWith(",")),
);
checkTrue(
  "E4 no send can emit a payload-less screenshot anywhere in the main process",
  ![hotkeys, main].some((src) =>
    /send\("ghostly:screenshot"\s*\)/.test(src),
  ),
);

// ── F. Solve needs no Live Screen, no Parakeet and no ASR ───────────────────

checkTrue(
  "F1 the Solve handler passes the screenshots into the answer pipeline",
  /const shots = screenshotsRef\.current/.test(home) &&
    /runAIStream\(shots,/.test(home),
);
checkTrue(
  "F2 the screenshot prompt is the existing one, not a new code path",
  /buildPrompt\(settings\.interviewType, settings\.language\)/.test(home),
);
const solveTargetSrc = read("src/lib/solveTarget.ts");
checkTrue(
  "F3 the Solve decision is pure — it cannot pull in Live Screen or any ASR",
  !/^import /m.test(solveTargetSrc),
);
const decisionBlock = home.slice(
  home.indexOf("const decision = decideSolveTarget("),
  home.indexOf("await runAIStream(shots, decision.target"),
);
checkTrue(
  "F4 the Solve decision touches no ASR, Live Screen or provider code",
  !/liveScreen|parakeet|moonshine|deepgram|groq|orchestrat/i.test(decisionBlock),
);
checkTrue(
  "F5 the screenshot is carried into the run independently of the panel",
  /const shots = screenshotsRef\.current/.test(home),
);

console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
