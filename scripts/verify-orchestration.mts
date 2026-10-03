/**
 * Deterministic tests for the manual-hotkey answer orchestrator.
 *
 * Run: `npx tsx scripts/verify-orchestration.ts`
 *
 * Uses scripted fake providers (via the `resolveProvider` seam) so every timing
 * behaviour — hedge firing, hard-failure fast path, winner selection, loser
 * cancellation — is exercised without any network access.
 */
import {
  orchestrateAnswer,
  MAX_CONCURRENT_PROVIDERS,
  type AttemptSpec,
} from "../src/lib/ai/orchestrator";
import { validateAnswerOutput } from "../src/lib/outputValidation";
import type { AIProvider, AIRequestOptions } from "../src/lib/ai/types";

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

// ── Scripted provider ──────────────────────────────────────────────────────
interface Script {
  /** ms before the first chunk (and therefore before any useful text). */
  firstChunkAfterMs?: number;
  /** ms to linger AFTER the last chunk, before the stream ends. */
  tailAfterLastChunkMs?: number;
  /** Chunks to yield. Default: a clearly valid spoken answer. */
  chunks?: string[];
  /** Throw after this many ms instead of streaming. */
  errorAfterMs?: number;
  errorMessage?: string;
  resolvedModel?: string;
  backend?: string;
}

const VALID_ANSWER =
  "Dependency injection is a design pattern where objects receive their collaborators rather than constructing them.";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

interface Registry {
  registry: Record<string, AIProvider>;
  calls: string[];
  peakConcurrency: number;
  running: number;
}

function buildRegistry(scripts: Record<string, Script>): Registry {
  const reg: Registry = {
    registry: {},
    calls: [],
    peakConcurrency: 0,
    running: 0,
  };

  for (const [name, script] of Object.entries(scripts)) {
    reg.registry[name] = {
      name,
      listModels: () => [name],
      async *streamSolution(options: AIRequestOptions) {
        reg.calls.push(name);
        reg.running++;
        reg.peakConcurrency = Math.max(reg.peakConcurrency, reg.running);
        const signal = options.signal;
        const meta = options.meta!;
        try {
          if (script.errorAfterMs != null) {
            await sleep(script.errorAfterMs, signal);
            throw new Error(
              script.errorMessage ?? "HTTP 503 provider unavailable",
            );
          }
          if (script.firstChunkAfterMs) {
            meta.httpMs = script.firstChunkAfterMs;
            await sleep(script.firstChunkAfterMs, signal);
          }
          const chunks = script.chunks ?? [VALID_ANSWER];
          for (let i = 0; i < chunks.length; i++) {
            yield chunks[i];
          }
          if (script.tailAfterLastChunkMs) {
            await sleep(script.tailAfterLastChunkMs, signal);
          }
          meta.finishReason = "stop";
          if (script.resolvedModel) meta.model = script.resolvedModel;
          if (script.backend) meta.provider = script.backend;
        } finally {
          reg.running--;
        }
      },
    };
  }

  return reg;
}

function specs(...providers: string[]): AttemptSpec[] {
  return providers.map((provider) => ({
    provider: provider as AttemptSpec["provider"],
    model: `${provider}-model`,
    apiKey: `key-for-${provider}`,
    maxTokens: 512,
  }));
}

const realisticValidate = (text: string) => {
  if (/^wait[.!]?$/i.test(text.trim())) return { ok: false, reason: "wait" };
  return validateAnswerOutput(text, {});
};

async function run(
  reg: Registry,
  attempts: AttemptSpec[],
  opts: { hedgeMs?: number; signal?: AbortSignal; logs?: string[] } = {},
) {
  return orchestrateAnswer({
    attempts,
    prompt: "question",
    signal: opts.signal ?? new AbortController().signal,
    hedgeMs: opts.hedgeMs ?? 120,
    validate: realisticValidate,
    log: (line) => opts.logs?.push(line),
    resolveProvider: (name) =>
      reg.registry[name] ?? {
        name,
        listModels: () => [name],
        // eslint-disable-next-line require-yield
        async *streamSolution() {
          throw new Error(`unregistered provider ${name}`);
        },
      },
  });
}

