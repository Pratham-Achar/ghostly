/**
 * Deterministic regression tests for Interview readiness under a Parakeet
 * primary engine.
 *
 * Run: `npx tsx scripts/verify-asr-readiness.mts`
 *
 * ── The bug this protects against ───────────────────────────────────────────
 * Readiness used to be one flag, `isModelReady`, written ONLY by Moonshine's
 * worker `ready` message. When Parakeet became selectable as the primary engine,
 * Moonshine was deliberately no longer loaded — so the flag never became true,
 * the Interview UI stayed on "Initializing AI engine…", and the Start button and
 * hotkey were both permanently disabled. The fix routes readiness through the
 * primary engine's own status (`lib/asrReadiness.ts`).
 *
 * Four behaviours are pinned here:
 *   1. Moonshine primary → Moonshine ready enables Start.
 *   2. Parakeet primary  → Parakeet ready enables Start.
 *   3. Parakeet not ready → Start stays disabled (even with a stale Moonshine flag).
 *   4. Switching engines never leaves one engine's readiness gating the other.
 *
 * The pure rule is asserted directly; the wiring is asserted against the real
 * hook source, because only the real source can show that the UI reads it.
 */
import { readFile } from "node:fs/promises";

import {
  isInterviewStartReady,
  shouldEagerLoadParakeet,
} from "../src/lib/asrReadiness";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    failures.push(
      `${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }
}

function checkTrue(name: string, actual: unknown) {
  check(name, Boolean(actual), true);
}

function checkFalse(name: string, actual: unknown) {
  check(name, Boolean(actual), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Readiness follows the primary engine ───────────────────");
// ═══════════════════════════════════════════════════════════════════════════

// 1. Moonshine primary → its own ready flag decides.
check("1 Moonshine primary: Moonshine ready enables Start",
  isInterviewStartReady("moonshine", true, false), true);
check("2 Moonshine primary: Moonshine not ready keeps Start disabled",
  isInterviewStartReady("moonshine", false, false), false);
check("3 Moonshine primary ignores Parakeet readiness (no stale enable)",
  isInterviewStartReady("moonshine", false, true), false);

// 2. Parakeet primary → its own ready flag decides.
check("4 Parakeet primary: Parakeet ready enables Start",
  isInterviewStartReady("parakeet", false, true), true);
check("5 Parakeet primary: Parakeet not ready keeps Start disabled",
  isInterviewStartReady("parakeet", false, false), false);
check("6 Parakeet primary ignores a stale Moonshine-ready flag",
  isInterviewStartReady("parakeet", true, false), false);

// 4. Switching engines: the two flags never leak across engines.
check("7 switching to Parakeet carries no stale Moonshine readiness",
  isInterviewStartReady("parakeet", true, false), false);
check("8 switching to Moonshine carries no stale Parakeet readiness",
  isInterviewStartReady("moonshine", false, true), false);

// Defensive: an unknown engine behaves like Moonshine, never like Parakeet.
check("9 an unrecognised engine is treated like Moonshine (not ready)",
  isInterviewStartReady("bogus", false, true), false);
check("10 an unrecognised engine with Moonshine ready is ready",
  isInterviewStartReady("bogus", true, false), true);

// ── Eager load is Parakeet-only ────────────────────────────────────────────
checkTrue("11 Parakeet primary eager-loads its model", shouldEagerLoadParakeet("parakeet"));
checkFalse("12 Moonshine primary never eager-loads (no Moonshine load added)",
  shouldEagerLoadParakeet("moonshine"));
checkFalse("13 an unrecognised engine never eager-loads", shouldEagerLoadParakeet("bogus"));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── The hook actually wires readiness to the engine ────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const hook = await readFile("src/hooks/useInterviewAudio.ts", "utf8");
  const modal = await readFile("src/components/InterviewModal.tsx", "utf8");

  checkTrue("14 the hook imports the readiness rule",
    /import\s*\{[\s\S]*?isInterviewStartReady[\s\S]*?\}\s*from\s*"\.\.\/lib\/asrReadiness"/.test(hook));
  checkTrue("15 the hook imports the eager-load predicate",
    /shouldEagerLoadParakeet/.test(hook) && /from\s*"\.\.\/lib\/asrReadiness"/.test(hook));

  checkTrue("16 readiness is computed from primaryAsr + Moonshine + Parakeet status",
    /const startReady = isInterviewStartReady\(\s*primaryAsr,\s*isModelReady,\s*parakeetStatus === "ready",\s*\)/.test(hook));

  // The two consumers named in the bug report: the Start button (the returned
  // value) and the hotkey (modelReadyRef).
  checkTrue("17 the value the UI reads as isModelReady is the derived readiness",
    /isModelReady: startReady,/.test(hook));
  checkTrue("18 the hotkey gate reads the derived readiness",
    /modelReadyRef\.current = startReady;/.test(hook));
  checkTrue("19 a pending Start is honoured on derived readiness",
    /if \(startReady && consumePendingStart\(\)\)/.test(hook));

  // The eager load must be gated, and must be the ONLY new loader.
  checkTrue("20 the eager-load effect is gated on the predicate",
    /if \(!shouldEagerLoadParakeet\(primaryAsr\)\) return;/.test(hook));
  checkTrue("21 the eager-load effect calls the Parakeet loader",
    /useEffect\(\(\) => \{\s*if \(!shouldEagerLoadParakeet\(primaryAsr\)\) return;\s*void ensureParakeetLoaded\(\);/.test(hook));

  // Requirement 4: Moonshine is still never loaded for a Parakeet session.
  checkTrue("22 Moonshine is loaded only when it is the primary engine",
    /if \(primaryAsr === "moonshine"\) \{\s*workerRef\.current\.postMessage\(\{ type: "load", model: asrModel \}\);/.test(hook));

  // The Moonshine-only writer of isModelReady is untouched (still 4 sites:
  // init, reset on engine switch, worker ready, worker error).
  const setModelReady = hook.match(/setIsModelReady\(/g) ?? [];
  check("23 isModelReady is still written solely by the Moonshine worker path",
    setModelReady.length, 3);
  checkTrue("24 the Moonshine gate in startInterview is unchanged",
    /if \(primaryAsrRef\.current === "moonshine" && !modelReadyRef\.current\)/.test(hook));

  // A concurrent double-load is prevented, so strict-mode double-invoke or an
  // eager load racing a Start press cannot load the model twice.
  checkTrue("25 a Parakeet load is guarded against a concurrent second request",
    /if \(parakeetLoadInFlightRef\.current\) return;/.test(hook));

  // The UI still shows the loading state until readiness is true — it did not
  // become unconditionally ready.
  checkTrue("26 the loading banner is still gated on !isModelReady",
    /\{!isModelReady && \(/.test(modal));
  checkTrue("27 the Start button is still disabled until ready",
    /disabled=\{!isModelReady\}/.test(modal));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
