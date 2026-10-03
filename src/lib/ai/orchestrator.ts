import { getProvider, type ProviderName } from "./index";
import { isModelUnavailableError } from "./fetchWithDiagnostics";
import { isWaitResponse } from "../interviewAgent";
import { validateAnswerOutput } from "../outputValidation";
import type { AIProvider, AIRequestOptions, AIStreamMeta } from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Answer orchestration for the MANUAL HOTKEY path.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The user presses a shortcut AFTER the interviewer stops talking, so there is
 * no need to speculate on partial ASR. The whole latency budget is therefore
 * spent on the model call — and the previous design spent it *waiting*:
 *
 *   old:  OpenRouter → block up to 4500ms → then fall back
 *   new:  OpenRouter → 1800ms soft hedge → Groq overlaps → first VALID
 *         COMPLETE answer wins, losers are cancelled
 *
 * Two rules matter most and are the reason this file exists:
 *
 *  1. **FIRST USEFUL TEXT, NOT TOTAL TIME.** A healthy OpenRouter stream that
 *     takes 3.4s in total but produced its first useful text at 1.5s must NOT
 *     be hedged. Only "no meaningful text yet after the hedge window" starts a
 *     second provider.
 *
 *  2. **HARD FAILURE IS IMMEDIATE.** An HTTP error, a network error or a stream
 *     error before any usable text moves on at once — the hedge timer is never
 *     waited out after a confirmed failure.
 *
 * Nothing here writes to the UI. There is exactly one result
 * (`OrchestratorResult`) and the caller decides what to display.
 */

/**
 * Soft hedge window before a second provider is started.
 *
 * A tuned constant, not a guess baked into the logic: every attempt reports
 * `firstTextMs`, so this can be adjusted once real interview numbers exist.
 */
export const OPENROUTER_HEDGE_MS = 1800;

/** Never run more than this many providers at once. */
export const MAX_CONCURRENT_PROVIDERS = 2;

/**
 * Non-whitespace characters that count as "useful answer text".
 *
 * This is the trigger for *not* hedging. It is deliberately generous — the goal
 * is to recognise a real answer arriving, not to judge its quality (that is the
 * validator's job, and it only runs at completion).
 */
export const MEANINGFUL_CHARS = 12;

export type RunState =
  | "idle"
  | "starting"
  | "streaming"
  | "hedging"
  | "completed"
  | "failed"
  | "cancelled";

export type AttemptOutcome =
  | "success"
  | "failed"
  | "cancelled"
  | "cancelled_by_winner";

export type FailureReason =
  | "timeout"
  | "http"
  | "network"
  | "stream"
  | "model"
  | "empty"
  | "invalid"
  | "abort";

export interface AttemptSpec {
  provider: ProviderName;
  model: string;
  apiKey: string;
  maxTokens?: number;
  /** Retired-model safety net for this provider only. */
  fallbackModels?: string[];
}

export interface AttemptTelemetry {
  provider: ProviderName;
  model: string;
  /** attempt start → response headers. */
  httpMs: number | null;
  /** attempt start → first SSE chunk of any kind. */
  firstChunkMs: number | null;
  /** attempt start → first MEANINGFUL text (the anti-hedge signal). */
  firstTextMs: number | null;
  /** attempt start → stream end. */
  completeMs: number | null;
  totalMs: number;
  outcome: AttemptOutcome;
  failureReason?: FailureReason;
  /** True when a second provider was started because this one was silent. */
  hedged: boolean;
  winner: boolean;
  /** Concrete model served, when it differs from `model` (openrouter/free). */
  resolvedModel?: string;
  backend?: string;
  finishReason?: string;
  chars: number;
}

export interface StatusUpdate {
  state: RunState;
  provider?: ProviderName;
  model?: string;
  /** Short user-facing phrase, e.g. "OpenRouter slow → Groq". */
  note?: string;
}

export interface OrchestratorResult {
  /** The single authoritative answer text. Empty when nothing won. */
  text: string;
  provider: ProviderName | null;
  model: string;
  resolvedModel?: string;
  backend?: string;
  finishReason?: string;
  winner: boolean;
  /** True when a second provider was ever started. */
  hedged: boolean;
  attempts: number;
  attemptsStarted: AttemptTelemetry[];
  /** Why each losing attempt did not win. */
  failures: Array<{
    provider: ProviderName;
    model: string;
    reason: FailureReason;
    message: string;
  }>;
  aborted: boolean;
  error?: string;
}

