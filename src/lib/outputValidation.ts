/**
 * Deterministic output validation for streamed answers.
 *
 * The interview pipeline has a careful deterministic **input** gate
 * (`evaluateInterviewTurn`) but historically had NO output gate: anything
 * non-empty that was not the literal string `WAIT` was accepted, streamed,
 * written to `sessionMessages` and `history`, and then fed back into the next
 * prompt as `previousAnswers` — so one degenerate response propagated.
 *
 * A real observed failure:
 *
 *   question: Why they use Java as our best backend language?
 *   answer:   Previously mentioned interview questions or requests
 *
 * That string exists nowhere in the repository: it is the model imitating the
 * Markdown headings of our own prompt template. This module is the structural
 * backstop for exactly that class of failure.
 *
 * ── Design rules ────────────────────────────────────────────────────────────
 * 1. MULTIPLE SIGNALS, never a word blacklist. Nothing here knows anything
 *    about interview topics, so it cannot reject a legitimate question about
 *    "trade", "closures", or anything else.
 * 2. NO MINIMUM-WORD RULE. "Yes." / "No." / "It's immutable." must all pass.
 *    A length threshold is explicitly forbidden by design.
 * 3. STRUCTURE ONLY. The signals are: empty, a known prompt label, our own
 *    delimiter echoed back, output that is entirely Markdown headings, or an
 *    answer that is just the question restated with nothing added.
 * 4. CONSERVATIVE BY DEFAULT. A false rejection is much worse than a false
 *    acceptance here: it silences a real answer during an interview. Every
 *    threshold below is deliberately permissive.
 */

/** Machine-readable reason an answer was rejected. */
export type AnswerRejectionReason =
  | "empty"
  | "prompt-label"
  | "delimiter-echo"
  | "heading-only"
  | "question-echo"
  // ── Strong structural artifact signals (see detectAnswerArtifact) ──────────
  | "artifact-delimiter"
  | "artifact-prompt-label"
  | "artifact-template"
  | "artifact-placeholder"
  | "artifact-instruction"
  | "artifact-numeric"
  | "artifact-meta"
  | "no-prose";

/**
 * Result of the structural artifact detector.
 *
 * Separate from {@link AnswerValidation} on purpose: the detector answers "is
 * this OURS instead of an answer?", while the answer validator additionally
 * applies shape heuristics (headings, labels, question-echo). Both are needed,
 * and keeping them apart makes each independently testable.
 */
export interface AnswerArtifact {
  artifact: boolean;
  reason?: AnswerRejectionReason;
  /** Short, non-secret description for the diagnostic log. */
  detail?: string;
}

export interface AnswerValidation {
  ok: boolean;
  /** Present only when `ok` is false. */
  reason?: AnswerRejectionReason;
  /** Short human-readable detail for the diagnostic log / retry banner. */
  detail?: string;
}

/**
 * Private application delimiters.
 *
 * `<<<…>>>` is our own prompt marker syntax and has no reason to appear in a
 * spoken interview answer. Presence anywhere — not just at the start — is a HARD
 * failure: the model is reproducing the harness rather than answering.
 */
const DELIMITER_RE = /<<<|>>>/;

/**
 * Internal label tokens.
 *
 * Underscore-joined ALL-CAPS tokens cannot occur in ordinary English prose, so
 * their presence is unambiguous evidence of prompt/pipeline leakage. This
 * includes the delimiters we use (`LATEST_QUESTION`, `BACKGROUND`, …) and the
 * stray artefacts observed in the wild (`ITEM_QUESTION`, `LATEST_TASK`,
 * `END_LATEST_TASK`, `INITIAL_QUESTION`, `INTERVIEW_QUESTION`, `WHAT IS
 * PROBLEMS`). Kept as OUR-strings-only, so it can never reject interview
 * vocabulary.
 */
const INTERNAL_LABEL_RE =
  /\b(ITEM_QUESTION|LATEST_TASK|END_LATEST_TASK|INITIAL_QUESTION|INTERVIEW_QUESTION|LATEST_QUESTION|END_LATEST_QUESTION|PREVIOUS_ANSWERS|END_PREVIOUS_ANSWERS|BACKGROUND|END_BACKGROUND|WHAT IS PROBLEMS)\b/;

