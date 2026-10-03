/**
 * TEMPORARY verification harness (deleted after the run).
 *
 * Covers the question gate, the transcript-quality layer, the output validator
 * and the new prompt structure. Pure functions only — no audio, no network.
 */
import {
  analyseUtterance,
  buildInterviewSystemPrompt,
  buildInterviewUserPrompt,
  evaluateInterviewTurn,
  isDuplicateSubmit,
  isWaitResponse,
  normalizeTurn,
  turnSignature,
  type InterviewTurn,
} from "../src/lib/interviewAgent";
import { assessTranscriptQuality } from "../src/lib/transcriptQuality";
import { validateAnswerOutput } from "../src/lib/outputValidation";
import { normalizeTechnicalTerms } from "../src/lib/normalization";
import {
  OPENROUTER_FREE_MODEL,
  isOpenRouterFreeModel,
  parseOpenRouterEvent,
} from "../src/lib/ai/openrouter";
import {
  getAudioLevel,
  pushAudioLevel,
  resetAudioStatus,
  resolveAudioState,
  setAudioStatus,
  getAudioStatusSnapshot,
} from "../src/lib/audioStatus";
import {
  INTERVIEW_PROVIDER_ORDER,
  describeProviderChain,
  normalizeProviderOrder,
} from "../src/lib/providerDiagnostics";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