export interface OrchestrateOptions {
  attempts: AttemptSpec[];
  prompt: string;
  system?: string;
  messages?: { role: "user" | "assistant"; content: string }[];
  base64Image?: string;
  mimeType?: string;
  /** Cancels the whole run; every in-flight attempt aborts with it. */
  signal: AbortSignal;
  /** Override the hedge window (tests, tuning). */
  hedgeMs?: number;
  maxConcurrent?: number;
  /**
   * Decides whether a COMPLETED answer is acceptable. A provider only wins on
   * `ok: true`. The caller supplies the real validator so this module never
   * has to know about prompts, WAIT or artefacts.
   */
  validate?: (text: string) => { ok: boolean; reason?: string };
  onStatus?: (status: StatusUpdate) => void;
  log?: (line: string) => void;
  /** Test seam; defaults to the real provider registry. */
  resolveProvider?: (name: ProviderName) => AIProvider;
}

const nonWhitespace = (t: string) => t.replace(/\s+/g, "").length;

const truncate = (t: string, n: number) =>
  t.length <= n ? t : `${t.slice(0, n)}…`;

/**
 * Default acceptance: non-empty, not a WAIT refusal, and free of structural
 * prompt-leak / malformed-output artefacts. The caller normally supplies the
 * richer validator from `Home.tsx`; this default keeps the orchestrator safe on
 * its own (a provider must never win on leaked text even with no validator).
 */
function defaultValidate(text: string): { ok: boolean; reason?: string } {
  if (!text.trim()) return { ok: false, reason: "empty" };
  if (isWaitResponse(text)) return { ok: false, reason: "wait" };
  const verdict = validateAnswerOutput(text);
  return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
}

/** Classify a thrown provider error. */
function classify(err: unknown): FailureReason {
  const message = err instanceof Error ? err.message : String(err);
  if (isModelUnavailableError(message)) return "model";
  if (/HTTP\s+[45]\d\d|API error|status/i.test(message)) return "http";
  if (/stream error/i.test(message)) return "stream";
  return "network";
}

interface InFlight {
  controller: AbortController;
  telemetry: AttemptTelemetry;
  spec: AttemptSpec;
  /** Resolves when the attempt has definitively finished (any outcome). */
  done: Promise<void>;
  hadMeaningfulText: boolean;
}