/**
 * Distinctive strings that only exist in OUR instruction template.
 *
 * The model echoing any of these is reproducing the rulebook it was given, not
 * answering the candidate's question. All are long and specific enough that a
 * legitimate spoken answer will not contain them.
 */
const TEMPLATE_LEAK_PHRASES: string[] = [
  "live interview answering engine",
  "question detection you must perform internally",
  "output only the answer itself",
  "answer shaping",
  "never mention being an ai",
  "reply with exactly",
  "the only question that exists",
  "candidate context\nuse this to tailor",
  // Echo of the Groq-only answer directive (see `ai/groq.ts`). If a model
  // prints the directive back, it is reproducing its instructions, not
  // answering — reject it like any other template leak.
  "answer that question directly and immediately",
];

/**
 * META-RESPONSE patterns — the model talking ABOUT the task instead of
 * answering it.
 *
 * A real interview answer never asks for the question, requests clarification,
 * refuses to be useful, or refers to itself as an AI. These phrases are
 * therefore unambiguous meta-talk (exactly the same category as
 * {@link TEMPLATE_LEAK_PHRASES}: OUR/assistant strings, never interview
 * vocabulary), so substring matching cannot reject a legitimate answer. The
 * one short phrase kept here ("what is the question") only ever appears in a
 * response that is asking for the question — it is not a way to phrase an
 * answer about questions.
 *
 * Real observed failure this catches:
 *   "Okay. Please note: I will not provide unnecessary information unless
 *    directed."  (Groq `allam-2-7b`)
 */
const META_RESPONSE_RE = new RegExp(
  [
    // The exact observed refusal.
    "i (?:will|would|do) not provide unnecessary information",
    "unnecessary information unless directed",
    // Soliciting the question instead of answering it.
    "(?:please )?(?:ask me|ask us|give me|provide|send me) (?:the|a|your) question",
    "(?:please )?(?:ask|repeat|restate) (?:the|your|a) question",
    "what(?:'s| is) the question",
    "waiting for (?:the|your|a) question",
    "i (?:don'?t|do not) have (?:a|the) question",
    // Asking the user to clarify rather than answering.
    "please clarify(?: this| the)?(?: answer)?",
    "(?:the )?question is (?:unclear|incomplete|missing|not clear)",
    "no question (?:was )?provided",
    // Assistant self-reference.
    "(?:i(?:'m| am)|as) an? ai(?: language model)?",
    // Assistant-style refusals (never spoken by a candidate answering).
    "i (?:cannot|can'?t|can not) (?:assist|help)",
    // Leading refusal opener.
    "^okay[.,!]*\\s*please note",
    // Our own label, lower-cased.
    "^background details",
  ].join("|"),
  "i",
);

/**
 * Lines that read as template instructions rather than prose.
 *
 * Matched only in a high-density context (see {@link isInstructionTemplate}),
 * never individually — a real answer may legitimately begin a sentence with
 * "If the service…" or "Never do that…".
 */
const INSTRUCTION_LINE_RE =
  /^\s*(?:\d+[.)]\s*)?(?:never|do not|don't|always|you must|must not|answer only|output only|reply with|if the\b|use only)\b/i;

/** Placeholder tokens such as [insert here], {{company}}, <FIELD>, YOUR_NAME. */
const PLACEHOLDER_RE =
  /\[(?:insert|your|my|name|company|question|answer|example)[^\]]{0,40}\]|\{\{[^}]{1,40}\}\}|<[A-Z][A-Z_]{2,}>|\bYOUR_[A-Z_]{2,}\b/g;

/** A single token that is only digits / punctuation, with no letters. */
const NUMERIC_TOKEN_RE = /^[\d.,:%$+\-()/]+$/;

/**
 * Labels that appear in our own prompt template. A model that echoes one back
 * has produced a prompt artefact, not an answer.
 *
 * This is a list of OUR strings, not a list of interview vocabulary — adding
 * to it can never reject a legitimate answer.
 */
const PROMPT_LABEL_PATTERNS: RegExp[] = [
  // Markdown-heading form of the user prompt's sections.
  /^\s*#{1,6}\s*(latest|earlier|your)\b/i,
  // Bare-label form (heading markers stripped by a markdown renderer).
  /^\s*(latest interviewer utterance|earlier conversation|your earlier answers|candidate context|answer style)\b/i,
  // The closing instruction of the user prompt.
  /^\s*(now do the following|if the latest interviewer utterance)/i,
  // Bold/em variants of the same labels.
  /^\s*[*_]{1,2}\s*(latest interviewer utterance|earlier conversation|your earlier answers)\b/i,
];

