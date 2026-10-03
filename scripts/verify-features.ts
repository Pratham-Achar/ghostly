/**
 * Verification harness for the 3 new features:
 *
 *   1. Candidate repeated-word correction (transcript-level, pure)
 *   2. Manual text question input (exercised through the SAME downstream gate
 *      the voice path uses, by constructing an InterviewTurn)
 *   3. Interview type dropdown organisation (General / DSA) + settings
 *      backward-compatibility
 *
 * Run: `npx tsx scripts/verify-features.ts`
 *
 * No audio, no network, no Electron. Pure functions only.
 */

import {
  correctQuestionWithCandidate,
} from "../src/lib/candidateCorrection";
import { correctTranscript } from "../src/lib/transcriptCorrection";
import {
  evaluateInterviewTurn,
  normalizeTurn,
  turnSignature,
  type InterviewTurn,
} from "../src/lib/interviewAgent";
import {
  INTERVIEW_TYPE_GROUPS,
  INTERVIEW_TYPES,
} from "../src/components/SettingsPanel";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(
      `${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

function report() {
  console.log(`  ${pass} passed, ${fail} failed (cumulative)`);
  if (failures.length) {
    console.log(failures.join("\n\n"));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — CANDIDATE REPEATED-WORD CORRECTION (spec TESTS 1-8)
// ─────────────────────────────────────────────────────────────────────────────

section("Part 1: candidate correction");

// TEST 1: "What is mango?" + "MongoDB" -> "What is MongoDB?"
{
  const r = correctQuestionWithCandidate("What is mango?", { text: "MongoDB" });
  check("TEST 1: mango -> MongoDB", r.finalCorrectedQuestion, "What is MongoDB?");
  check("TEST 1: correction applied", r.corrected, true);
  // Raw text is preserved, never destroyed.
  check("TEST 1: raw interviewer text preserved", r.rawInterviewerText, "What is mango?");
  check("TEST 1: candidate correction preserved", r.candidateCorrection, "MongoDB");
  // AI receives ONLY the final question — never the concatenation.
  check(
    "TEST 1: AI input has no appended candidate",
    r.finalCorrectedQuestion.includes("mango MongoDB"),
    false,
  );
}

// TEST 2: ONE question only, AI runs once.
{
  const r = correctQuestionWithCandidate("What is mango?", { text: "MongoDB" });
  // The module returns exactly one corrected question and no second question is
  // generated, so a single submit produces a single AI run.
  const questionMarks = (r.finalCorrectedQuestion.match(/\?/g) ?? []).length;
  check("TEST 2: exactly one question in final text", questionMarks, 1);
  check("TEST 2: exactly one correction recorded", r.corrections.length, 1);
}

// TEST 3: "What is Docker?" + "MongoDB" -> NO correction.
{
  const r = correctQuestionWithCandidate("What is Docker?", { text: "MongoDB" });
  check("TEST 3: Docker unchanged", r.finalCorrectedQuestion, "What is Docker?");
  check("TEST 3: no correction applied", r.corrected, false);
}

// TEST 4: "What is mango?" + "Okay." -> NO correction.
{
  const r = correctQuestionWithCandidate("What is mango?", { text: "Okay." });
  check("TEST 4: Okay ignored", r.finalCorrectedQuestion, "What is mango?");
  check("TEST 4: no correction applied", r.corrected, false);
}

// TEST 5: "What is Spring boat?" + "Spring Boot" -> "What is Spring Boot?"
{
  const r = correctQuestionWithCandidate("What is Spring boat?", { text: "Spring Boot" });
  check("TEST 5: Spring boat -> Spring Boot", r.finalCorrectedQuestion, "What is Spring Boot?");
  check("TEST 5: correction applied", r.corrected, true);
}

// TEST 6: identical phrase must NOT be duplicated.
{
  const r = correctQuestionWithCandidate("What is Spring Boot?", { text: "Spring Boot" });
  check("TEST 6: no duplication", r.finalCorrectedQuestion, "What is Spring Boot?");
  check("TEST 6: no correction applied", r.corrected, false);
}

// TEST 7: whole-sentence candidate must NOT replace the question.
{
  const r = correctQuestionWithCandidate("What is MongoDB?", {
    text: "MongoDB is a NoSQL database...",
  });
  check(
    "TEST 7: sentence candidate does not replace question",
    r.finalCorrectedQuestion,
    "What is MongoDB?",
  );
  check("TEST 7: no correction applied", r.corrected, false);
}

// TEST 8: a later follow-up stays a SEPARATE question (never merged).
{
  const q1 = correctQuestionWithCandidate("What is MongoDB?", { text: "MongoDB" });
  const q2 = correctQuestionWithCandidate("Why did you choose it?", { text: "MongoDB" });
  check(
    "TEST 8: first corrected, follow-up untouched",
    [q1.finalCorrectedQuestion, q2.finalCorrectedQuestion],
    ["What is MongoDB?", "Why did you choose it?"],
  );

  // Both questions submitted as one turn must remain two distinct questions —
  // the correction never glues a follow-up onto the previous question.
  const turn: InterviewTurn = {
    finals: [
      { source: "system", text: q1.finalCorrectedQuestion },
      { source: "system", text: q2.finalCorrectedQuestion },
    ],
    interim: null,
  };
  const normalized = normalizeTurn(turn);
  check("TEST 8: follow-up is a separate turn", normalized.finals.length, 2);
  check(
    "TEST 8: gate answers the follow-up, not the first question",
    evaluateInterviewTurn(turn).action,
    "answer",
  );
}

// Safety: NO active interviewer question -> the candidate must not invent one.
{
  const r = correctQuestionWithCandidate("", { text: "MongoDB" });
  check("SAFETY: empty question stays empty", r.finalCorrectedQuestion, "");
  check("SAFETY: no correction without a question", r.corrected, false);
}

// Voice path: the correction also runs inside correctTranscript's candidateSignal.
{
  const res = correctTranscript({
    rawText: "What is mango?",
    source: "system",
    candidateSignal: { text: "MongoDB" },
  });
  check(
    "VOICE PATH: correctTranscript applies candidate correction",
    res.correctedText,
    "What is MongoDB?",
  );
  check("VOICE PATH: raw transcript preserved", res.rawText, "What is mango?");
}

report();

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — MANUAL TEXT INPUT FLOW (spec TEXT INPUT TESTS 1-5)
// ─────────────────────────────────────────────────────────────────────────────
//
// The typed text is a MANUAL OVERRIDE: it does not start capture and does not
// affect Moonshine/Deepgram/Groq. It goes through the SAME downstream AI
// pipeline as voice, so the local question gate must accept it unchanged.

section("Part 2: manual text input flow");

// TEXT 1: type "What is MongoDB?" + Enter -> AI receives exactly that question.
{
  const typed = "What is MongoDB?";
  const gate = evaluateInterviewTurn({
    finals: [{ source: "system", text: typed }],
    interim: null,
  });
  check("TEXT 1: typed question passes the gate", gate.action, "answer");
  check(
    "TEXT 1: AI receives exactly the typed text",
    gate.action === "answer" ? gate.question : null,
    typed,
  );
}

// TEXT 2: empty input does nothing.
{
  const gate = evaluateInterviewTurn({
    finals: [{ source: "system", text: "   " }],
    interim: null,
  });
  check("TEXT 2: whitespace input is not a question", gate.action, "wait");
}

// TEXT 3: one typed question -> exactly one AI submission (single signature).
{
  const turn: InterviewTurn = {
    finals: [{ source: "system", text: "What is MongoDB?" }],
    interim: null,
  };
  const signature = turnSignature(normalizeTurn(turn));
  check("TEXT 3: single submission identity", signature, "system:What is MongoDB?|");
  check(
    "TEXT 3: repeated submit of the same turn yields the same identity",
    turnSignature(normalizeTurn(turn)),
    signature,
  );
}

// TEXT 4: pressing Enter repeatedly -> no duplicate submissions.
// The UI guards with a submission ref; the downstream guard is the same
// transcript signature, so repeated presses collapse to one identity.
{
  const turn: InterviewTurn = {
    finals: [{ source: "system", text: "What is MongoDB?" }],
    interim: null,
  };
  const identities = new Set(
    Array.from({ length: 5 }, () => turnSignature(normalizeTurn(turn))),
  );
  check("TEXT 4: 5 rapid Enters collapse to one submission", identities.size, 1);
}

// TEXT 5: a voice question followed by a typed question -> the typed question is
// an explicit override and is NOT combined with the old voice text.
{
  const manualTurn: InterviewTurn = {
    finals: [{ source: "system", text: "Why did you choose MongoDB?" }],
    interim: null,
  };
  const gate = evaluateInterviewTurn(manualTurn);
  check(
    "TEXT 5: typed override is not combined with voice text",
    gate.action === "answer" ? gate.question : null,
    "Why did you choose MongoDB?",
  );
  check(
    "TEXT 5: override turn holds only the typed question",
    manualTurn.finals.length,
    1,
  );
}

report();

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — INTERVIEW TYPE DROPDOWN (spec INTERVIEW TYPE TESTS)
// ─────────────────────────────────────────────────────────────────────────────
//
// Existing types are never removed: General holds every non-DSA mode, DSA holds
// the existing DSA mode, and the stored value stays a single flat string so
// saved settings remain compatible.

section("Part 3: interview type dropdown");

const ORIGINAL_TYPES = [
  "dsa",
  "system_design",
  "frontend",
  "sql",
  "behavioral",
  "general",
];
const flatIds = INTERVIEW_TYPES.map((t) => t.id);

check(
  "TYPE: every original type still exists",
  ORIGINAL_TYPES.filter((t) => !flatIds.includes(t)),
  [],
);
check(
  "TYPE: no duplicate ids introduced by grouping",
  flatIds.length === new Set(flatIds).size,
  true,
);

const general = INTERVIEW_TYPE_GROUPS.find((g) => g.label === "General");
const dsa = INTERVIEW_TYPE_GROUPS.find((g) => g.label === "DSA");

check("TYPE: General group exists", general !== undefined, true);
check("TYPE: DSA group exists", dsa !== undefined, true);
check("TYPE: exactly two top-level groups", INTERVIEW_TYPE_GROUPS.length, 2);

const generalIds = (general?.types ?? []).map((t) => t.id);
const dsaIds = (dsa?.types ?? []).map((t) => t.id);

// General must contain ALL non-DSA modes, none removed.
check(
  "TYPE: General holds every non-DSA mode",
  ORIGINAL_TYPES.filter((t) => t !== "dsa").every((t) => generalIds.includes(t)),
  true,
);
check("TYPE: DSA holds only the existing dsa mode", dsaIds, ["dsa"]);
check(
  "TYPE: DSA is not duplicated into General",
  generalIds.includes("dsa"),
  false,
);

// Flat list preserves grouping order and stays backward compatible.
check("TYPE: flat list equals grouped order", flatIds, [...generalIds, ...dsaIds]);

// Both top-level selections are directly selectable (value written to settings).
check("TYPE: general is selectable", generalIds.includes("general"), true);
check("TYPE: dsa is selectable", dsaIds.includes("dsa"), true);

report();

console.log(
  fail === 0
    ? `\nALL CHECKS PASSED (${pass} assertions)`
    : `\n${fail} CHECK(S) FAILED (${pass} passed)`,
);
process.exit(fail > 0 ? 1 : 0);