export async function orchestrateAnswer(
  opts: OrchestrateOptions,
): Promise<OrchestratorResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const resolve = opts.resolveProvider ?? getProvider;
  const validate = opts.validate ?? defaultValidate;
  const hedgeMs = opts.hedgeMs ?? OPENROUTER_HEDGE_MS;
  const maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_PROVIDERS;

  const queue = opts.attempts.filter((a) => a.apiKey?.trim());
  const attemptsStarted: AttemptTelemetry[] = [];
  const failures: OrchestratorResult["failures"] = [];

  const inFlight = new Map<ProviderName, InFlight>();
  let cursor = 0;
  let hedged = false;
  let winner: { text: string; flight: InFlight } | null = null;
  let aborted = opts.signal.aborted;

  // ── wake-up plumbing so the scheduler can await external events ──────────
  let wake: () => void = () => {};
  const waiter = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  const notify = () => {
    const w = wake;
    wake = () => {};
    w();
  };

  const emit = (status: StatusUpdate) => opts.onStatus?.(status);

  /** Starts one attempt and wires its completion into the scheduler. */
  const start = (spec: AttemptSpec) => {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    opts.signal.addEventListener("abort", onParentAbort);

    const t0 = performance.now();
    const telemetry: AttemptTelemetry = {
      provider: spec.provider,
      model: spec.model,
      httpMs: null,
      firstChunkMs: null,
      firstTextMs: null,
      completeMs: null,
      totalMs: 0,
      outcome: "failed",
      hedged: false,
      winner: false,
      chars: 0,
    };
    attemptsStarted.push(telemetry);

    const flight: InFlight = {
      controller,
      telemetry,
      spec,
      done: Promise.resolve(),
      hadMeaningfulText: false,
    };

    emit({
      state: hedged ? "hedging" : "starting",
      provider: spec.provider,
      model: spec.model,
    });
    log(
      `[AI] provider=${spec.provider} model=${spec.model} start apiKeyPresent=${!!spec.apiKey}`,
    );

    flight.done = (async () => {
      let out = "";
      const meta: AIStreamMeta = {};
      try {
        const request: AIRequestOptions = {
          prompt: opts.prompt,
          system: opts.system,
          messages: opts.messages,
          base64Image: opts.base64Image,
          mimeType: opts.mimeType,
          model: spec.model,
          apiKey: spec.apiKey,
          maxTokens: spec.maxTokens,
          signal: controller.signal,
          meta,
        };
        const stream = resolve(spec.provider).streamSolution(request);

        for await (const chunk of stream) {
          if (opts.signal.aborted) break;
          if (!chunk) continue;
          if (telemetry.firstChunkMs == null) {
            telemetry.firstChunkMs = Math.round(performance.now() - t0);
            if (meta.httpMs != null) telemetry.httpMs = meta.httpMs;
          }
          out += chunk;

          // ── THE ANTI-HEDGE SIGNAL ──
          // Meaningful text means the provider is healthy. From here on the
          // hedge timer is disarmed and we simply wait for completion, however
          // long the total request takes.
          if (!flight.hadMeaningfulText && nonWhitespace(out) >= MEANINGFUL_CHARS) {
            flight.hadMeaningfulText = true;
            telemetry.firstTextMs = Math.round(performance.now() - t0);
            telemetry.hedged = hedged;
            // A healthy stream is never hedged, however long it runs in total.
            disarmHedge();
            log(
              `[AI] provider=${spec.provider} model=${spec.model} firstText=${telemetry.firstTextMs}ms (hedge disarmed)`,
            );
            emit({ state: "streaming", provider: spec.provider, model: spec.model });
            notify();
          }
        }

        telemetry.completeMs = Math.round(performance.now() - t0);
        telemetry.chars = out.length;
        telemetry.resolvedModel = meta.model;
        telemetry.backend = meta.provider;
        telemetry.finishReason = meta.finishReason;

        if (opts.signal.aborted) {
          telemetry.outcome = "cancelled";
          return;
        }
        if (!winner && controller.signal.aborted) {
          telemetry.outcome = "cancelled_by_winner";
          return;
        }

        const verdict = validate(out);
        if (!verdict.ok) {
          telemetry.outcome = "failed";
          telemetry.failureReason =
            verdict.reason === "wait" ? "invalid" : (verdict.reason as FailureReason) ?? "invalid";
          failures.push({
            provider: spec.provider,
            model: spec.model,
            reason: telemetry.failureReason,
            message: verdict.reason ?? "answer rejected by validator",
          });
          log(
            `[AI] provider=${spec.provider} rejected (${telemetry.failureReason}) text="${truncate(out, 60)}"`,
          );
          return;
        }

        telemetry.outcome = "success";
        if (!winner) {
          telemetry.winner = true;
          winner = { text: out, flight };
        }
      } catch (err) {
        telemetry.completeMs = Math.round(performance.now() - t0);
        if (opts.signal.aborted || controller.signal.aborted) {
          telemetry.outcome = controller.signal.aborted
            ? "cancelled_by_winner"
            : "cancelled";
          telemetry.failureReason = "abort";
          return;
        }
        const reason = classify(err);
        telemetry.outcome = "failed";
        telemetry.failureReason = reason;
        failures.push({
          provider: spec.provider,
          model: spec.model,
          reason,
          message: err instanceof Error ? err.message : String(err),
        });
        log(
          `[AI] provider=${spec.provider} FAILED (${reason}): ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        telemetry.totalMs = Math.round(performance.now() - t0);
        opts.signal.removeEventListener("abort", onParentAbort);
        // Retire this attempt from the running set. This is what lets the
        // scheduler see "nothing is in flight" and launch the next provider
        // IMMEDIATELY after a hard failure, rather than waiting for a timer.
        if (inFlight.get(spec.provider) === flight) inFlight.delete(spec.provider);
        notify();
      }
    })();

    inFlight.set(spec.provider, flight);
  };

  /** Stops everything that is still running (a winner was chosen). */
  const cancelRemaining = () => {
    for (const flight of inFlight.values()) {
      if (flight !== winner?.flight && !flight.controller.signal.aborted) {
        flight.controller.abort();
      }
    }
  };

  // ── Hedge timer ─────────────────────────────────────────────────────────
  // Disarmed the moment ANY running attempt produces meaningful text.
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  let hedgeFired = false;
  const armHedge = () => {
    hedgeTimer = setTimeout(() => {
      // The hedge may fire AT MOST ONCE. A second firing would push the run
      // past the 2-provider concurrency cap and start providers needlessly.
      if (hedgeFired) return;
      // Only hedge if the still-running attempts have produced nothing usable.
      const running = [...inFlight.values()];
      const healthy = running.some((f) => f.hadMeaningfulText);
      if (winner || healthy || aborted || running.length === 0) return;
      if (cursor >= queue.length) return;
      hedgeFired = true;
      hedged = true;
      const spec = queue[cursor++];
      log(
        `[AI] hedge: no useful text after ${hedgeMs}ms, starting ${spec.provider} alongside ${running.map((f) => f.spec.provider).join(", ")}`,
      );
      emit({
        state: "hedging",
        provider: spec.provider,
        model: spec.model,
        note: `OpenRouter slow → ${spec.provider}`,
      });
      start(spec);
      notify();
    }, hedgeMs);
  };
  const disarmHedge = () => {
    if (hedgeTimer) clearTimeout(hedgeTimer);
    hedgeTimer = undefined;
  };

  // ── Main loop ───────────────────────────────────────────────────────────
  emit({ state: "starting" });
  if (queue.length === 0) {
    emit({ state: "failed" });
    return {
      text: "",
      provider: null,
      model: "",
      winner: false,
      hedged: false,
      attempts: 0,
      attemptsStarted,
      failures,
      aborted: false,
      error: "No provider has an API key.",
    };
  }

  start(queue[cursor++]);
  armHedge();

  while (!winner) {
    if (opts.signal.aborted) {
      aborted = true;
      cancelRemaining();
      break;
    }

    // Launch the next attempt only when it is genuinely useful:
    //  • the chain is under-concurrent, AND
    //  • either a hedge has happened, or the current in-flight set is empty
    //    (i.e. everything before it hard-failed).
    // This is what caps concurrency at 2 and prevents all four firing at once.
    const pending = queue.slice(cursor);
    if (
      pending.length > 0 &&
      inFlight.size < maxConcurrent &&
      (hedgeFired || inFlight.size === 0)
    ) {
      const spec = queue[cursor++];
      start(spec);
      continue;
    }

    if (inFlight.size === 0 && cursor >= queue.length) break;

    await waiter();
  }

  disarmHedge();

  if (winner) {
    cancelRemaining();
    emit({ state: "completed", provider: winner.flight.spec.provider });
    // Let the aborted attempts settle so their telemetry is recorded, but do
    // not let them overwrite the winner.
    await Promise.allSettled([...inFlight.values()].map((f) => f.done));
  } else if (aborted) {
    emit({ state: "cancelled" });
    await Promise.allSettled([...inFlight.values()].map((f) => f.done));
  } else {
    emit({ state: "failed" });
    await Promise.allSettled([...inFlight.values()].map((f) => f.done));
  }

  // ── Telemetry ───────────────────────────────────────────────────────────
  for (const t of attemptsStarted) {
    const parts = [
      `http=${t.httpMs ?? "none"}ms`,
      `firstText=${t.firstTextMs ?? "none"}ms`,
      `total=${t.totalMs}ms`,
      `success=${t.outcome === "success"}`,
      `winner=${t.winner}`,
    ];
    if (t.failureReason) parts.push(`reason=${t.failureReason}`);
    if (t.hedged) parts.push("hedged");
    if (t.resolvedModel && t.resolvedModel !== t.model) {
      parts.push(`resolvedModel=${t.resolvedModel}`);
    }
    if (t.backend) parts.push(`backend=${t.backend}`);
    if (t.outcome.startsWith("cancelled")) parts.push(t.outcome);
    log(`[AI] ${t.provider}/${t.model} ${parts.join(" ")}`);
  }

  return {
    text: winner?.text ?? "",
    provider: winner?.flight.spec.provider ?? null,
    model: winner?.flight.spec.model ?? attemptsStarted[0]?.model ?? "",
    resolvedModel: winner?.flight.telemetry.resolvedModel,
    backend: winner?.flight.telemetry.backend,
    finishReason: winner?.flight.telemetry.finishReason,
    winner: !!winner,
    hedged,
    attempts: attemptsStarted.length,
    attemptsStarted,
    failures,
    aborted,
    error: winner
      ? undefined
      : aborted
        ? "Cancelled."
        : failures.length
          ? failures.map((f) => `${f.provider}: ${f.message}`).join(" | ")
          : "No provider produced an answer.",
  };
}