/** The neutral delimiters used by `buildInterviewUserPrompt`. */
const DELIMITER_ECHO_PATTERNS: RegExp[] = [
  /^\s*<{2,}\s*(latest_question|background|previous_answers|end_latest_question|end_background|end_previous_answers)\b/i,
];

/**
 * Words that can only appear in a *spoken sentence*, never in a label.
 *
 * Used only as a supporting signal, and only in combination with several other
 * conditions — never on its own, and never as a topic blacklist. English
 * function/auxiliary vocabulary, which is what makes a fragment parseable as
 * an utterance rather than as a heading.
 */
const SENTENCE_MARKERS = new Set([
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "done",
  "have", "has", "had",
  "can", "could", "will", "would", "shall", "should", "may", "might", "must",
  "i", "we", "they", "he", "she", "it", "you",
  "my", "our", "their", "its", "your",
  // Subordinators only. Pure conjunctions ("and", "or", "but", "then") are
  // DELIBERATELY absent: they are exactly what headings are built from, so
  // including them let "Previously mentioned interview questions or requests"
  // read as a sentence.
  "because", "so", "that", "if", "when",
  "used", "use", "uses", "using", "made", "make", "makes",
  "get", "gets", "got", "need", "needs", "want", "wants",
  "took", "take", "tried", "try", "worked", "work", "works",
  "believe", "think", "feel", "wanted", "chose", "choose",
  "helped", "built", "handled", "learned", "prefer",
]);

/** Split into lowercase word tokens, dropping punctuation. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(Boolean);
}

/**
 * Strip Markdown decoration so we can judge the *content* of a line.
 * Returns "" when a line carried no prose at all (e.g. `---`, `***`).
 */