// ── 1. OpenRouter succeeds well before the hedge ───────────────────────────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 10, tailAfterLastChunkMs: 20 },
    groq: { firstChunkAfterMs: 5 },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"));
  check("1 only openrouter called", reg.calls, ["openrouter"]);
  check("1 openrouter wins", res.provider, "openrouter");
  check("1 not hedged", res.hedged, false);
  check("1 answer returned", res.text, VALID_ANSWER);
}

// ── 2. First useful text BEFORE the hedge, total time AFTER it ─────────────
// This is the case the old 4500ms-total-time rule would have wrongly failed over.
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 20, tailAfterLastChunkMs: 400 },
    groq: { firstChunkAfterMs: 5 },
    nvidia: {},
    gemini: {},
  });
  const logs: string[] = [];
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 100,
    logs,
  });
  check("2 healthy stream is never hedged", res.hedged, false);
  check("2 only openrouter called", reg.calls, ["openrouter"]);
  check("2 openrouter wins", res.provider, "openrouter");
  check(
    "2 hedge was disarmed on first text",
    logs.some((l) => l.includes("hedge disarmed")),
    true,
  );
  check(
    "2 total exceeded the hedge window but did not matter",
    res.attemptsStarted[0].totalMs! > 100,
    true,
  );
}

// ── 3. No useful text within the hedge window → second provider starts ─────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 600, tailAfterLastChunkMs: 20 },
    groq: { firstChunkAfterMs: 10 },
    nvidia: {},
    gemini: {},
  });
  const logs: string[] = [];
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 80,
    logs,
  });
  check("3 both providers called", reg.calls, ["openrouter", "groq"]);
  check("3 hedged", res.hedged, true);
  check("3 concurrency capped at 2", reg.peakConcurrency <= MAX_CONCURRENT_PROVIDERS, true);
  check(
    "3 hedge is logged with the window",
    logs.some((l) => l.includes("hedge: no useful text after 80ms")),
    true,
  );
}

// ── 4. The hedge provider wins → the original is cancelled ────────────────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 400, tailAfterLastChunkMs: 20 },
    groq: { firstChunkAfterMs: 10 },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check("4 groq wins", res.provider, "groq");
  check("4 openrouter cancelled by winner", res.attemptsStarted[0].outcome, "cancelled_by_winner");
  check("4 nvidia never started", reg.calls.includes("nvidia"), false);
}

// ── 5. The original wins even though a hedge was started → hedge cancelled ──
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 200, tailAfterLastChunkMs: 10 },
    groq: { firstChunkAfterMs: 600, tailAfterLastChunkMs: 10 },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check("5 openrouter wins despite hedge", res.provider, "openrouter");
  check("5 hedged flag is set", res.hedged, true);
  check("5 groq cancelled by winner", res.attemptsStarted[1].outcome, "cancelled_by_winner");
}

// ── 6. Hard failure moves on IMMEDIATELY, not at the hedge timer ───────────
{
  const reg = buildRegistry({
    openrouter: { errorAfterMs: 15, errorMessage: "HTTP 429 rate limited" },
    groq: { firstChunkAfterMs: 10 },
    nvidia: {},
    gemini: {},
  });
  const t0 = Date.now();
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 5000, // a hedge window that would obviously have been waited out
  });
  const elapsed = Date.now() - t0;
  check("6 groq wins", res.provider, "groq");
  check("6 did not wait for the hedge window", elapsed < 1500, true);
  check("6 openrouter failed", res.attemptsStarted[0].outcome, "failed");
  check(
    "6 failure classified as http",
    res.attemptsStarted[0].failureReason,
    "http",
  );
}

