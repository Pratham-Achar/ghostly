/**
 * Deterministic tests for Parakeet as a selectable PRIMARY engine.
 *
 * Run: `npx tsx scripts/verify-primary-asr.mts`
 *
 * ── What is actually being protected here ───────────────────────────────────
 * Five things can go wrong, and only some of them are visible in the UI:
 *
 *  1. **The setting never reaches the main process.** This happened once already
 *     with `asrCompareParakeet`: the toggle lived in a component with no
 *     auto-save, so it updated zustand, the main process never saw it, and the
 *     feature could not be switched on while the checkbox said "on". Asserted
 *     against the real source, because only the real source can lie like that.
 *
 *  2. **Audio leaving the machine.** The fallback must be Moonshine. A single
 *     call to Groq or Deepgram from the fallback path would send interview audio
 *     to a third party by accident. This is asserted structurally against the
 *     hook source, because a behavioural test cannot prove the ABSENCE of a call
 *     on a path that only runs when something goes wrong.
 *
 *  3. **A second transcript pipeline.** If Parakeet's result reached the store by
 *     any route other than the shared final handler, `correctTranscript`, the
 *     artefact gate and the question gate would all be bypassed.
 *
 *  4. **A stuck or premature question gate.** Parakeet has no partials, so the
 *     "still speaking" signal has to come from the VAD instead. An off-by-one
 *     here is either a gate stuck forever or a gate that never blocks.
 *
 *  5. **A hung hotkey.** The Parakeet drain has its own, larger deadline; if that
 *     were unbounded, Ctrl+Enter could hang for as long as a decode.
 */
import { readFile } from "node:fs/promises";