function stripMarkdown(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^\s*>\s*/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does the line look like a Markdown heading (setext or ATX)? */
function isMarkdownHeading(line: string): boolean {
  if (/^\s*#{1,6}\s+\S/.test(line)) return true;
  // Setext: a short line followed by === or ---
  return /^\s*(=+|-{3,})\s*$/.test(line);
}

/**
 * True when the response carries no prose — it is entirely headings, rules or
 * list markers.
 *
 * Deliberately requires *every* non-empty line to be Markdown. A bare sentence
 * with no `#` and no underline is prose, even without terminal punctuation,
 * because "It's mainly used for dependency injection" is a valid spoken answer.
 */
function isHeadingOnly(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return true;

  return lines.every(
    (line) => isMarkdownHeading(line) || stripMarkdown(line).length === 0,
  );
}

/**
 * True when the text reads as a *label* rather than a sentence.
 *
 * All four conditions must hold, which is what keeps this from touching real
 * answers:
 *   1. at least 3 words — "Yes", "No", "Correct", "Absolutely" are exempt;
 *   2. no sentence-terminating punctuation — a spoken answer ends in a stop;
 *   3. no sentence-marker word anywhere;
 *   4. short enough to be a heading (≤ 12 words).
 *
 * "Previously mentioned interview questions or requests" fails all four
 * (6 words, no terminator, no sentence marker) and is rejected.
 * "Yes I have" passes (3+ words but contains "i"/"have").
 * "It's mainly used for dependency injection" passes (contains "it"/"is"/"used").
 */
function readsAsLabel(text: string): boolean {
  const trimmed = text.trim();
  const words = tokenize(trimmed);
  if (words.length < 3) return false;
  if (words.length > 12) return false;
  if (/[.!?…]["')\]]?$/.test(trimmed)) return false;
  if (words.some((w) => SENTENCE_MARKERS.has(w))) return false;
  return true;
}

/**
 * True when the answer is the question restated with nothing added.
 *
 * Requires near-total containment of the answer's content words in the
 * question AND fewer than 4 content words, so "Yes." (0 overlap) and a real
 * short answer are untouched.
 */
function isQuestionEcho(answer: string, question?: string): boolean {
  if (!question?.trim()) return false;
  const answerWords = new Set(
    tokenize(answer).filter((w) => w.length > 2),
  );
  const questionWords = new Set(tokenize(question));
  if (answerWords.size === 0 || answerWords.size >= 4) return false;
  let shared = 0;
  for (const w of answerWords) if (questionWords.has(w)) shared++;
  return shared / answerWords.size >= 0.8;
}

// ── Structural artifact detector ────────────────────────────────────────────

/** k-word shingles over an alphabetic word stream. */
function shingles(words: string[], k: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + k <= words.length; i++) {
    out.add(words.slice(i, i + k).join(" "));
  }
  return out;
}

/**
 * Structural similarity to our instruction template (spec §4).
 *
 * Compares 5-word shingles of the answer against those of the template and
 * rejects when a large fraction of the answer is literally our own rules. The
 * caller passes the STATIC rules template only (`INTERVIEW_SYSTEM_PROMPT`),
 * never the assembled system message that also contains the candidate resume —
 * otherwise a legitimate answer that quotes the candidate's own experience
 * would look like a template echo.
 *
 * Requires a real sample size (≥ 8 answer shingles) and a high threshold (35%),
 * so ordinary English shared with the template cannot trip it.
 */
function isTemplateEcho(answer: string, promptTemplate?: string): boolean {
  if (!promptTemplate?.trim()) return false;
  const answerWords = answer.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  if (answerWords.length < 24) return false;
  const templateWords = promptTemplate.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  const templateShingles = shingles(templateWords, 5);
  if (templateShingles.size === 0) return false;
  const answerShingles = shingles(answerWords, 5);
  if (answerShingles.size < 8) return false;
  let overlap = 0;
  for (const s of answerShingles) if (templateShingles.has(s)) overlap++;
  return overlap / answerShingles.size >= 0.35;
}

/**
 * True when the output is a numbered rule list / imperative template rather
 * than prose. Requires BOTH many instruction-shaped lines AND them dominating
 * the response, so a normal answer that merely opens one sentence with "If the
 * service…" is untouched.
 */
function isInstructionTemplate(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 3) return false;
  const instructions = lines.filter((l) => INSTRUCTION_LINE_RE.test(l)).length;
  return instructions >= 3 && instructions / lines.length >= 0.5;
}

/**
 * True for a numeric / token dump.
 *
 * Deliberately requires MULTIPLE signals: either a numeric-heavy stream with
 * almost no words (two independent conditions), or one unbroken run of 8+
 * isolated integers, which is degenerate on its own. A legitimate technical
 * answer such as "Use HTTP 500 errors and 3 replicas" has plenty of words and
 * is never touched.
 */
function isNumericArtifact(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length >= 12) {
    const numeric = tokens.filter((t) => NUMERIC_TOKEN_RE.test(t)).length;
    const alpha = tokens.filter((t) => /[a-zA-Z]{2,}/.test(t)).length;
    if (numeric / tokens.length >= 0.4 && alpha / tokens.length <= 0.3) {
      return true;
    }
  }
  let run = 0;
  let maxRun = 0;
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      run++;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 0;
    }
  }
  return maxRun >= 8;
}

/** True when there is no meaningful natural-language content at all. */
function isNoProse(text: string): boolean {
  const nonSpace = text.replace(/\s+/g, "");
  if (nonSpace.length < 4) return false;
  const letters = (text.match(/[a-zA-Z]/g) ?? []).length;
  if (letters === 0) return true;
  return letters / nonSpace.length < 0.2;
}

/**
 * Detect STRUCTURAL prompt leakage / malformed output.
 *
 * This is the hard backstop the UI relies on: a provider whose text trips any
 * signal here must never win and must never render. It uses multiple independent
 * structural signals and never a topic blacklist, so it cannot reject a normal
 * answer that merely contains words like "question" or "task".
 */