// ── 7 & 8. Sequential exhaustion: openrouter → groq → nvidia → gemini ───────
{
  const reg = buildRegistry({
    openrouter: { errorAfterMs: 5 },
    groq: { errorAfterMs: 5 },
    nvidia: { errorAfterMs: 5 },
    gemini: { firstChunkAfterMs: 10 },
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check("7+8 all four attempted in order", reg.calls, [
    "openrouter",
    "groq",
    "nvidia",
    "gemini",
  ]);
  check("7+8 gemini wins", res.provider, "gemini");
  check("7+8 three failures recorded", res.failures.length, 3);
}
{
  // 7 in isolation: openrouter + groq fail → nvidia starts.
  const reg = buildRegistry({
    openrouter: { errorAfterMs: 5 },
    groq: { errorAfterMs: 5 },
    nvidia: { firstChunkAfterMs: 10 },
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check("7 nvidia is the third attempt", reg.calls, ["openrouter", "groq", "nvidia"]);
  check("7 nvidia wins", res.provider, "nvidia");
}
{
  // 8 in isolation: nvidia fails → gemini starts.
  const reg = buildRegistry({
    openrouter: { errorAfterMs: 5 },
    groq: { errorAfterMs: 5 },
    nvidia: { errorAfterMs: 5 },
    gemini: { firstChunkAfterMs: 10 },
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check("8 gemini is the fourth attempt", reg.calls.length, 4);
  check("8 gemini wins", res.provider, "gemini");
}

// ── 9. Everything fails → exactly one result, no winner, no answer ──────────
{
  const reg = buildRegistry({
    openrouter: { errorAfterMs: 5 },
    groq: { errorAfterMs: 5 },
    nvidia: { errorAfterMs: 5 },
    gemini: { errorAfterMs: 5 },
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check("9 no winner", res.provider, null);
  check("9 no text", res.text, "");
  check("9 no text is falsy", !!res.text, false);
  check("9 an error is reported", typeof res.error === "string" && res.error.length > 0, true);
  check("9 all four recorded", res.attemptsStarted.length, 4);
}

// ── 10. A partial stream that never completes yields no answer ─────────────
// Note the fragments are deliberately BELOW MEANINGFUL_CHARS, so the hedge
// correctly still fires and a second provider gets its chance. The partial
// text must never surface as an answer.
{
  const reg = buildRegistry({
    openrouter: {
      firstChunkAfterMs: 60,
      tailAfterLastChunkMs: 100000,
      chunks: ["Dep", "endency"],
    },
    groq: { firstChunkAfterMs: 5 },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 40,
  });
  check("10 hedge fired for a never-completing stream", res.hedged, true);
  check("10 the completed provider wins", res.provider, "groq");
  check("10 the partial text is not the answer", res.text, VALID_ANSWER);
  check(
    "10 the never-completing provider did not win",
    res.attemptsStarted[0].winner,
    false,
  );
  check(
    "10 hung provider cancelled",
    res.attemptsStarted[0].outcome,
    "cancelled_by_winner",
  );
}

// ── 11 & 12. Invalid / prompt-echo answers cannot win ───────────────────────
for (const [label, bad] of [
  ["11 prompt-label echo", "Previously mentioned interview questions or requests"],
  ["12 markdown heading echo", "# Latest interviewer utterance"],
  ["12 delimiter echo", "<<<LATEST_QUESTION>>>"],
] as const) {
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 10, chunks: [bad] },
    groq: { firstChunkAfterMs: 10 },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check(`${label} rejected`, res.provider, "groq");
  check(`${label} did not become the answer`, res.text === bad, false);
}

// ── 13. A new run cancels the previous one ──────────────────────────────────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 10, tailAfterLastChunkMs: 100000 },
    groq: {},
    nvidia: {},
    gemini: {},
  });
  const ac = new AbortController();
  const promise = run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 30);
  const res = await promise;
  check("13 run reports aborted", res.aborted, true);
  check("13 no winner after abort", res.provider, null);
  check("13 no text after abort", res.text, "");
}

// ── 14. A stale provider that would have finished later is ignored ─────────
// OpenRouter's text only arrives at 80ms — long after Groq has already won at
// ~45ms and cancelled it. Its answer must never reach the caller.
{
  const reg = buildRegistry({
    openrouter: {
      firstChunkAfterMs: 80,
      tailAfterLastChunkMs: 10,
      chunks: ["This is a stale answer from OpenRouter."],
    },
    groq: {
      firstChunkAfterMs: 5,
      chunks: ["This is the winning answer from Groq."],
    },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 40,
  });
  check("14 winner text only", res.text, "This is the winning answer from Groq.");
  check("14 stale text never surfaces", res.text.includes("stale"), false);
  check(
    "14 stale provider was cancelled, not successful",
    res.attemptsStarted[0].outcome !== "success",
    true,
  );
  check(
    "14 exactly one winner flagged",
    res.attemptsStarted.filter((a) => a.winner).length,
    1,
  );
}

// ── 15. Duplicate completion cannot produce a duplicate answer ──────────────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 10 },
    groq: { firstChunkAfterMs: 5 },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check(
    "15 exactly one winner across all attempts",
    res.attemptsStarted.filter((a) => a.winner).length,
    1,
  );
  check("15 single non-empty text", typeof res.text === "string" && res.text.length > 0, true);
}

// ── 16. The OpenRouter resolved model is preserved ──────────────────────────
{
  const reg = buildRegistry({
    openrouter: {
      firstChunkAfterMs: 10,
      resolvedModel: "upstage/solar-pro-3:free",
      backend: "upstage",
    },
    groq: {},
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq"), { hedgeMs: 60 });
  check("16 resolved model surfaced", res.resolvedModel, "upstage/solar-pro-3:free");
  check("16 requested model retained", res.model, "openrouter-model");
  check("16 backend surfaced", res.backend, "upstage");
  check(
    "16 telemetry records the resolved model",
    res.attemptsStarted[0].resolvedModel,
    "upstage/solar-pro-3:free",
  );
}

// ── 17. Telemetry is emitted for every attempt ─────────────────────────────
// openrouter is slow enough to hedge, groq fails, nvidia wins — so every
// telemetry shape (winner + hedged loser + failed attempt) is exercised.
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 5000 },
    groq: { errorAfterMs: 5 },
    nvidia: { firstChunkAfterMs: 5 },
  });
  const logs: string[] = [];
  await run(reg, specs("openrouter", "groq", "nvidia"), {
    hedgeMs: 40,
    logs,
  });
  const summary = logs.find((l) => l.includes("nvidia/nvidia-model"));
  check("17 a summary line per attempt exists", !!summary, true);
  check("17 http timing logged", /http=\d+ms/.test(summary ?? ""), true);
  check("17 firstText timing logged", /firstText=\d+ms/.test(summary ?? ""), true);
  check("17 total timing logged", /total=\d+ms/.test(summary ?? ""), true);
  check("17 winner flag logged", /winner=true/.test(summary ?? ""), true);
  const failure = logs.find(
    (l) => l.includes("groq/groq-model") && l.includes("reason="),
  );
  check("17 failure reason logged", !!failure, true);
  check(
    "17 the hedged-and-losing attempt is marked",
    logs.some((l) => l.includes("openrouter/openrouter-model") && l.includes("cancelled")),
    true,
  );
}