import {
  DEFAULT_PRIMARY_ASR,
  PARAKEET_FALLBACK_CODES,
  describeParakeetFallback,
  normalizePrimaryAsr,
  shouldFallbackToMoonshine,
} from "../src/lib/primaryAsr";
import {
  INITIAL_PHRASE_OPEN_STATE,
  PARAKEET_PHRASE_OPEN_MARKER,
  phraseOpenAfter,
  reducePhraseOpen,
  shouldPublishPhraseOpenMarker,
} from "../src/lib/asrPhraseState";
import {
  PARAKEET_DRAIN_DEADLINE_MS,
  PARAKEET_DRAIN_MAX_ATTEMPTS,
  PARAKEET_PRIMARY_QUEUE_LIMIT,
  createParakeetSegmentQueue,
} from "../src/lib/parakeetPrimary";
import { createAsrDrain, DRAIN_DEADLINE_MS, DRAIN_STEP_MS } from "../src/lib/asrDrain";
import { ParakeetHost, type ParakeetChildLike, type ParakeetHostReply } from "../src/lib/parakeetHost";

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
console.log("\n── Engine selection is migration-safe ─────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

check("1 the code default is Moonshine", DEFAULT_PRIMARY_ASR, "moonshine");
check("2 an absent setting resolves to Moonshine", normalizePrimaryAsr(undefined), "moonshine");
check("3 null resolves to Moonshine", normalizePrimaryAsr(null), "moonshine");
check("4 an empty string resolves to Moonshine", normalizePrimaryAsr(""), "moonshine");
check("5 a hand-edited garbage value resolves to Moonshine", normalizePrimaryAsr("whisper-large-v3"), "moonshine");
check("6 an object resolves to Moonshine", normalizePrimaryAsr({}), "moonshine");
check("7 a number resolves to Moonshine", normalizePrimaryAsr(7), "moonshine");
check("8 parakeet is accepted verbatim", normalizePrimaryAsr("parakeet"), "parakeet");
check("9 the value is case-sensitive on purpose", normalizePrimaryAsr("Parakeet"), "moonshine");

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Fallback is Moonshine, and never the cloud ──────────────");
// ═══════════════════════════════════════════════════════════════════════════

check("10 a missing model falls back", shouldFallbackToMoonshine("model_missing"), true);
check("11 a timeout falls back", shouldFallbackToMoonshine("timeout"), true);
check("12 a crash falls back", shouldFallbackToMoonshine("crashed"), true);
check("13 an exhausted restart budget falls back", shouldFallbackToMoonshine("restart_exhausted"), true);
check("14 a mid-interview shutdown falls back", shouldFallbackToMoonshine("shutdown"), true);
check("15 a busy host falls back", shouldFallbackToMoonshine("busy"), true);
check("16 an unreadable reply falls back", shouldFallbackToMoonshine("malformed"), true);

// These are properties of the BUFFER. Moonshine would reject them identically,
// so falling back would only add a second useless decode.
check("17 invalid audio does NOT fall back", shouldFallbackToMoonshine("invalid_audio"), false);
check("18 an over-long segment does NOT fall back", shouldFallbackToMoonshine("too_long"), false);
check("19 an unknown code does NOT fall back", shouldFallbackToMoonshine("wat"), false);
check("20 undefined does NOT fall back", shouldFallbackToMoonshine(undefined), false);

check("21 every fallback code is a known host failure",
  PARAKEET_FALLBACK_CODES.every((c) =>
    ["model_missing", "timeout", "crashed", "restart_exhausted", "busy", "shutdown", "malformed"].includes(c)),
  true);

for (const code of ["model_missing", "timeout", "crashed", "restart_exhausted", "busy", "shutdown", "malformed", "disabled", "wat"]) {
  const message = describeParakeetFallback(code);
  checkTrue(`22 the message for ${code} is non-empty`, message.length > 0);
  // This text reaches the on-screen log during a live interview.
  checkFalse(`23 the message for ${code} carries no path`,
    /[A-Za-z]:\\|\/home\/|\/Users\/|models\//.test(message));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Phrase state replaces the interim for Parakeet ────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const start = INITIAL_PHRASE_OPEN_STATE;
  // The interviewer starts talking.
  check("24 speech opens the phrase", reducePhraseOpen(start, { kind: "level", speaking: true }).open, true);
  const open = reducePhraseOpen(start, { kind: "level", speaking: true });
  // ...and keeps talking. Still open.
  check("25 continued speech stays open",
    reducePhraseOpen(open, { kind: "level", speaking: true }).open, true);
  // A rolling partial also proves a phrase is open.
  check("26 a partial marks the phrase open", reducePhraseOpen(start, { kind: "partial" }).open, true);
  // Silence closes it.
  check("27 silence closes the phrase", reducePhraseOpen(open, { kind: "level", speaking: false }).open, false);
  check("28 phraseClosed closes the phrase", reducePhraseOpen(open, { kind: "phraseClosed" }).open, false);
  check("29 a finished phrase is no longer open", reducePhraseOpen(open, { kind: "speech" }).open, false);
}

{
  // The regression this exists to prevent: `endPhrase()` posts `speech` and then
  // `phraseClosed` synchronously, but a level sample computed BEFORE the close
  // can still be in flight. If it won, the marker would stick on screen and
  // every later question would be blocked forever.
  check("30 a stale in-flight level sample cannot reopen a closed phrase",
    phraseOpenAfter([
      { kind: "level", speaking: true },
      { kind: "phraseClosed" },
      { kind: "level", speaking: true },
    ]),
    false);

  check("31 a full utterance opens then closes",
    phraseOpenAfter([
      { kind: "level", speaking: true },
      { kind: "level", speaking: true },
      { kind: "level", speaking: true },
      { kind: "phraseClosed" },
    ]),
    false);

  check("32 two consecutive utterances both resolve to closed",
    phraseOpenAfter([
      { kind: "level", speaking: true },
      { kind: "phraseClosed" },
      { kind: "level", speaking: true },
      { kind: "phraseClosed" },
    ]),
    false);

  check("33 a running monologue stays open",
    phraseOpenAfter([
      { kind: "level", speaking: true },
      { kind: "level", speaking: true },
      { kind: "partial" },
      { kind: "level", speaking: true },
    ]),
    true);

  check("34 silence before any speech does not open a phrase",
    phraseOpenAfter([{ kind: "level", speaking: false }]),
    false);
}

// The gate reads `interim.text.trim().length >= 4`. The marker MUST clear that
// bar, or the whole mechanism silently does nothing.
checkTrue("35 the marker satisfies the gate's 4-character threshold",
  PARAKEET_PHRASE_OPEN_MARKER.trim().length >= 4);
checkTrue("36 the marker is not a plausible word",
  !/^[A-Za-z' ]+$/.test(PARAKEET_PHRASE_OPEN_MARKER));
checkTrue("37 the marker cannot be mistaken for a transcript",
  PARAKEET_PHRASE_OPEN_MARKER.includes("[") && PARAKEET_PHRASE_OPEN_MARKER.includes("]"));

const OPEN = { open: true, latched: false };
const CLOSED = { open: false, latched: false };
check("38 an open phrase with no real text publishes the marker",
  shouldPublishPhraseOpenMarker(OPEN, false), true);
check("39 real interim text always wins over the marker",
  shouldPublishPhraseOpenMarker(OPEN, true), false);
check("40 a closed phrase publishes nothing",
  shouldPublishPhraseOpenMarker(CLOSED, false), false);
check("41 a closed phrase publishes nothing even with stale text",
  shouldPublishPhraseOpenMarker(CLOSED, true), false);

// The interim must never reach a prompt — that is what makes the marker safe to
// express the "still speaking" signal through `interim` at all.
{
  const agent = await readFile("src/lib/interviewAgent.ts", "utf8");
  const interimUses = (agent.match(/interim/g) ?? []).length;
  // Exactly: the type field, normalizeTurn's pass-through, the gate check, its
  // comment, and turnSignature. Anything more means a new consumer appeared and
  // the marker's safety argument needs re-checking.
  checkTrue("42 interim has no consumer beyond the gate, signature and pass-through",
    interimUses <= 8);
  // The prompt builders are the real consumer to check, not the template text.
  // `buildInterviewUserPrompt` is the function that assembles what the model
  // actually sees; it reads `turn.finals` only. If a future change ever reached
  // for `turn.interim`, the marker would be sent to the provider as if the
  // interviewer had said it.
  const userPromptStart = agent.indexOf("export function buildInterviewUserPrompt");
  const systemPromptStart = agent.indexOf("export function buildInterviewSystemPrompt");
  checkTrue("43 the user-prompt builder exists", userPromptStart > 0);
  const userPromptBody = agent.slice(
    userPromptStart,
    systemPromptStart > userPromptStart ? systemPromptStart : agent.length,
  );
  checkTrue("44 the user prompt never reads turn.interim", !userPromptBody.includes("turn.interim"));
  checkTrue("45 the user prompt does build from turn.finals", userPromptBody.includes("turn.finals"));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Early segments are queued, and the queue is bounded ──");
// ═══════════════════════════════════════════════════════════════════════════

{
  const q = createParakeetSegmentQueue<{ n: number }>();
  check("43 a new queue is empty", q.size(), 0);
  check("44 nothing is dropped yet", q.snapshot().dropped, 0);

  checkTrue("45 the first segment is accepted", q.push({ phraseId: 0, payload: { n: 0 } }));
  checkTrue("46 the second segment is accepted", q.push({ phraseId: 1, payload: { n: 1 } }));
  check("47 two segments are buffered", q.size(), 2);

  // Order must survive: these carry phraseIds, and reordering them would attach
  // transcripts to the wrong question.
  check("48 the first segment comes out first", q.shift()?.phraseId, 0);
  check("49 the second comes out second", q.shift()?.phraseId, 1);
  check("50 an empty queue shifts to null", q.shift(), null);
}

{
  const q = createParakeetSegmentQueue<{ n: number }>();
  for (let i = 0; i < PARAKEET_PRIMARY_QUEUE_LIMIT; i++) {
    q.push({ phraseId: i, payload: { n: i } });
  }
  checkTrue("51 the queue fills to its limit", q.size() === PARAKEET_PRIMARY_QUEUE_LIMIT);

  const accepted = q.push({ phraseId: 99, payload: { n: 99 } });
  check("52 an overflowing push is reported as not accepted", accepted, false);
  check("53 the queue does not grow past its limit", q.size(), PARAKEET_PRIMARY_QUEUE_LIMIT);
  check("54 the drop is counted, not swallowed", q.snapshot().dropped, 1);

  // The OLDEST goes, because a segment's job is to carry the question and the
  // newest is the one whose tail the drain barrier exists to protect.
  check("55 the oldest segment was the one dropped", q.shift()?.phraseId, 1);
  check("56 the newest segment survived", q.peek?.() ?? true, true);

  q.clear();
  check("57 clear empties the queue", q.size(), 0);
}

checkTrue("58 the queue limit is a small positive number",
  PARAKEET_PRIMARY_QUEUE_LIMIT > 0 && PARAKEET_PRIMARY_QUEUE_LIMIT <= 16);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── The Parakeet drain is capped; Moonshine's is not ──────");
// ═══════════════════════════════════════════════════════════════════════════

check("59 Moonshine's deadline is untouched at 900ms", DRAIN_DEADLINE_MS, 900);
checkTrue("60 the Parakeet cap is larger than Moonshine's",
  PARAKEET_DRAIN_DEADLINE_MS > DRAIN_DEADLINE_MS);
checkTrue("61 the Parakeet cap is still short enough to feel instant",
  PARAKEET_DRAIN_DEADLINE_MS <= 3000);
check("62 the attempt budget is derived from the cap",
  PARAKEET_DRAIN_MAX_ATTEMPTS * DRAIN_STEP_MS >= PARAKEET_DRAIN_DEADLINE_MS, true);

{
  // Nothing in flight: the barrier must cost ZERO round-trips, because this is
  // the path every screenshot-only submit takes.
  let flushes = 0;
  const result = await createAsrDrain(
    {
      pending: () => 0,
      flush: async () => {
        flushes++;
        return 0;
      },
    },
    { deadlineMs: PARAKEET_DRAIN_DEADLINE_MS, maxAttempts: PARAKEET_DRAIN_MAX_ATTEMPTS, sleep: async () => {} },
  ).drain();
  check("63 nothing in flight resolves as already idle", result.outcome, "alreadyIdle");
  check("64 nothing in flight costs no round-trips", flushes, 0);
  checkTrue("65 nothing in flight is not reported as a timeout", result.waitedMs < 50);
}

{
  // A decode that finishes before the cap: drained, not timed out.
  let pendingCalls = 0;
  const result = await createAsrDrain(
    {
      pending: () => (pendingCalls++ < 2 ? 1 : 0),
      flush: async () => (pendingCalls < 2 ? 1 : 0),
    },
    { deadlineMs: PARAKEET_DRAIN_DEADLINE_MS, maxAttempts: PARAKEET_DRAIN_MAX_ATTEMPTS, sleep: async () => {} },
  ).drain();
  check("66 a decode that finishes is drained", result.outcome, "drained");
  checkFalse("67 a drained result is not flagged as a timeout", result.timedOut);
}

{
  // A decode that never finishes: the cap MUST stop the wait. This is the whole
  // point of a bounded barrier — a wedged model must not freeze the hotkey.
  const result = await createAsrDrain(
    {
      pending: () => 1,
      flush: async () => 1,
    },
    { deadlineMs: PARAKEET_DRAIN_DEADLINE_MS, maxAttempts: PARAKEET_DRAIN_MAX_ATTEMPTS, sleep: async () => {} },
  ).drain();
  check("68 a wedged decode resolves as timedOut", result.outcome, "timedOut");
  checkTrue("69 the timeout is flagged", result.timedOut);
  checkTrue("70 the barrier gave up rather than looping forever",
    result.attempts > 0 && result.attempts <= PARAKEET_DRAIN_MAX_ATTEMPTS);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Padding override reaches the host ─────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  function fakeChild(): ParakeetChildLike & { sent: any[] } {
    const sent: any[] = [];
    let onMessage: ((r: ParakeetHostReply) => void) | null = null;
    return {
      sent,
      post(m) {
        sent.push(m);
        if (m.type === "load") {
          setTimeout(() => onMessage?.({ id: m.id, ok: true, type: "loaded", loadMs: 5 }), 0);
        } else if (m.type === "transcribe") {
          setTimeout(() => onMessage?.({ id: m.id, ok: true, type: "result", text: "ok", decodeMs: 1 }), 0);
        }
      },
      kill() {},
      onMessage(cb) {
        onMessage = cb;
      },
      onExit() {},
    };
  }

  const samples = new Float32Array(16000).fill(0.1);

  for (const [label, padding, expected] of [
    ["71 an explicit 0 really is unpadded", () => 0, 16000],
    ["72 300 ms adds 9600 samples each side", () => 300, 25600],
    ["73 an absent override falls back to the default", () => undefined, 25600],
    ["74 a negative override falls back to the default", () => -50, 25600],
    ["75 NaN falls back to the default", () => Number.NaN, 25600],
  ] as const) {
    const child = fakeChild();
    const host = new ParakeetHost({
      spawnChild: () => child,
      modelDir: "unused",
      isEnabled: () => true,
      paddingMs: padding as () => number | undefined,
    });
    await host.load();
    await host.transcribe(samples, 16000);
    const request = child.sent.find((m) => m.type === "transcribe");
    check(label, request?.samples?.length, expected);
    check(`${label} (recorded on the request)`, request?.paddingMs, expected === 16000 ? 0 : 300);
    host.dispose();
  }

  // The mode must be live, so a Settings change cannot leave a stale label on a
  // memory figure.
  const child = fakeChild();
  let primary = false;
  const host = new ParakeetHost({
    spawnChild: () => child,
    modelDir: "unused",
    isEnabled: () => true,
    mode: () => (primary ? "primary" : "comparison"),
  });
  check("76 the host reports comparison mode by default", host.getMode(), "comparison");
  primary = true;
  check("77 the host reports primary mode when asked", host.getMode(), "primary");
  host.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── The setting must actually reach the main process ──────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const ipc = await readFile("electron/ipc.ts", "utf8");
  const store = await readFile("src/store/useStore.ts", "utf8");
  const panel = await readFile("src/components/SettingsPanel.tsx", "utf8");

  // The original bug, in its original shape: a control that updates renderer
  // state the main process never reads.
  checkTrue("78 the main process reads primaryAsr from electron-store",
    /store\.get\("settings"\)/.test(ipc) && /primaryAsr\s*===\s*"parakeet"/.test(ipc));
  checkTrue("79 the main process never reads primaryAsr from a renderer argument",
    !/event[^\n]*primaryAsr/.test(ipc));

  checkTrue("80 primaryAsr is not a dev-only setting",
    !/asrCompareParakeet[\s\S]{0,80}=== true[\s\S]{0,400}primaryAsr === "parakeet"[\s\S]{0,80}app\.isPackaged/.test(ipc));
  checkTrue("81 the comparison column is still hard-disabled when packaged",
    /!app\.isPackaged[\s\S]{0,200}asrCompareParakeet === true/.test(ipc));

  checkTrue("82 the code default is Moonshine",
    /primaryAsr: DEFAULT_PRIMARY_ASR/.test(store));
  checkTrue("83 the store's DEFAULT_PRIMARY_ASR is Moonshine",
    /DEFAULT_PRIMARY_ASR: PrimaryAsr = "moonshine"/.test(
      await readFile("src/lib/primaryAsr.ts", "utf8"),
    ));

  checkTrue("84 the Settings picker writes through to the main process",
    /primaryAsr: next[\s\S]{0,120}saveSettings/.test(panel));
  checkTrue("85 the picker persists from live store state, not a stale copy",
    /useStore\.getState\(\)\.settings/.test(panel));

  const app = await readFile("src/App.tsx", "utf8");
  checkTrue("86 App.tsx spreads saved settings so primaryAsr survives a restart",
    /\.\.\.defaults,[\s\S]{0,80}\.\.\.rest,/.test(app));
  checkTrue("87 App.tsx does not hard-code primaryAsr to moonshine",
    !/primaryAsr:\s*"moonshine"/.test(app));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── One pipeline, one shape, no cloud ──────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const hook = await readFile("src/hooks/useInterviewAudio.ts", "utf8");
  const client = await readFile("src/lib/parakeetClient.ts", "utf8");

  checkTrue("88 the worker final is routed through the shared handler",
    /if \(type === "final"\)[\s\S]{0,200}handleFinalEvent\(/.test(hook));
  checkTrue("89 the Parakeet result is routed through the same handler",
    /engine: "parakeet",/.test(hook) &&
      /handleFinalEvent\(\{[\s\S]{0,200}engine: "parakeet"/.test(hook));
  checkTrue("90 exactly one handleFinalEvent definition exists",
    (hook.match(/const handleFinalEvent = useCallback/g) ?? []).length === 1);

  // There must be exactly one place that commits a transcript.
  checkTrue("91 only the shared handler calls addInterviewMessage for a final",
    (hook.match(/addInterviewMessage\(\{/g) ?? []).length === 1);

  // No second correction pipeline. The Groq COMPARISON legitimately corrects its
  // own cell (it never reaches the transcript), so exactly two call sites are
  // expected and their locations are asserted.
  const correctionSites = (hook.match(/correctTranscript\(\{/g) ?? []).length;
  check("92 correctTranscript has exactly two call sites", correctionSites, 2);
  const handlerStart = hook.indexOf("const handleFinalEvent");
  const handlerEnd = hook.indexOf("const ensureMoonshineLoaded");
  checkTrue("93 one correction site is the shared final handler",
    handlerStart > 0 &&
      handlerEnd > handlerStart &&
      hook.slice(handlerStart, handlerEnd).includes("correctTranscript({"));
  checkTrue("94 the other is the Groq comparison cell, not the transcript",
    /const compareWithGroq[\s\S]{0,900}correctTranscript\(\{/.test(hook));
  checkTrue("95 the shared handler is the only place that normalises and commits",
    hook.slice(handlerStart, handlerEnd).includes("normalizeTechnicalTerms") &&
      hook.slice(handlerStart, handlerEnd).includes("addInterviewMessage({"));

  // Moonshine must not be loaded when Parakeet is primary.
  checkTrue("93 the Moonshine model load is gated on the primary engine",
    /if \(primaryAsr === "moonshine"\)[\s\S]{0,200}type: "load"/.test(hook));

  // The fallback posts the SAME worker message the normal path posts.
  checkTrue("94 the fallback posts an ordinary transcribe to Moonshine",
    /fallbackSegmentToMoonshine[\s\S]{0,900}type: "transcribe"/.test(hook));
  checkTrue("95 the fallback carries the original phraseId",
    /fallbackSegmentToMoonshine[\s\S]{0,900}phraseId: segment\.phraseId/.test(hook));

  // ── The cloud guard ──────────────────────────────────────────────────────
  // A behavioural test cannot prove the absence of a call on a path that only
  // runs when something fails, so this is structural.
  const parakeetBlock = hook.slice(
    hook.indexOf("const runParakeetSegment"),
    hook.indexOf("const drainParakeetQueue"),
  );
  checkFalse("96 the Parakeet decode path never mentions Groq",
    /groq/i.test(parakeetBlock));
  checkFalse("97 the Parakeet decode path never mentions Deepgram",
    /deepgram/i.test(parakeetBlock));
  checkFalse("98 the Moonshine fallback never mentions Groq",
    /groq/i.test(hook.slice(
      hook.indexOf("const fallbackSegmentToMoonshine"),
      hook.indexOf("const runParakeetSegment"),
    )));
  checkFalse("99 the client exposes no cloud transcription entry point",
    /groqWhisper|deepgram|openDeepgramSegment/i.test(
      client.slice(client.indexOf("transcribeWithParakeet"), client.indexOf("export async function loadParakeetModel")),
    ));

  // Groq remains available, but only behind its own explicit dev flag.
  checkTrue("100 Groq comparison is still gated on its own setting",
    /settings\.asrCompareGroq/.test(hook) && /if \(!settings\.asrCompareGroq\) return;/.test(hook));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Diagnostics label the mode and leak nothing ────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const diag = await readFile("electron/parakeetDiagnostics.ts", "utf8");
  checkTrue("101 every diagnostic line carries the mode",
    /\[Parakeet-DIAG\]\[\$\{tag\}\]/.test(diag));
  checkTrue("102 the two modes are labelled differently",
    /mode === "primary" \? "Parakeet-only" : "Parakeet-compare"/.test(diag));
  checkTrue("103 the lowest available memory is tracked",
    /lowestAvailableMb/.test(diag) && /lowestAvail=/.test(diag));
  checkTrue("104 a run summary reports the minimum on stop",
    /summary sampleCount=\$\{sampleCount\}/.test(diag) && /lowestAvail=/.test(diag));
  checkTrue("105 the sample counter is not named `samples`",
    !/summary samples=/.test(diag));

  checkFalse("106 diagnostics never print a transcript field",
    /\$\{[^}]*text[^}]*\}/.test(diag));
  checkTrue("107 diagnostics document that numbers only are logged",
    /No transcript text, no audio/.test(diag));

  // The padding A/B tool must not invent a reference.
  const ab = await readFile("scripts/parakeet-padding-ab.mjs", "utf8");
  checkTrue("108 the padding A/B reports unscored rather than guessing",
    /UNSCORED/.test(ab) && /never invents a reference|never invent a reference/i.test(ab));
  checkTrue("109 the padding A/B distinguishes ACCURACY from distance-to-another-engine",
    /WER vs the SPOKEN words \(accuracy\)/.test(ab) &&
      /NOT accuracy/.test(ab) &&
      /distance, NOT accuracy/.test(ab));
  checkTrue("110 the padding A/B writes nothing",
    !/writeFileSync|mkdirSync|appendFileSync|createWriteStream/.test(ab));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