export function detectAnswerArtifact(
  text: string,
  opts: { promptTemplate?: string } = {},
): AnswerArtifact {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) {
    return { artifact: true, reason: "empty", detail: "empty response" };
  }

  // 1. Application-private delimiters — a HARD failure anywhere in the text.
  if (DELIMITER_RE.test(trimmed)) {
    return {
      artifact: true,
      reason: "artifact-delimiter",
      detail: "answer contained a private <<< … >>> marker",
    };
  }

  // 2. Internal underscore-joined labels (LATEST_TASK, ITEM_QUESTION, …).
  const label = trimmed.match(INTERNAL_LABEL_RE);
  if (label) {
    return {
      artifact: true,
      reason: "artifact-prompt-label",
      detail: `answer contained an internal label: ${label[1]}`,
    };
  }

  // 3. Distinctive phrase lifted from our instruction template.
  const lower = trimmed.toLowerCase();
  for (const phrase of TEMPLATE_LEAK_PHRASES) {
    if (lower.includes(phrase)) {
      return {
        artifact: true,
        reason: "artifact-template",
        detail: "answer reproduced an instruction-template phrase",
      };
    }
  }

  // 3b. Meta-response: asking for the question, requesting clarification, or
  // refusing to answer. A real answer never does any of these.
  if (META_RESPONSE_RE.test(trimmed)) {
    return {
      artifact: true,
      reason: "artifact-meta",
      detail: "answer was a meta-response (asked for the question or refused)",
    };
  }

  // 4. Unfilled placeholder blocks.
  const placeholders = trimmed.match(PLACEHOLDER_RE) ?? [];
  if (placeholders.length >= 2) {
    return {
      artifact: true,
      reason: "artifact-placeholder",
      detail: `answer contained ${placeholders.length} unfilled placeholders`,
    };
  }

  // 5. Instruction-shaped output rather than prose.
  if (isInstructionTemplate(trimmed)) {
    return {
      artifact: true,
      reason: "artifact-instruction",
      detail: "answer was an instruction-style template, not prose",
    };
  }

  // 6. Numeric / token dump.
  if (isNumericArtifact(trimmed)) {
    return {
      artifact: true,
      reason: "artifact-numeric",
      detail: "answer was a numeric/token dump",
    };
  }

  // 7. Structural echo of the instruction template.
  if (isTemplateEcho(trimmed, opts.promptTemplate)) {
    return {
      artifact: true,
      reason: "artifact-template",
      detail: "answer was structurally similar to the instruction template",
    };
  }

  // 8. No meaningful natural-language content.
  if (isNoProse(trimmed)) {
    return {
      artifact: true,
      reason: "no-prose",
      detail: "answer had no meaningful natural-language content",
    };
  }

  return { artifact: false };
}

/**
 * Validate a completed (or partial) answer.
 *
 * @param text   The answer text as received from the provider.
 * @param opts.question The question this run was answering, when known. Used
 *   only for the question-echo signal.
 * @param opts.promptTemplate Our STATIC instruction template, when available,
 *   used only for the structural prompt-echo check (never logged).
 */
export function validateAnswerOutput(
  text: string,
  opts: { question?: string; promptTemplate?: string } = {},
): AnswerValidation {
  const trimmed = (text ?? "").trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: "empty", detail: "empty response" };
  }

  // Structural prompt-leak / malformed-output backstop. Runs BEFORE every other
  // check so a leaked response can never slip through on a technicality.
  const artifact = detectAnswerArtifact(trimmed, {
    promptTemplate: opts.promptTemplate,
  });
  if (artifact.artifact) {
    return {
      ok: false,
      reason: artifact.reason ?? "artifact-template",
      detail: artifact.detail ?? "answer rejected as a prompt artefact",
    };
  }

  for (const pattern of PROMPT_LABEL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        reason: "prompt-label",
        detail: `output starts with a prompt label: ${trimmed.slice(0, 60)}`,
      };
    }
  }

  for (const pattern of DELIMITER_ECHO_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        reason: "delimiter-echo",
        detail: `output echoed a prompt delimiter: ${trimmed.slice(0, 60)}`,
      };
    }
  }

  if (isHeadingOnly(trimmed)) {
    return {
      ok: false,
      reason: "heading-only",
      detail: `output was headings only: ${trimmed.slice(0, 60)}`,
    };
  }

  if (readsAsLabel(trimmed)) {
    return {
      ok: false,
      reason: "heading-only",
      detail: `output read as a label, not a sentence: ${trimmed.slice(0, 60)}`,
    };
  }

  if (isQuestionEcho(trimmed, opts.question)) {
    return {
      ok: false,
      reason: "question-echo",
      detail: "output only restated the question",
    };
  }

  return { ok: true };
}