const turn = (text: string, interim?: string): InterviewTurn => ({
  finals: [{ source: "system", text }],
  interim: interim ? { source: "system", text: interim } : null,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. GATE — required legitimate interview questions must be ANSWERED
// ─────────────────────────────────────────────────────────────────────────────
const MUST_ANSWER = [
  "Can you explain the difference between SQL and NoSQL?",
  "What is the Virtual DOM?",
  "Why did you choose Java for this project?",
  "Tell me about your project.",
  "How would you design a URL shortener?",
  "Can you walk me through your authentication flow?",
  "Why should we hire you?",
  // topic-agnostic checks
  "What is a closure?",
  "How would you solve this problem?",
  "What is the time complexity?",
  "How does JWT authentication work?",
  "Explain your project architecture.",
  "What challenges did you face?",
  "And why?",
  "What would you change?",
  "Can you explain that further?",
  // short / declarative interview requests
  "Difference between SQL and NoSQL.",
  "Tell me about dependency injection.",
  "Your experience with React?",
  // short follow-ups must NOT be over-rejected
  "Tell me about yourself.",
  "Explain the CAP theorem.",
  "What is polymorphism?",
  "And why not?",
];

for (const q of MUST_ANSWER) {
  check(
    `gate answers: "${q}"`,
    evaluateInterviewTurn(turn(q)).action,
    "answer",
  );
}

// The interviewer speaking over the candidate's question => WAIT.
check(
  "interim present => wait",
  evaluateInterviewTurn(turn("What is the CAP theorem?", "and how does that")).action,
  "wait",
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. GATE — must WAIT
// ─────────────────────────────────────────────────────────────────────────────
const MUST_WAIT = [
  "Okay... yes... right...",
  "thanks",
  "sounds good",
  "sure",
  "I have worked with Node.js and recently",
  "Can you explain",
  "Let me walk you through the problem",
  "I have seen this before in a similar system",
];

for (const q of MUST_WAIT) {
  check(`gate waits: "${q}"`, evaluateInterviewTurn(turn(q)).action, "wait");
}

check(
  "candidate speech => wait",
  evaluateInterviewTurn({
    finals: [
      { source: "system", text: "What is the CAP theorem?" },
      { source: "mic", text: "I would pick consistency here" },
    ],
    interim: null,
  }).action,
  "wait",
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. TRANSCRIPT QUALITY — structural ASR artefacts must not become questions
// ─────────────────────────────────────────────────────────────────────────────
for (const junk of [
  "(no speech recognised)",
  "(no speech recognized)",
  "[BLANK_AUDIO]",
  "(silence)",
  "Mustam a land or mustam a land",
  "the the the the the the",
]) {
  check(
    `artefact rejected: "${junk}"`,
    assessTranscriptQuality(junk).ok,
    false,
  );
  check(
    `artefact => gate waits: "${junk}"`,
    evaluateInterviewTurn(turn(junk)).action,
    "wait",
  );
}

// Real questions must survive the artefact layer untouched.
for (const q of ["What is your trade on?", "Can you explain that again?"]) {
  check(`artefact layer allows: "${q}"`, assessTranscriptQuality(q).ok, true);
  check(
    `artefact layer keeps gate: "${q}"`,
    evaluateInterviewTurn(turn(q)).action,
    "answer",
  );
}

// A genuine repetition of two DIFFERENT phrases must not be flagged.
check(
  "different halves are not a doubled phrase",
  assessTranscriptQuality(
    "I worked at Google and I worked at Microsoft",
  ).ok,
  true,
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. OUTPUT VALIDATOR — degenerate output rejected
// ─────────────────────────────────────────────────────────────────────────────
const REJECT: Array<[string, string]> = [
  ["Previously mentioned interview questions or requests", ""],
  ["# Latest interviewer utterance", "What is the CAP theorem?"],
  ["# Earlier conversation", "What is the CAP theorem?"],
  ["# Your earlier answers", "What is the CAP theorem?"],
  ["Now do the following: if the latest interviewer utterance", "Explain closures."],
  ["<<<LATEST_QUESTION>>>", "Explain closures."],
  ["<<<END_PREVIOUS_ANSWERS>>>", "Explain closures."],
  ["**Latest interviewer utterance**", "Explain closures."],
  ["## Analysis", "Explain closures."],
  ["---", "Explain closures."],
  ["CAP theorem", "Explain the CAP theorem."],
  ["   ", "Explain closures."],
  ["", "Explain closures."],
];

for (const [answer, question] of REJECT) {
  check(
    `validator rejects: "${answer}"`,
    validateAnswerOutput(answer, { question }).ok,
    false,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. OUTPUT VALIDATOR — legitimate short answers MUST survive
// ─────────────────────────────────────────────────────────────────────────────
const ACCEPT = [
  "Yes.",
  "No.",
  "Yes, I have.",
  "It's mainly used for dependency injection.",
  "Because it is immutable.",
  "Yes I have",
  "It's mainly used for dependency injection",
  "Yes",
  "No",
  "Correct",
  "Absolutely",
  "I would pick consistency and availability, and accept eventual consistency for the write path.",
  "It depends on the isolation level; under read committed you can still see phantoms.",
  "We used Redis for the rate limiter and Postgres as the source of truth.",
  "Because the interviewer changed the default output device mid-interview.",
  "Polymorphism lets you program to an interface rather than a concrete type.",
];

for (const answer of ACCEPT) {
  check(
    `validator accepts: "${answer}"`,
    validateAnswerOutput(answer, { question: "Why should we hire you?" }).ok,
    true,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. WAIT detection
// ─────────────────────────────────────────────────────────────────────────────
for (const w of ["WAIT", "wait", "WAIT.", "**WAIT**", '"WAIT"', "WAIT — no clear question"]) {
  check(`isWaitResponse: "${w}"`, isWaitResponse(w), true);
}
for (const w of ["Yes.", "No, it does not.", "Wait, let me think about that."]) {
  check(`isWaitResponse false: "${w}"`, isWaitResponse(w), false);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. NORMALIZATION — corrections only, still idempotent
// ─────────────────────────────────────────────────────────────────────────────
const NORMALIZE: Array<[string, string]> = [
  ["what is virtual down", "what is Virtual DOM"],
  ["post grass", "PostgreSQL"],
  ["spring boat", "Spring Boot"],
  ["mongo dee", "MongoDB"],
  ["node jay ess", "Node.js"],
  ["rest ape", "REST API"],
  ["use eh-fekt", "useEffect"],
  ["what is your trade on", "what is your trade on"],
  ["i rendered the component", "i rendered the component"],
  ["the state of hooks", "the state of hooks"],
];
for (const [raw, expected] of NORMALIZE) {
  check(`normalize: "${raw}"`, normalizeTechnicalTerms(raw), expected);
}
check(
  "normalize is idempotent",
  normalizeTechnicalTerms(normalizeTechnicalTerms("what is virtual down")),
  "what is Virtual DOM",
);

// ─────────────────────────────────────────────────────────────────────────────
// 8. PROMPT STRUCTURE — neutral delimiters, no Markdown headings
// ─────────────────────────────────────────────────────────────────────────────
const t: InterviewTurn = {
  finals: [
    { source: "system", text: "Can you explain the difference between SQL and NoSQL?" },
    { source: "mic", text: "I would start with consistency" },
    { source: "system", text: "Why is that?" },
  ],
  interim: null,
};
const userPrompt = buildInterviewUserPrompt(t, {
  questionIndex: 2,
  previousAnswers: ["SQL is relational, NoSQL is not."],
});

for (const marker of [
  "<<<LATEST_QUESTION>>>",
  "<<<END_LATEST_QUESTION>>>",
  "<<<BACKGROUND>>>",
  "<<<END_BACKGROUND>>>",
  "<<<PREVIOUS_ANSWERS>>>",
  "<<<END_PREVIOUS_ANSWERS>>>",
]) {
  check(`prompt has ${marker}`, userPrompt.includes(marker), true);
}
check(
  "prompt has no Markdown headings",
  /^#{1,6}\s/m.test(userPrompt),
  false,
);
check(
  "prompt does not leak candidate profile",
  buildInterviewUserPrompt(t, { questionIndex: 2 }).includes("## Company"),
  false,
);

const sys = buildInterviewSystemPrompt({ resumeText: "SECRET RESUME" });
check("system prompt carries the profile", sys.includes("SECRET RESUME"), true);
check("user prompt never carries the profile", userPrompt.includes("SECRET RESUME"), false);

// ─────────────────────────────────────────────────────────────────────────────
// 9. Turn merging, signature and duplicate guard
// ─────────────────────────────────────────────────────────────────────────────
const split: InterviewTurn = {
  finals: [
    { source: "system", text: "Can you explain" },
    { source: "system", text: "the CAP theorem" },
  ],
  interim: null,
};
check("fragments merge", normalizeTurn(split).finals.length, 1);

const followUp: InterviewTurn = {
  finals: [
    { source: "system", text: "What is the CAP theorem?" },
    { source: "system", text: "And why?" },
  ],
  interim: null,
};
check("follow-up stays separate", normalizeTurn(followUp).finals.length, 2);

check(
  "duplicate in-flight is blocked",
  isDuplicateSubmit({ signature: turnSignature(split), status: "in-flight" }, turnSignature(split)),
  true,
);
check(
  "duplicate ok is blocked",
  isDuplicateSubmit({ signature: turnSignature(split), status: "ok" }, turnSignature(split)),
  true,
);
check(
  "failed run is re-submittable",
  isDuplicateSubmit({ signature: turnSignature(split), status: "failed" }, turnSignature(split)),
  false,
);
check(
  "different turn is not a duplicate",
  isDuplicateSubmit({ signature: turnSignature(split), status: "ok" }, turnSignature(followUp)),
  false,
);

check("analyse: filler", analyseUtterance("okay").kind, "wait");
check("analyse: question", analyseUtterance("What is a closure?").kind, "question");

// ─────────────────────────────────────────────────────────────────────────────
// 10. SHORT IMPERATIVE REQUESTS (topic-agnostic, no whitelist, no min-word rule)
// ─────────────────────────────────────────────────────────────────────────────
const SHORT_REQUESTS = [
  "Explain Docker",
  "What is Docker?",
  "Explain Spring Boot",
  "Why Java?",
  "And why?",
  "Difference between SQL and NoSQL.",
  "Tell me about yourself.",
  "What about your project?",
  "Your experience with React?",
  // unexpected / unrelated topics must behave identically
  "What is the capital of Japan?",
  "Who invented the World Wide Web?",
  "Explain Kubernetes",
  "Describe your migration",
  "Tell me about a difficult bug.",
];
for (const q of SHORT_REQUESTS) {
  check(`gate answers short request: "${q}"`, evaluateInterviewTurn(turn(q)).action, "answer");
}

// Structural request verbs + a real question must NOT be treated as a topic list.
check(
  "unknown imperative verb is still WAIT (no request shape)",
  evaluateInterviewTurn(turn("Blorp the quux")).action,
  "wait",
);
// Resume questions with no technology keywords at all.
for (const q of [
  "Tell me about the second project on your resume.",
  "What did you personally contribute?",
  "How did you deploy it?",
  "What challenges did you face?",
]) {
  check(`gate answers resume question: "${q}"`, evaluateInterviewTurn(turn(q)).action, "answer");
}
// Genuine garbage that must NOT become a question.
for (const q of ["An external data.", "Hmm, international problem."]) {
  check(`gate waits on narration: "${q}"`, evaluateInterviewTurn(turn(q)).action, "wait");
}
// Mishearings that LOOK like questions must still be answered — the gate must
// not blacklist unfamiliar words to suppress them.
for (const q of [
  "What is spring wood?",
  "What is this tape being?",
  "Why did the rest appear?",
]) {
  check(`gate does not blacklist odd wording: "${q}"`, evaluateInterviewTurn(turn(q)).action, "answer");
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. PROVIDER ROUTING — OpenRouter free router + chain construction
// ─────────────────────────────────────────────────────────────────────────────
check("openrouter/free is the router id", OPENROUTER_FREE_MODEL, "openrouter/free");
check("free router detected", isOpenRouterFreeModel("openrouter/free"), true);
check("a fixed model is not the router", isOpenRouterFreeModel("openai/gpt-oss-120b"), false);

// OpenRouter reports the model it actually served in the top-level `model` field.
const freeChunk = parseOpenRouterEvent({
  model: "upstage/solar-pro-3:free",
  provider: "upstage",
  choices: [{ delta: { content: "hi" } }],
});
check("resolved model parsed", freeChunk.model, "upstage/solar-pro-3:free");
check("backend parsed", freeChunk.provider, "upstage");
check("content parsed", freeChunk.text, "hi");
check("no finish reason yet", freeChunk.finishReason, undefined);

const doneChunk = parseOpenRouterEvent({
  model: "upstage/solar-pro-3:free",
  choices: [{ delta: {}, finish_reason: "stop" }],
});
check("finish reason parsed", doneChunk.finishReason, "stop");

const errChunk = parseOpenRouterEvent({ error: { message: "no free model available" } });
check("inline error surfaced", errChunk.error, "no free model available");

// Chain construction must only include providers that actually have a key.
const buildChain = (
  order: string[],
  keys: Record<string, string>,
  models: Record<string, string>,
) =>
  order
    .filter((p) => (keys[p] ?? "").trim())
    .map((p) => ({
      provider: p,
      model: models[p],
      fallbackModels:
        p === "openrouter" && isOpenRouterFreeModel(models[p])
          ? []
          : [`${p}-alt`],
    }));

check(
  "chain includes only providers with keys",
  buildChain(
    ["openrouter", "nvidia", "gemini"],
    { openrouter: "k1", nvidia: "", gemini: "k3" },
    { openrouter: OPENROUTER_FREE_MODEL, nvidia: "meta/llama-3.3-70b-instruct", gemini: "gemini-2.5-flash" },
  ).map((a) => a.provider),
  ["openrouter", "gemini"],
);
check(
  "openrouter is first when configured",
  buildChain(
    ["openrouter", "groq", "nvidia"],
    { openrouter: "k1", groq: "k2", nvidia: "k3" },
    { openrouter: OPENROUTER_FREE_MODEL, groq: "g", nvidia: "n" },
  ).map((a) => a.provider),
  ["openrouter", "groq", "nvidia"],
);
check(
  "free router never gets a catalog-wide fallback",
  buildChain(["openrouter"], { openrouter: "k" }, { openrouter: OPENROUTER_FREE_MODEL })[0]
    .fallbackModels.length,
  0,
);
check(
  "a fixed model still gets a fallback",
  buildChain(["openrouter"], { openrouter: "k" }, { openrouter: "openai/gpt-oss-120b" })[0]
    .fallbackModels.length,
  1,
);

// ─────────────────────────────────────────────────────────────────────────────
// 12. AUDIO STATUS — state machine + smoothing (no raw RMS exposed)
// ─────────────────────────────────────────────────────────────────────────────
resetAudioStatus();
check("initial state is idle", getAudioStatusSnapshot().state, "idle");

// The time-dependent branch is tested through the pure resolver.
check(
  "sustained silence => no-audio",
  resolveAudioState({ rms: 0, speaking: false, silentForMs: 3000, current: "listening" }),
  "no-audio",
);
check(
  "brief silence stays listening",
  resolveAudioState({ rms: 0, speaking: false, silentForMs: 100, current: "listening" }),
  "listening",
);
check(
  "silence is never an error",
  resolveAudioState({ rms: 0, speaking: false, silentForMs: 3000, current: "listening" }) === "error",
  false,
);
check(
  "speech wins over silence timer",
  resolveAudioState({ rms: 0, speaking: true, silentForMs: 9000, current: "no-audio" }),
  "speech",
);
check(
  "transcribing is not clobbered by a level sample",
  resolveAudioState({ rms: 0.01, speaking: false, silentForMs: 0, current: "transcribing" }),
  "transcribing",
);
check(
  "disconnected is sticky",
  resolveAudioState({ rms: 0.2, speaking: true, silentForMs: 0, current: "disconnected" }),
  "disconnected",
);
check(
  "error is sticky",
  resolveAudioState({ rms: 0.2, speaking: true, silentForMs: 0, current: "error" }),
  "error",
);

// Live signal + meter.
resetAudioStatus();
check("initial state is idle", getAudioStatusSnapshot().state, "idle");
pushAudioLevel(0.05, true);
check("speech => speech state", getAudioStatusSnapshot().state, "speech");
check("level rose above zero", getAudioLevel() > 0, true);
pushAudioLevel(10, true);
check("level never exceeds 100", getAudioLevel() <= 100, true);
for (let i = 0; i < 400; i++) pushAudioLevel(0, false);
check("level never goes negative", getAudioLevel() >= 0, true);

// A disconnected capture must not be silently reset by later level samples.
setAudioStatus("disconnected", "device removed");
pushAudioLevel(0.3, true);
check("disconnect survives a late level sample", getAudioStatusSnapshot().state, "disconnected");
check("disconnect detail preserved", getAudioStatusSnapshot().detail, "device removed");

resetAudioStatus();

// ─────────────────────────────────────────────────────────────────────────────
// 13. FULL FOUR-PROVIDER CHAIN — OpenRouter → Groq → NVIDIA → Gemini
// ─────────────────────────────────────────────────────────────────────────────
check(
  "canonical interview chain order",
  INTERVIEW_PROVIDER_ORDER,
  ["openrouter", "groq", "nvidia", "gemini"],
);

// A legacy store holding ["groq","gemini"] with an OpenRouter key must be
// rewritten so OpenRouter leads and NVIDIA is present.
const migrated = normalizeProviderOrder(["groq", "gemini"], {
  openrouter: "k-or",
  groq: "k-groq",
  gemini: "k-gem",
});
check(
  "legacy order migrates to the full chain",
  migrated,
  ["openrouter", "groq", "nvidia", "gemini"],
);

// Without an OpenRouter key, the chain still reads in canonical order; OpenRouter
// is skipped at run time by the key filter, not by being removed from settings.
check(
  "no OpenRouter key => canonical order preserved",
  normalizeProviderOrder(["groq", "gemini"], { groq: "k" }),
  ["openrouter", "groq", "nvidia", "gemini"],
);

// Unknown/removed providers are dropped; known ones the user already had are kept.
check(
  "unknown providers dropped",
  normalizeProviderOrder(["whisper", "groq", "openrouter"], { groq: "k" }),
  ["openrouter", "groq", "nvidia", "gemini"],
);

// ── Diagnostics must explain WHY a provider was skipped ───────────────────
const full = describeProviderChain({
  providerOrder: ["openrouter", "groq", "nvidia", "gemini"],
  models: {
    openrouter: OPENROUTER_FREE_MODEL,
    groq: "openai/gpt-oss-120b",
    nvidia: "meta/llama-3.3-70b-instruct",
    gemini: "gemini-2.5-flash",
  },
  apiKeys: { openrouter: "k", nvidia: "k" },
});

check(
  "configured chain shows all four",
  full.configured,
  "openrouter(openrouter/free) → groq(openai/gpt-oss-120b) → nvidia(meta/llama-3.3-70b-instruct) → gemini(gemini-2.5-flash)",
);
check(
  "resolved chain only contains providers with keys",
  full.resolved,
  "openrouter(openrouter/free) → nvidia(meta/llama-3.3-70b-instruct)",
);
const byName = Object.fromEntries(full.status.map((s) => [s.provider, s]));
check("openrouter ready", byName.openrouter.availability, "ready");
check("groq skipped for missing key", byName.groq.availability, "missing-api-key");
check("groq reason is explicit", byName.groq.detail, "no API key");
check("nvidia ready", byName.nvidia.availability, "ready");
check("gemini skipped for missing key", byName.gemini.availability, "missing-api-key");
check(
  "every provider appears in the log lines",
  full.lines.some((l) => l.includes("GROQ") && l.includes("SKIPPED")),
  true,
);
check(
  "log states the configured chain first",
  full.lines[0].startsWith("[AI] configured provider chain:"),
  true,
);
check(
  "log states the resolved chain",
  full.lines[1].startsWith("[AI] resolved interview provider chain:"),
  true,
);

// A provider with a key but disabled in the chain is reported differently.
const offChain = describeProviderChain({
  providerOrder: ["openrouter"],
  models: { openrouter: OPENROUTER_FREE_MODEL, groq: "g" },
  apiKeys: { openrouter: "k", groq: "k" },
});
const offByName = Object.fromEntries(offChain.status.map((s) => [s.provider, s]));
check("keyed but disabled => not-in-chain", offByName.groq.availability, "not-in-chain");
check(
  "not-in-chain reason is explicit",
  offByName.groq.detail,
  "not in the configured chain",
);

// No keys at all must not crash or claim a working chain.
const noKeys = describeProviderChain({
  providerOrder: ["openrouter", "groq", "nvidia", "gemini"],
  models: {},
  apiKeys: {},
});
check(
  "no keys => resolved chain says none",
  noKeys.resolved,
  "(none — no provider has an API key)",
);

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}