// ── 18. No API key, prompt or resume content is ever logged ────────────────
{
  const reg = buildRegistry({ openrouter: { firstChunkAfterMs: 10 } });
  const logs: string[] = [];
  await orchestrateAnswer({
    attempts: specs("openrouter"),
    prompt: "SECRET RESUME CONTENT about candidate employment history",
    system: "SECRET SYSTEM PROMPT",
    signal: new AbortController().signal,
    hedgeMs: 60,
    validate: realisticValidate,
    log: (line) => logs.push(line),
    resolveProvider: (name) => reg.registry[name],
  });
  const joined = logs.join("\n");
  check("18 no api key in logs", joined.includes("key-for-openrouter"), false);
  check("18 no resume content in logs", joined.includes("SECRET RESUME"), false);
  check("18 no system prompt in logs", joined.includes("SECRET SYSTEM"), false);
  check("18 key presence is still reported as a boolean", joined.includes("apiKeyPresent=true"), true);
}

// ── Extra: an empty provider answer cannot win ─────────────────────────────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 10, chunks: ["   "] },
    groq: { firstChunkAfterMs: 10 },
  });
  const res = await run(reg, specs("openrouter", "groq"), { hedgeMs: 60 });
  check("extra empty answer rejected", res.provider, "groq");
}

// ── Extra: WAIT responses cannot win ───────────────────────────────────────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 10, chunks: ["WAIT"] },
    groq: { firstChunkAfterMs: 10 },
  });
  const res = await run(reg, specs("openrouter", "groq"), { hedgeMs: 60 });
  check("extra WAIT cannot win", res.provider, "groq");
}

// ── Extra: no providers configured ─────────────────────────────────────────
{
  const res = await orchestrateAnswer({
    attempts: [],
    prompt: "q",
    signal: new AbortController().signal,
    validate: realisticValidate,
    resolveProvider: () => ({ name: "x", listModels: () => [], async *streamSolution() {} }),
  });
  check("extra empty chain yields no answer", res.text, "");
  check("extra empty chain has an error", typeof res.error === "string", true);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}