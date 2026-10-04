import React, { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "../store/useStore";
import { getProvider } from "../lib/ai";
import {
  orchestrateAnswer,
  type AttemptSpec,
} from "../lib/ai/orchestrator";
import {
  isOpenRouterFreeModel,
  OPENROUTER_FREE_MODEL,
} from "../lib/ai/openrouter";
import { describeProviderChain } from "../lib/providerDiagnostics";
import {
  buildCooldownSummary,
  useProviderCooldown,
} from "../lib/useProviderCooldown";
import {
  buildContextBlock,
  classifyFollowUp,
  detectProblemStart,
  extractApproachSummary,
  pruneSessionContext,
  startProblem,
  touchProblem,
  SESSION_CONTEXT_TTL_MS,
  type ProblemSource,
} from "../lib/sessionContext";
import { buildPrompt, buildInterviewContext } from "../lib/prompts";
import {
  buildInterviewSystemPrompt,
  buildInterviewUserPrompt,
  evaluateInterviewTurn,
  isDuplicateSubmit,
  isWaitResponse,
  normalizeTurn,
  turnSignature,
  INTERVIEW_SYSTEM_PROMPT,
  type InterviewTurn,
  type SubmitRecord,
} from "../lib/interviewAgent";
import { validateAnswerOutput } from "../lib/outputValidation";
import { SessionContextChip } from "../components/SessionContextChip";
import { describeDrain, drainInterviewAsr } from "../lib/asrDrain";
import { forceEndpointOnSubmit } from "../lib/forceEndpointRunner";
import { shadowOverlapCheck, type ShadowOverlap } from "../lib/outputValidation";
import { selectContextBlock } from "../lib/contextSelection";
import {
  appendThreadTurn,
  extractAnswerHead,
  startThread,
} from "../lib/conversationThread";
import {
  createStageRecorder,
  type ProviderTiming,
  type RunOutcome,
  type StageRecorder,
  type TurnTimings,
} from "../lib/stageTiming";
import type { ForceEndpointTiming } from "../lib/stageTiming";
import { createShortcutGuard } from "../lib/interviewShortcuts";
import { correctQuestionWithCandidate } from "../lib/candidateCorrection";
import {
  getInterviewControls,
  planInterviewToggle,
  requestPendingStart,
} from "../lib/interviewControls";

/**
 * In auto-answer mode, how long to wait after the last finalized utterance before
 * answering. The ASR already waited out the end-of-speech pause; this extra beat
 * absorbs "pause … keep going" phrasing without adding noticeable latency.
 */
const AUTO_ANSWER_SETTLE_MS = 600;

/** Friendly provider name for the overlay / logs. */
const providerLabel = (provider: string): string =>
  provider === "groq"
    ? "Groq"
    : provider === "gemini"
      ? "Gemini"
      : provider === "openai"
        ? "OpenAI"
        : provider === "anthropic"
          ? "Anthropic"
          :provider === "openrouter"
        ? "OpenRouter"
        : provider === "nvidia"
          ? "NVIDIA"
          : provider;

const logTruncate = (text: string, max: number): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
};
import { v4 as uuidv4 } from "uuid";
import { TopBar } from "../components/TopBar";
import { SettingsPanel } from "../components/SettingsPanel";
import { SolutionCard } from "../components/SolutionCard";
import { InterviewModal } from "../components/InterviewModal";

export const Home: React.FC = () => {
  const {
    currentSolution,
    isStreaming,
    screenshots,
    error,
    settings,
    sessionMessages,
    sessionContext,
    setSessionContext,
    clearSessionContext,
    addScreenshot,
    addLatencyTurn,
    removeScreenshot,
    setCurrentSolution,
    setIsStreaming,
    setError,
    clearSolution,
    addToHistory,
    addSessionMessage,
    updateSettings,
    clearInterviewMessages,
    agentNotice,
    setAgentNotice,
    interviewMessages,
    detectedQuestion,
    setDetectedQuestion,
    answerIssue,
    setAnswerIssue,
    openRouterBackendProvider,
    setOpenRouterBackendProvider,
  } = useStore();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [interviewOpen, setInterviewOpen] = useState(false);
  // Collapsed = the transcript panel shrinks to one bar so the answer has room.
  const [interviewCollapsed, setInterviewCollapsed] = useState(false);
  const [followUpText, setFollowUpText] = useState("");
  const screenshotsRef = useRef<string[]>(screenshots);
  const interviewOpenRef = useRef(interviewOpen);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Every AI run gets its own id. A superseded run (older id) must never append
  // to the screen or save history, even if its HTTP stream is still draining.
  const requestIdRef = useRef(0);
  // Remembers a gated (unanswered) turn so pressing the hotkey twice in a row
  // on the exact same transcript counts as an explicit "answer anyway".
  const lastGateRef = useRef<{ signature: string; ts: number }>({
    signature: "",
    ts: 0,
  });
  // ── Latency instrumentation ────────────────────────────────────────────────
  //
  // The hotkey lives in the MAIN process, so its press instant arrives as a
  // `Date.now()` value; `performance.now()` origins differ between processes and
  // a renderer-side duration cannot reach back to it. Everything after this is a
  // renderer-local `performance.now()` delta. `submitEnteredAt` is the
  // renderer-local handoff instant, so `hotkey_pressed -> hotkey_to_submit`
  // isolates the IPC cost from the rest of the turn.
  const hotkeyPressedAtRef = useRef<number | null>(null);
  const hotkeyTranscriptReadyAtRef = useRef<number | null>(null);
  const forceEndpointTimingsRef = useRef<ForceEndpointTiming | null>(null);
  // Set by the wrapper `runAIStream`, read by the inner function for every
  // stage mark. A ref rather than a parameter because the inner function already
  // has a long signature and this must not change its identity.
  const recorderRef = useRef<StageRecorder | null>(null);
  /**
   * The recorder the hotkey handler created BEFORE the drain, adopted by the
   * measured `runAIStream` wrapper so the turn is measured end to end rather
   * than from the point the AI call is made.
   */
  const pendingRecorderRef = useRef<StageRecorder | null>(null);
  const outcomeRef = useRef<RunOutcome>("answered");
  const providersRef = useRef<ProviderTiming[]>([]);
  /**
   * True when this turn's question was submitted with a phrase still open in the
   * VAD, i.e. the tail may be missing. Set only when we KNOW it (the force
   * declined because a phrase was open), never guessed.
   */
  const truncatedRef = useRef(false);
  /**
   * This turn's SHADOW overlap result. Computed for every answer and stored in
   * the turn record, but read by NOTHING that decides what the user sees.
   */
  const shadowOverlapRef = useRef<ShadowOverlap | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  // Repeat / editable-target guard for the global interview shortcuts. Kept in
  // a ref so it survives re-renders and holds its cooldown state.
  const shortcutGuardRef = useRef(createShortcutGuard());

  /**
   * A ticking clock for the context chip.
   *
   * Exists purely so an EXPIRED context stops being displayed as active. Without
   * it the chip would keep showing a problem that `pruneSessionContext` has
   * already dropped, which is worse than showing nothing: the user would be told
   * the model still has context when it does not.
   *
   * 30s, not 1s — the TTL is 30 minutes, so sub-second freshness buys nothing
   * and a 1s interval would re-render the overlay forever.
   */
  const [ctxTick, setCtxTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setCtxTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /**
   * Provider cooldown — "do not call this one again for N minutes".
   *
   * Aimed squarely at the three live failures that all looked like "the AI is
   * broken": OpenRouter out of daily quota, Gemini out of quota for 3h 15m, and
   * NVIDIA blocked from the renderer on every single turn. Each is a provider
   * STATE, not a request problem, and retrying them per turn made the interview
   * slower without making it work.
   */
  const cooldown = useProviderCooldown();

  // Keep refs in sync
  useEffect(() => {
    screenshotsRef.current = screenshots;
  }, [screenshots]);

  useEffect(() => {
    interviewOpenRef.current = interviewOpen;
  }, [interviewOpen]);

  // Auto-scroll chat
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [sessionMessages, currentSolution]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // AI streaming function
  //
  // `runAIStreamInner` is the whole original function, untouched. It is wrapped
  // by `runAIStream` below purely to own the latency recorder: the wrapper
  // guarantees a record is published for EVERY outcome — answered, gated WAIT,
  // duplicate submit, no provider, rejection, supersession, or a throw — which
  // is exactly the set of exits that would be easy to miss by hand.
  const runAIStreamInner = useCallback(
    async (
      screenshotList: string[],
      turn?: InterviewTurn,
      followUpQuery?: string,
      /**
       * Who triggered this run. `retry` bypasses the duplicate-submit guard and
       * re-asks the same question on purpose.
       */
      origin: "auto" | "manual" | "retry" = "manual",
      /**
       * Candidate repeated-word correction signal. When present, it is applied
       * to the interviewer's final question AFTER the local gate has confirmed
       * there is a valid question. It is a correction signal only — never an
       * appended utterance, never a new question, never sent to AI separately.
       * The optional `timestamp` is informational ordering only and never a
       * hard guard. The voice path (useInterviewAudio) also supplies this.
       */
      candidateSignal?: { text: string; timestamp?: number },
    ) => {
      // We only strictly require screenshots for the FIRST dsa/code question if no followUp or transcript
      const isGeneral = settings.interviewType === "general";
      const isFollowUp = !!followUpQuery;
      // Utterances the VAD split are re-joined first, so "Can you explain" +
      // "… the CAP theorem" counts as one complete question.
      const interviewTurn = turn ? normalizeTurn(turn) : undefined;
      const isInterview = !!interviewTurn;
      // `retry` is shown exactly like a manual run in the overlay.
      const displayMode: "auto" | "manual" =
        origin === "auto" ? "auto" : "manual";

      // Ordered provider chain.
      //
      // A live interview goes through OpenRouter ONLY — it is the single
      // gateway, and OpenRouter itself owns provider routing/fallback. The
      // screenshot / follow-up flow stays on whatever provider is chosen in
      // Settings, which also defaults to OpenRouter.
      const attempts: AttemptSpec[] = (
        isInterview
          ? (settings.providerOrder ?? []).map((provider) => ({
              provider,
              apiKey: settings.apiKeys[provider] ?? "",
            }))
          : [
              {
                provider: settings.activeProvider,
                apiKey: settings.apiKeys[settings.activeProvider] ?? "",
              },
            ]
      )
        .filter((a) => a.apiKey.trim())
        .map((a) => {
          const provider = getProvider(a.provider);
          const models = provider.listModels();
          const configured = settings.models?.[a.provider] || models[0] || "";
          // ── Free mode: never substitute a fixed model ──────────────────
          // `openrouter/free` is a ROUTER, not a model. OpenRouter resolves it
          // per request, so swapping in some other id on failure would defeat
          // the entire point (and silently pin us to one model again). If the
          // free router is unavailable the run moves to the NEXT PROVIDER —
          // the configured fallback policy, not a hidden substitution.
          //
          // There is deliberately no per-provider "try these other model ids"
          // list: with hedging in place the next provider is a faster answer
          // than retrying the same gateway on a different model.
          return {
            provider: a.provider,
            model:
              a.provider === "openrouter" && isOpenRouterFreeModel(configured)
                ? OPENROUTER_FREE_MODEL
                : configured,
            apiKey: a.apiKey,
            maxTokens: 4096,
          };
        });

      // Resolved-chain diagnostic. The runtime previously reported OpenRouter as
      // configured while the interview path actually ran on Groq, so the chain
      // that will really be used is now printed up front — with the configured
      // order and the reason every provider is used or skipped. Never a key.
      if (isInterview) {
        for (const line of describeProviderChain(settings).lines) {
          console.log(line);
        }
        console.log(
          `[AI] activeProvider=${settings.activeProvider} lastOpenRouterBackend=${openRouterBackendProvider ?? "(none yet)"}`,
        );
      }
      console.log(
        `[AI] ${isInterview ? "interview" : "screenshot"} attempts: ${
          attempts.length
            ? attempts.map((a) => `${a.provider}(${a.model})`).join(" → ")
            : "(none — no provider has an API key)"
        }`,
      );

      if (attempts.length === 0) {
        setError(
          isInterview
            ? "No API key for OpenRouter. Open Settings (⚙) to add one."
            : `No API key for ${settings.activeProvider}. Open Settings (⚙) to add one.`,
        );
        setIsStreaming(false);
        outcomeRef.current = "no-provider";
        return;
      }

      // Without a screenshot there is nothing to solve. Previously the code fell
      // through to the generic "solve the problem on screen" prompt here, which
      // is what made the model invent a question out of thin air.
      if (
        !isGeneral &&
        !isInterview &&
        !isFollowUp &&
        screenshotList.length === 0
      ) {
        setError(
          "No screenshots yet. Press Ctrl+H or Ctrl+Shift+C to capture a screenshot first.",
        );
        setIsStreaming(false);
        return;
      }

      // Signature of the transcript this run submits (null when not deduped).
      let submittedSignature: string | null = null;

      // ── End-of-utterance + question detection gate ──────────────────────
      // Runs locally and BEFORE any network call: incomplete, fragmented,
      // conversational or question-less input never reaches the LLM.
      //
      // There is exactly ONE authoritative result for the current transcript:
      // either we show the detected question and proceed to answer, or we show
      // WAIT and return. The two states are mutually exclusive by construction.
      let questionIndex = 0;
      let turnId = "";
      // The final, corrected question this run will answer. The voice path
      // (useInterviewAudio) has already run the generic ASR repair; here we
      // apply the candidate repeated-word correction on top of that, but ONLY
      // once the local gate has confirmed a valid interviewer question exists.
      let finalQuestion = "";
      let usedCandidateCorrection = false;
      if (candidateSignal && isInterview && interviewTurn) {
        const finals = interviewTurn.finals.filter((u) => u.text?.trim());
        if (finals.length > 0) {
          const rawQuestion = finals[finals.length - 1].text.trim();
          const correction = correctQuestionWithCandidate(
            rawQuestion,
            candidateSignal,
          );
          if (correction.corrected) {
            finalQuestion = correction.finalCorrectedQuestion;
            usedCandidateCorrection = true;
            console.log(
              `[AI:${turnId}] candidate correction: "${correction.rawInterviewerText}" → "${finalQuestion}" (candidate: "${correction.candidateCorrection}")`,
            );
          } else {
            finalQuestion = rawQuestion;
          }
        }
      }

      if (isInterview && interviewTurn) {
        const finals = interviewTurn.finals.filter((u) => u.text?.trim());
        const gate = evaluateInterviewTurn(interviewTurn);
        turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        console.log(
          `[AI:${turnId}] transcript=${logTruncate(
            finals.map((f) => `${f.source}:${f.text}`).join(" | "),
            300,
          )} | gate=${gate.action} ${gate.action === "wait" ? `reason="${gate.reason}"` : `question="${logTruncate(gate.question, 120)}"`}`,
        );

        if (gate.action === "wait") {
          outcomeRef.current = "wait";
          const signature = turnSignature(interviewTurn);
          const previous = lastGateRef.current;
          const insistingAgain =
            previous.signature === signature &&
            Date.now() - previous.ts < 30000;

          if (!insistingAgain) {
            lastGateRef.current = { signature, ts: Date.now() };
            // A WAIT result is authoritative: clear any stale detected question
            // from a previous turn so the UI never shows both a question and WAIT.
            setDetectedQuestion(null);
            setAnswerIssue(null);
            setAgentNotice(gate.reason);
            setError(null);
            return;
          }

          // Second identical trigger = explicit user override. The rules in the
          // system prompt still apply, so the model may answer WAIT again.
          questionIndex = Math.max(0, finals.length - 1);
          setDetectedQuestion({
            text: finals[questionIndex]?.text.trim() ?? "",
            mode: displayMode,
            forced: true,
          });
        } else {
          lastGateRef.current = { signature: "", ts: 0 };
          questionIndex = gate.questionIndex;
          // Publish what the gate locked onto (or the corrected question when a
          // candidate correction was strongly supported) so the UI shows the
          // question that will actually be answered.
          const displayedQuestion =
            usedCandidateCorrection ? finalQuestion : gate.question;
          // Clear any prior WAIT notice — this turn is proceeding to answer.
          setAgentNotice(null);
          setAnswerIssue(null);
          setDetectedQuestion({ text: displayedQuestion, mode: displayMode });
        }
      }

      // ── Duplicate-request guard ─────────────────────────────────────────
      // The hotkey pressed twice on the same transcript — or auto mode racing
      // the hotkey — must not fire two requests. `Retry` bypasses this, and a
      // failed/partial run leaves the transcript re-submittable.
      if (isInterview && interviewTurn && origin !== "retry") {
        const signature = turnSignature(interviewTurn);
        const previous = lastSubmitRef.current;
        if (isDuplicateSubmit(previous, signature)) {
          console.log("[AI] duplicate submit ignored (same transcript)");
          outcomeRef.current = "duplicate";
          return;
        }
        submittedSignature = signature;
        lastSubmitRef.current = { signature, status: "in-flight" };
      }

      // A run that is superseded or errors must not leave its transcript locked
      // as "in-flight" (which would silently swallow the next submit).
      const clearSubmitLock = () => {
        if (
          submittedSignature &&
          lastSubmitRef.current.signature === submittedSignature
        ) {
          lastSubmitRef.current = {
            signature: submittedSignature,
            status: "failed",
          };
        }
      };

      if (isInterview && interviewTurn) {
        // Kept so the Retry action can re-ask exactly the same question.
        lastInterviewTurnRef.current = interviewTurn;
      }

      // Abort any ongoing stream
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const signal = abortController.signal;
      const requestId = ++requestIdRef.current;
      const isStale = () => signal.aborted || requestId !== requestIdRef.current;

      setCurrentSolution("");
      setError(null);
      setAgentNotice(null);
      setAnswerIssue(null);
      // A screenshot / follow-up run has no interviewer question behind it.
      if (!isInterview) setDetectedQuestion(null);
      setIsStreaming(true);
      setFollowUpText(""); // clear input

      // Behavioural rules live in the provider's SYSTEM slot; the candidate
      // context is part of it too, so the transcript in the user message stays
      // the only answerable content.
      let systemInstruction: string | undefined;
      // Raw chat history is only used by the screenshot flow. For a live turn the
      // background is embedded (and explicitly labelled) inside the prompt, so no
      // old assistant message can act as a continuation prompt.
      let historyContext: { role: "user" | "assistant"; content: string }[];
      // What the chat bubble shows/stores. Never the full template.
      let userMessageContent: string;
      let prompt = "";

      if (isInterview && interviewTurn) {
        const finals = interviewTurn.finals.filter((u) => u.text?.trim());
        const latest = finals[questionIndex] ?? finals[finals.length - 1];
        // The gate has decided; this stage ends here.
        recorderRef.current?.since("submit", "gate");
        // The question the AI answers. The raw question is preserved in the
        // transcript as normal; a candidate correction only changes what the AI
        // receives (e.g. "What is mango?" + "MongoDB" → "What is MongoDB?").
        userMessageContent = `🎙️ ${(finalQuestion ?? latest?.text.trim()) ?? "(no audio captured)"}`;
        systemInstruction = buildInterviewSystemPrompt(settings);

        // ── Session context ───────────────────────────────────────────────
        // Runs AFTER the gate has already answered "is this a real question?",
        // because a problem must be a question to be worth remembering, and
        // BEFORE the prompt is built.
        //
        // Order matters and is the whole design:
        //   1. TTL prune — an expired context must never be attached.
        //   2. A new problem start REPLACES it.
        //   3. Otherwise, a follow-up attaches and refreshes `lastUsedAt`.
        //
        // Step 2 is `classifyFollowUp`'s job, which returns
        // "a new problem replaces it" — so the decision and the reason for it
        // come from one place rather than two that can disagree.
        const ctxNow = Date.now();
        const prunedCtx = pruneSessionContext(
          useStore.getState().sessionContext,
          ctxNow,
        );
        if (prunedCtx !== useStore.getState().sessionContext) {
          setSessionContext(prunedCtx);
        }

        const resolvedQuestion = (finalQuestion ?? latest?.text.trim()) ?? "";
        const verdict = classifyFollowUp(resolvedQuestion, prunedCtx, ctxNow);
        let activeCtx = prunedCtx;

        if (resolvedQuestion) {
          if (detectProblemStart(resolvedQuestion).isProblemStart) {
            activeCtx = startProblem(prunedCtx, resolvedQuestion, ctxNow);
            setSessionContext(activeCtx);
            console.log(
              `[CTX] problem started kind=${activeCtx.activeProblem?.kind} id=${activeCtx.activeProblem?.id}`,
            );
          } else if (verdict.attach) {
            activeCtx = touchProblem(prunedCtx, ctxNow);
            setSessionContext(activeCtx);
            console.log(`[CTX] context attached — ${verdict.cue}`);
          } else if (prunedCtx.activeProblem) {
            // Logged even when it does NOT attach: "why did it not use my
            // context" is the first question this feature will be asked, and
            // the answer has to be in the log rather than inferred.
            console.log(`[CTX] context not attached — ${verdict.reason}`);
          }
        }

        // ── Which ONE block goes in the prompt ────────────────────────────
        //
        // `activeProblem` and `conversationThread` can both be live at once, and
        // exactly one may be attached. `selectContextBlock` owns that choice, so
        // the precedence rule lives in one tested function rather than in this
        // component.
        //
        // Empty string when nothing applies, which is what keeps the prompt
        // byte-identical to the previous output on every non-follow-up turn.
        const selection = selectContextBlock({
          question: resolvedQuestion,
          problem: verdict,
          context: activeCtx,
          thread: activeCtx.conversationThread,
          now: ctxNow,
        });
        const ctxBlock = selection.block;

        // The thread turn is appended AFTER the answer is validated, because the
        // excerpt must come from a validated answer — see below. What is decided
        // HERE is only whether this question continues the thread or opens a new
        // subject, since that depends on the question alone.
        const threadVerdict = selection.threadVerdict;
        if (resolvedQuestion) {
          if (threadVerdict.attach) {
            console.log(
              `[CTX] thread attached overlap=${threadVerdict.overlap} turns=${activeCtx.conversationThread?.turns.length ?? 0}`,
            );
          } else if (
            threadVerdict.reason === "new subject: does not attach" ||
            threadVerdict.reason === "thread expired (older than the TTL)"
          ) {
            // A fresh subject REPLACES the thread. Never a silent revive of
            // expired context, and never two subjects in one thread.
            const fresh = startThread(resolvedQuestion, ctxNow);
            activeCtx = { ...activeCtx, conversationThread: fresh };
            setSessionContext(activeCtx);
            console.log(
              `[CTX] thread started — ${threadVerdict.reason}`,
            );
          }
        }

        prompt = buildInterviewUserPrompt(interviewTurn, {
          questionIndex,
          contextBlock: ctxBlock,
          previousAnswers: sessionMessages
            .filter((m) => m.role === "assistant")
            .slice(-2)
            .map((m) => m.content),
        });
        // The user prompt's latest-question block must reflect the corrected
        // question too, so the model cannot confuse the raw transcript for the
        // current question.
        historyContext = [];
      } else {
        // Pre-interview context (resume / company / JD / answer style) is appended
        // to every prompt so answers are tailored to this specific interview.
        // The resume is skipped on follow-ups — it is already carried in the first
        // user message of the session, so re-sending it only wastes tokens.
        const contextBlock = buildInterviewContext(settings, {
          includeResume: !isFollowUp,
        });

        if (followUpQuery) {
          prompt = followUpQuery;
        } else {
          prompt =
            settings.interviewType === "general"
              ? settings.customInstructions ||
                "Please answer the general question."
              : buildPrompt(settings.interviewType, settings.language);
        }
        prompt += contextBlock;
        userMessageContent = prompt;
        // Prompt assembled. The system message is built above this line and is
        // excluded from the user-side assembly time on purpose.
        recorderRef.current?.since("submit", "prompt_built");
        historyContext = sessionMessages.slice(-6).map((msg) => ({
          role: msg.role,
          content: msg.content,
        }));
      }

      try {
        let fullSolution = "";
        // The exact question this run is answering, used by the output validator
        // for the question-echo signal only.
        let answeredQuestion = "";

        // Use the latest screenshot for the AI call (if it exists)
        const latestScreenshot =
          screenshotList.length > 0
            ? screenshotList[screenshotList.length - 1]
            : undefined;

        if (isInterview && interviewTurn) {
          // A candidate correction can change the raw question (e.g.
          // "What is mango?" + "MongoDB" → "What is MongoDB?"), so the
          // corrected question is the single source of truth for the run.
          const latest =
            interviewTurn.finals
              .filter((u) => u.text?.trim())
              .slice(questionIndex)[0];
          answeredQuestion = (finalQuestion ?? latest?.text?.trim()) ?? "";
          console.log(
            `[AI] question: ${logTruncate(answeredQuestion, 160)}`,
          );
        }

        // ── Answer orchestration ──────────────────────────────────────────────────
        // OpenRouter Free is attempted immediately. If it has produced no
        // meaningful text after OPENROUTER_HEDGE_MS, Groq is started alongside
        // it (max 2 concurrent). The first provider to COMPLETE with an answer
        // that passes the validator wins; every loser is aborted.
        //
        // Nothing is streamed to the screen: the answer is shown only once it is
        // complete, which is what makes "first VALID COMPLETE answer wins"
        // meaningful and makes a cross-provider overwrite structurally
        // impossible.
        console.log(
          `[AI:${turnId}] orchestrating — chain=${attempts.map((a) => `${a.provider}(${a.model})`).join(" → ")}`,
        );
        recorderRef.current?.since("submit", "orchestration_start");
        const run = await orchestrateAnswer({
          attempts,
          prompt,
          system: systemInstruction,
          messages: historyContext,
          base64Image: latestScreenshot,
          mimeType: latestScreenshot ? "image/png" : undefined,
          signal,
          log: (line) => console.log(line),
          // Only a completed, validated answer may win. This is the same
          // validator the final UI gate uses, so nothing is weakened.
          validate: (text) => {
            if (isWaitResponse(text)) return { ok: false, reason: "wait" };
            return validateAnswerOutput(text, {
              question: answeredQuestion,
              // Only the STATIC rules template — never the assembled system
              // message, which also carries the candidate resume.
              promptTemplate: INTERVIEW_SYSTEM_PROMPT,
            });
          },
          // Providers on cooldown are removed from the run before it starts, so
          // a 429 costs zero latency rather than a full timeout. Every hard
          // failure is reported back, which is how a provider becomes parked in
          // the first place.
          cooldown: cooldown.gate,
          onStatus: (status) => {
            // Stale = superseded or aborted: never touch the UI.
            if (isStale() || !isInterview) return;
            const current = useStore.getState().detectedQuestion;
            if (!current) return;
            const who =
              status.provider === "openrouter" &&
              isOpenRouterFreeModel(status.model ?? "")
                ? "OpenRouter Free"
                : providerLabel(status.provider ?? "");
            const note =
              status.state === "hedging"
                ? (status.note ?? `OpenRouter slow → ${who}`)
                : status.state === "completed"
                  ? `${who}`
                  : `ANSWERING… · ${who}`;
            setDetectedQuestion({ ...current, provider: status.provider, model: status.model, note });
          },
        });

        if (isStale()) {
          clearSubmitLock();
          outcomeRef.current = "superseded";
          return; // Superseded mid-flight: leave the UI to the newer run.
        }

        // Log the full failover chain result so we can see exactly what each
        // provider did: Groq's HTTP status / error body / finish_reason / timeout,
        // and whether Gemini was tried and whether it returned text.
        if (run.failures.length > 0) {
          for (const f of run.failures) {
            console.log(
              `[AI:${turnId}] ${f.provider.toUpperCase()} did not win (reason=${f.reason}) — "${f.message}"`,
            );
          }
        }
        console.log(
          `[AI:${turnId}] summary: attempts=${run.attempts} hedged=${run.hedged} winner=${run.provider ?? "(none)"}`,
        );
        // ── Per-provider timings, straight from the orchestrator's own ────────
        // telemetry. Nothing is recomputed here: these are already
        // renderer-local `performance.now()` deltas measured from each attempt's
        // start, so they need no cross-process handling.
        //
        // `verdict` is a closed vocabulary (accepted / failed / aborted / the
        // orchestrator's own failure reasons) so the report never has to quote
        // model output to explain why a provider lost.
        providersRef.current = run.attemptsStarted.map((t) => ({
          provider: t.provider,
          model: t.resolvedModel ?? t.model,
          httpMs: t.httpMs,
          firstChunkMs: t.firstChunkMs,
          firstTextMs: t.firstTextMs,
          completeMs: t.completeMs,
          totalMs: t.totalMs,
          winner: t.winner,
          hedged: t.hedged,
          verdict: t.winner
            ? "accepted"
            : t.failureReason ??
              (t.outcome === "cancelled" || t.outcome === "cancelled_by_winner"
                ? "aborted"
                : t.outcome),
        }));
        if (run.provider) {
          recorderRef.current?.since("submit", "provider_accepted");
        } else {
          outcomeRef.current = "empty";
        }
        if (run.provider) {
          // Capture the actual backend provider for OpenRouter UI display.
          if (run.provider === "openrouter" && run.backend) {
            setOpenRouterBackendProvider(run.backend);
          }
          // For `openrouter/free` the resolved model is the interesting fact:
          // OpenRouter picked a different concrete free model than we asked for.
          if (
            run.provider === "openrouter" &&
            run.resolvedModel &&
            isOpenRouterFreeModel(run.model) &&
            !isStale()
          ) {
            const current = useStore.getState().detectedQuestion;
            if (current) {
              setDetectedQuestion({
                ...current,
                note: `OpenRouter Free • ${run.resolvedModel}${
                  run.backend ? ` via ${run.backend}` : ""
                }`,
              });
            }
          }
          console.log(
            `[AI:${turnId}] WINNER provider=${run.provider} requested=${run.model} resolvedModel=${run.resolvedModel ?? "(same)"} backend=${run.backend ?? "(direct)"} finishReason=${run.finishReason ?? "(none)"} text="${logTruncate(run.text, 120)}"`,
          );
        } else {
          console.log(
            `[AI:${turnId}] NO WINNER — ${run.attempts} provider(s) tried, ${run.failures.length} failure(s).`,
          );
        }

        if (isStale()) {
          return; // Skip history save if we aborted / were superseded
        }

        fullSolution = run.text;

        // ── Nothing usable from any provider ──────────────────────────────
        // Never save "", never render an empty card: report what the providers
        // actually said and offer Retry.
        if (!fullSolution.trim()) {
          outcomeRef.current = "empty";
          // ── Say WHAT is wrong, not what the provider said ───────────────
          // The raw text here is `Groq API error: Rate limit reached…` or a
          // Chromium CORS message. It names a condition the user cannot act on
          // and hides the two they can: which provider is parked until when,
          // and whether the provider they expected is even in the chain.
          const chain = describeProviderChain(settings);
          const summary = buildCooldownSummary({
            state: cooldown.state,
            now: Date.now(),
            chain: chain.status
              .filter((s) => s.availability === "ready")
              .map((s) => s.provider),
            chainNotes: chain.status
              .filter((s) => s.availability !== "ready")
              .map((s) => ({ provider: s.provider, reason: s.detail })),
            failures: run.failures,
          });
          const detail = [
            summary.headline,
            ...summary.lines,
            // Providers that WERE tried still deserve one line each, but the
            // headline already says why, so this stays short.
            run.failures.length
              ? `Last error: ${run.failures[0].provider.toUpperCase()} — ${
                  run.failures[0].reason
                }`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
          console.error(
            `[AI] no usable answer — ${summary.headline} | ${summary.lines.join(
              " | ",
            )} | raw=${run.error ?? "(none)"}`,
          );
          setCurrentSolution("");
          setAnswerIssue({ kind: "empty", message: detail });
          lastSubmitRef.current = {
            signature: lastSubmitRef.current.signature,
            status: "failed",
          };
          return;
        }

        // The agent refused to answer: no clear question was ever asked, so
        // nothing is shown, stored in the session, or written to history.
        // A WAIT result is authoritative: clear the detected question so the UI
        // never shows both a question banner and a WAIT banner at the same time.
        if (isInterview && isWaitResponse(fullSolution)) {
          outcomeRef.current = "wait";
          console.log(
            `[AI:${turnId}] LLM returned WAIT for a gated question — clearing detected question. LLM text: "${logTruncate(fullSolution, 120)}"`,
          );
          setCurrentSolution("");
          setDetectedQuestion(null);
          setAnswerIssue(null);
          setAgentNotice("no clear question was asked");
          return;
        }

        // ── Output validation (belt-and-braces) ───────────────────────────────
        // The orchestrator ALREADY ran this validator before letting a provider
        // win, so reaching the failure branch here means something is wrong
        // upstream. Kept as a hard stop so a degenerate answer can never be
        // saved to history or fed back as `previousAnswers` for the next turn.
        const validation = validateAnswerOutput(fullSolution, {
          question: answeredQuestion,
          promptTemplate: INTERVIEW_SYSTEM_PROMPT,
        });

        // ── Record this turn on the conversation thread ───────────────────
        //
        // ONLY a VALIDATED answer is excerpted. An answer that failed the gate
        // is by definition a refusal or a prompt artefact, and storing an
        // excerpt of one would feed garbage into every later turn's prompt.
        //
        // The question is recorded either way, because it was genuinely asked
        // — it is the answer that must be trustworthy, and a turn with a null
        // answerHead omits the line rather than printing a bare label.
        if (answeredQuestion) {
          const head = validation.ok
            ? extractAnswerHead(fullSolution)
            : null;
          const prior = useStore.getState().sessionContext;
          // The thread may have been replaced by the selection step above; read
          // it back rather than using the stale local copy.
          if (prior.conversationThread) {
            const next = appendThreadTurn(
              prior.conversationThread,
              answeredQuestion,
              head,
              Date.now(),
            );
            setSessionContext({ ...prior, conversationThread: next });
            console.log(
              `[CTX] thread turn recorded turns=${next.turns.length} answerHead=${head ? "yes" : "none"}`,
            );
          }
        }

        // ── SHADOW RULE (c) — computed, logged, NEVER enforced ─────────────
        //
        // Runs on every answer the validator ACCEPTED, which is the only
        // population where the question "would this rule have helped, and would
        // it have hurt?" can be answered. Numbers only: a would-reject flag and
        // an overlap score. No answer text, no question text, no topic list.
        //
        // Computed BEFORE the rejection branch and regardless of its outcome,
        // so the two rules can be compared on the same turns rather than on
        // whatever survived this one.
        shadowOverlapRef.current = shadowOverlapCheck(fullSolution, answeredQuestion);
        {
          const s = shadowOverlapRef.current;
          console.log(
            `[AI:${turnId}] shadow-overlap wouldReject=${s.wouldReject} ` +
              `score=${s.overlapScore} shared=${s.sharedContentWords} ` +
              `q=${s.questionContentWords} a=${s.answerContentWords} ` +
              `abstained=${s.abstained ?? "none"}`,
          );
        }

        if (!validation.ok) {
          outcomeRef.current = "rejected";
          console.error(
            `[AI:${turnId}] output rejected by validator (${validation.reason}) — ${validation.detail} | raw="${logTruncate(fullSolution, 120)}"`,
          );
          setCurrentSolution("");
          setAnswerIssue({
            kind: "empty",
            message: `The model returned something that is not an answer (${validation.reason}). Press Retry.`,
          });
          lastSubmitRef.current = {
            signature: lastSubmitRef.current.signature,
            status: "failed",
          };
          return;
        }

        // Add User Message to Session
        addSessionMessage({
          id: uuidv4(),
          role: "user",
          content: userMessageContent,
          screenshotBase64: latestScreenshot,
        });

        // Add AI Assistant Message to Session
        addSessionMessage({
          id: uuidv4(),
          role: "assistant",
          content: fullSolution,
        });

        // Save to global history log
        const entry = {
          id: uuidv4(),
          timestamp: Date.now(),
          screenshotBase64: latestScreenshot,
          solution: fullSolution,
          provider: run.provider ?? settings.activeProvider,
          model: run.resolvedModel ?? run.model,
          interviewType: isInterview
            ? "live-interview"
            : settings.interviewType,
          language: settings.language,
        };
        addToHistory(entry);
        // The answer is committed: in the store, in the session, in history.
        // This is the end of the cross-process metric — `Date.now()` at this
        // instant minus the main process' press instant.
        recorderRef.current?.since("submit", "committed");
        // `rendered` is the next task after the commit, which is as close to
        // "painted" as a synchronous React 18 update can be measured without
        // instrumenting the reconciler. Stated in the report as an upper bound.
        setTimeout(() => {
          recorderRef.current?.since("submit", "rendered");
        }, 0);

        try {
          const currentHistory = await window.ghostly.getHistory();
          await window.ghostly.saveHistory([entry, ...currentHistory]);
        } catch {
          /* best-effort */
        }

        // A completed answer means this transcript is done.
        if (isInterview) {
          lastSubmitRef.current = {
            signature: lastSubmitRef.current.signature,
            status: "ok",
          };
        }

        // ── Remember the approach ────────────────────────────────────────
        // Only here, which is the only point where an answer is KNOWN to have
        // passed the output gate. Summarising an earlier point in the flow
        // would put a refusal or a prompt artefact into every later prompt.
        //
        // No LLM call: `extractApproachSummary` is a truncation. And no
        // transcript text reaches a log — only the boolean and a character
        // count.
        if (isInterview) {
          const summary = extractApproachSummary(fullSolution);
          const current = useStore.getState().sessionContext;
          if (summary && current.activeProblem) {
            setSessionContext({
              ...current,
              approachSummary: summary,
              activeProblem: {
                ...current.activeProblem,
                lastUsedAt: Date.now(),
              },
            });
            console.log(
              `[CTX] approach summary stored (${summary.length} chars)`,
            );
          }
        }
      } catch (err) {
        clearSubmitLock();
        if (isStale()) return;
        const message =
          err instanceof Error ? err.message : "AI streaming failed";
        setError(message);
      } finally {
        // Only the newest run may clear the UI — an older one finishing late
        // must not wipe the answer that replaced it.
        if (!isStale()) {
          setIsStreaming(false);
          setCurrentSolution(""); // Clear current (it is now in session messages)
        }
      }
    },
    [
      settings,
      sessionMessages,
      setCurrentSolution,
      setError,
      setIsStreaming,
      addToHistory,
      addSessionMessage,
      updateSettings,
      setAgentNotice,
      setDetectedQuestion,
      setAnswerIssue,
      setOpenRouterBackendProvider,
    ],
  );

  // ── The measured entry point ───────────────────────────────────────────────
  //
  // Starts the recorder, stamps the cross-process hotkey anchor, runs the
  // original function, and publishes exactly one `TurnTimings` per call. A
  // throw still publishes (as `aborted`), because a stage that never recorded is
  // precisely the one worth seeing in the report.
  const runAIStream = useCallback(
    async (
      screenshotList: string[],
      turn?: InterviewTurn,
      followUpQuery?: string,
      origin: "auto" | "manual" | "retry" = "manual",
      candidateSignal?: { text: string; timestamp?: number },
    ) => {
      // Adopt the hotkey's recorder when there is one — the drain and the
      // force-endpoint are stages that happened before this call, and they would
      // be missing from the report if a fresh recorder started here.
      const recorder =
        pendingRecorderRef.current ??
        (() => {
          const fresh = createStageRecorder();
          fresh.start(
            `lat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          );
          fresh.press(hotkeyPressedAtRef.current);
          return fresh;
        })();
      pendingRecorderRef.current = null;
      recorderRef.current = recorder;
      outcomeRef.current = "answered";
      try {
        await runAIStreamInner(
          screenshotList,
          turn,
          followUpQuery,
          origin,
          candidateSignal,
        );
      } catch (err) {
        outcomeRef.current = "aborted";
        console.error(`[AI] run failed: ${err}`);
      } finally {
        recorderRef.current = null;
        const record: TurnTimings = recorder.finish({
          outcome: outcomeRef.current,
          providers: providersRef.current,
          forceEndpoint: forceEndpointTimingsRef.current,
          truncated: truncatedRef.current,
          shadow: shadowOverlapRef.current ?? undefined,
        });
        shadowOverlapRef.current = null;
        providersRef.current = [];
        truncatedRef.current = false;
        forceEndpointTimingsRef.current = null;
        addLatencyTurn(record);
      }
    },
    [runAIStreamInner, addLatencyTurn],
  );

  const handleInterviewSubmit = useCallback(
    async (
      turn: InterviewTurn,
      candidateSignal?: { text: string; timestamp?: number },
      clearTranscript = true,
    ) => {
      setInterviewOpen(false);
      setInterviewCollapsed(false);
      if (clearTranscript) {
        clearInterviewMessages();
      }
      await runAIStream([], turn, undefined, "manual", candidateSignal);
    },
    [runAIStream, clearInterviewMessages],
  );

  const toggleInterview = useCallback(() => {
    clearInterviewMessages();
    setInterviewCollapsed(false);
    setInterviewOpen((prev) => !prev);
  }, [clearInterviewMessages]);

  const closeInterview = useCallback(() => {
    clearInterviewMessages();
    setInterviewCollapsed(false);
    setInterviewOpen(false);
  }, [clearInterviewMessages]);

  /** Re-ask the last question (used by the empty / partial answer banner). */
  const retryAnswer = useCallback(() => {
    const lastTurn = lastInterviewTurnRef.current;
    if (!lastTurn) return;
    setAnswerIssue(null);
    runAIStream([], lastTurn, undefined, "retry");
  }, [runAIStream, setAnswerIssue]);

  const handleFollowUpSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!followUpText.trim() || isStreaming) return;
      runAIStream([], undefined, followUpText.trim());
    },
    [followUpText, isStreaming, runAIStream],
  );

  // ── Auto-answer mode ────────────────────────────────────────────────────
  // Fires by itself once the interviewer finishes a clear question. Only
  // *finalized* utterances are considered (the gate ignores mid-sentence
  // speech), so this can never answer a partial transcript.
  //
  // runAIStream is reached through a ref so this effect doesn't re-arm its
  // settle timer every time settings or session history change.
  const runStreamRef = useRef(runAIStream);
  useEffect(() => {
    runStreamRef.current = runAIStream;
  }, [runAIStream]);

  // Last *submitted* transcript + how it ended, used to swallow duplicates.
  const lastSubmitRef = useRef<SubmitRecord>({
    signature: "",
    status: "failed",
  });
  // Last interview turn, so Retry can re-ask exactly the same question.
  const lastInterviewTurnRef = useRef<InterviewTurn | null>(null);
  // Auto-answer mode: the last finalized message we already acted on.
  const autoAnsweredRef = useRef<string | null>(null);
  const lastTranscript =
    interviewMessages[interviewMessages.length - 1] ?? null;
  const lastTranscriptId = lastTranscript?.id ?? null;

  useEffect(() => {
    if (!settings.autoAnswer || !interviewOpen) return;
    if (!lastTranscriptId || lastTranscript?.source !== "system") return;
    // Already handled this final — the effect also re-runs for other reasons.
    if (autoAnsweredRef.current === lastTranscriptId) return;

    // Same gate as the manual path — incomplete, fragmented or conversational
    // speech never even schedules an answer.
    const preview = normalizeTurn(useStore.getState().getInterviewTurn());
    const previewGate = evaluateInterviewTurn(preview);
    if (previewGate.action !== "answer") return;

    // Show what the gate locked onto *before* answering, so it can be seen
    // during the settle delay as well as while the answer streams.
    // A detected question and a WAIT notice are mutually exclusive states.
    setAgentNotice(null);
    setAnswerIssue(null);
    setDetectedQuestion({ text: previewGate.question, mode: "auto" });
    console.log(
      `[AI:auto] gate=answer question="${logTruncate(previewGate.question, 120)}" — scheduling answer in ${AUTO_ANSWER_SETTLE_MS}ms`,
    );

    const timer = window.setTimeout(() => {
      autoAnsweredRef.current = lastTranscriptId;
      // Re-check against the freshest transcript: the interviewer may have kept
      // talking during the settle delay.
      const turn = normalizeTurn(useStore.getState().getInterviewTurn());
      if (evaluateInterviewTurn(turn).action !== "answer") {
        console.log(
          `[AI:auto] re-check at settle time: gate no longer says answer — clearing detected question`,
        );
        setDetectedQuestion(null);
        setAgentNotice(null);
        return;
      }
      runStreamRef.current([], turn, undefined, "auto");
    }, AUTO_ANSWER_SETTLE_MS);

    return () => window.clearTimeout(timer);
  }, [
    settings.autoAnswer,
    interviewOpen,
    lastTranscriptId,
    lastTranscript,
    setDetectedQuestion,
  ]);

  /**
   * Start / Stop Interview shortcut (Ctrl+I).
   *
   * Reuses the EXISTING capture lifecycle: it calls the same `startInterview` /
   * `stopInterview` the panel's Start/Stop buttons call, through the
   * `lib/interviewControls` bridge. It never opens a second capture stream.
   * When the panel is closed it opens it first and defers the start until the
   * ASR model is ready, so a single press is never dropped.
   */
  const toggleInterviewShortcut = useCallback(() => {
    const controls = getInterviewControls();
    const outcome = planInterviewToggle(
      controls
        ? { isRecording: controls.isRecording(), canStart: controls.canStart() }
        : null,
    );
    if (outcome === "stop") {
      controls?.stop();
      return;
    }
    if (!interviewOpenRef.current) {
      setInterviewOpen(true);
      setInterviewCollapsed(false);
    }
    if (outcome === "start") {
      controls?.start();
      return;
    }
    // Panel still mounting, or the ASR model is still loading.
    requestPendingStart();
  }, []);

  /**
   * Next Question shortcut (Ctrl+N).
   *
   * Advances/resets the CURRENT question state using the existing reset
   * primitives (the same `clearInterviewMessages` + gate refs that Ctrl+G and
   * a fresh session use). It does NOT stop capture, does NOT start another
   * stream, and does NOT submit the question to the AI.
   */
  const nextQuestion = useCallback(() => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    requestIdRef.current++; // invalidate anything still in flight
    lastGateRef.current = { signature: "", ts: 0 };
    lastSubmitRef.current = { signature: "", status: "failed" };
    lastInterviewTurnRef.current = null;
    autoAnsweredRef.current = null;
    clearInterviewMessages();
    setDetectedQuestion(null);
    setAgentNotice(null);
    setAnswerIssue(null);
    setInterviewCollapsed(false);
  }, [
    clearInterviewMessages,
    setDetectedQuestion,
    setAgentNotice,
    setAnswerIssue,
  ]);

  // Listen for hotkey events from main process
  useEffect(() => {
    // Safety guard — window.ghostly only exists inside Electron
    if (!window.ghostly) {
      console.error("[Ghostly] window.ghostly is undefined — not running inside Electron?");
      return;
    }

    // Ctrl+H — screenshot captured (multiple accumulate)
    const offScreenshot = window.ghostly.onScreenshot((b64: string) => {
      addScreenshot(b64);
    });

    // Ctrl+Enter — solve. While the interview panel is open, prefer the live
    // transcript (interviewer's question); otherwise use accumulated screenshots.
    // Screenshots are still attached when present, so a code question captured
    // on screen + its spoken explanation both reach the AI.
    const offSolve = window.ghostly.onSolve(async (payload) => {
      const shots = screenshotsRef.current;
      // The recorder is created HERE, not in `runAIStream`, because the drain
      // and the force-endpoint happen before that call and both are stages the
      // report must contain. `runAIStream` adopts this recorder rather than
      // creating its own, so the turn is one continuous measurement.
      const pressedAt = payload?.pressedAt ?? null;
      hotkeyPressedAtRef.current = pressedAt;
      const recorder = createStageRecorder();
      recorder.start(
        `lat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      );
      recorder.press(pressedAt);
      // The ONLY cross-process duration in the report: two `Date.now()` values,
      // one from the main process and one from here. Quoted as
      // +/-CROSS_PROCESS_ACCURACY_MS, not as a monotonic figure.
      if (pressedAt !== null) {
        recorder.mark("hotkey_to_submit", Date.now() - pressedAt);
      }
      pendingRecorderRef.current = recorder;
      recorderRef.current = recorder;
      let turn: InterviewTurn | undefined;
      let forceEndpoint = null as Awaited<ReturnType<typeof forceEndpointOnSubmit>> | null;
      if (interviewOpenRef.current) {
        const tDrainStart = performance.now();
        // ── Force endpoint ────────────────────────────────────────────────
        // MUST run before the drain: the drain can only wait for finals that
        // already exist, and a phrase the VAD has not closed is not one. When a
        // phrase is open and the interviewer is silent, this asks the live
        // worklet to close it so the tail of the question is decoded and
        // committed before the transcript is read. When it declines, the reason
        // is one of a closed set — numbers only, never text.
        forceEndpoint = await forceEndpointOnSubmit({
          log: (line) => console.log(`[ASR] ${line}`),
        });
        // ── Drain barrier ────────────────────────────────────────────────
        // `getInterviewTurn()` is SYNCHRONOUS, but a final for the phrase the
        // interviewer just finished is still decoding in the worker at this
        // instant. Reading the transcript immediately therefore submitted the
        // question with its last words missing — a confidently wrong answer
        // rather than a visible failure.
        //
        // The barrier is bounded (see `lib/asrDrain.ts`): it waits for the
        // in-flight final to be committed, and on timeout proceeds anyway with
        // whatever IS committed, logging that the tail may be missing. It
        // cannot reject, so this await cannot block or break the hotkey.
        const drain = await drainInterviewAsr();
        if (drain.outcome !== "alreadyIdle" && drain.outcome !== "noWorker") {
          console.log(`[ASR] submit drain: ${describeDrain(drain)}`);
        }
        forceEndpointTimingsRef.current = {
          fired: forceEndpoint?.fired ?? false,
          skipped: forceEndpoint?.fired ? undefined : forceEndpoint?.reason,
          bufferedMs: forceEndpoint?.bufferedMs ?? 0,
          decodeMs: forceEndpoint?.decodeMs ?? null,
        };
        // A phrase was open and we did NOT close it, so the submitted question
        // may be missing its tail. Recorded, never acted on.
        truncatedRef.current =
          forceEndpoint?.reason === "no-phrase-open" ||
          forceEndpoint?.reason === "interviewer-still-speaking";
        // Read the transcript ONLY after the barrier, so it includes the final
        // that was in flight.
        turn = useStore.getState().getInterviewTurn();
        hotkeyTranscriptReadyAtRef.current = Date.now();
        // Renderer-local `performance.now()` delta, so this one claims +/-1ms.
        recorderRef.current?.mark("drain", performance.now() - tDrainStart);
        if (forceEndpoint?.decodeMs != null) {
          recorderRef.current?.mark(
            "force_endpoint_decode",
            forceEndpoint.decodeMs,
          );
        }
      }
      if (turn) {
        // Free the vertical space for the answer: the panel collapses to a
        // single bar but keeps capturing (closing it would stop the audio).
        setInterviewCollapsed(true);
      }
      await runAIStream(shots, turn);
      // The turn's own timings are published by `runAIStream`; this only has to
      // stop the next hotkey press inheriting this one's instants.
      hotkeyPressedAtRef.current = null;
      hotkeyTranscriptReadyAtRef.current = null;
      recorderRef.current = null;
    });

    // Ctrl+G — start over (clear everything)
    const offStartOver = window.ghostly.onStartOver(() => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      requestIdRef.current++; // invalidate anything still in flight
      lastGateRef.current = { signature: "", ts: 0 };
      lastSubmitRef.current = { signature: "", status: "failed" };
      lastInterviewTurnRef.current = null;
      setInterviewCollapsed(false);
      setIsStreaming(false);
      clearSolution();
      // ── Reset interview also drops the session context ─────────────────
      // The ONLY clear-on-a-key binding that may do this. Ctrl+G already means
      // "start over from nothing", so leaving a problem behind here would make
      // the next question be answered as a follow-up to a conversation the user
      // just declared finished.
      clearSessionContext();
    });

    // Interview Type Shortcuts — Ctrl+Shift+1/2/3/4/5/6
    const interviewTypes = [
      "dsa",
      "system_design",
      "frontend",
      "sql",
      "behavioral",
      "general",
    ] as const;
    const offInterviewType = interviewTypes.map((type) =>
      window.ghostly.onInterviewType(type, () => {
        updateSettings({ interviewType: type });
      }),
    );

    // Ctrl+I — Start / Stop Interview. The guard swallows key auto-repeat and
    // rapid double-fires of the same action.
    const offToggleInterview = window.ghostly.onToggleInterview(() => {
      if (!shortcutGuardRef.current.shouldHandle("toggle-interview")) return;
      toggleInterviewShortcut();
    });

    // Ctrl+N — Next Question. Never submits an answer and never stops capture.
    const offNextQuestion = window.ghostly.onNextQuestion(() => {
      if (!shortcutGuardRef.current.shouldHandle("next-question")) return;
      nextQuestion();
    });

    return () => {
      offScreenshot();
      offSolve();
      offStartOver();
      offInterviewType.forEach((off) => off());
      offToggleInterview();
      offNextQuestion();
    };
  }, [
    runAIStream,
    addScreenshot,
    clearSolution,
    setIsStreaming,
    updateSettings,
    toggleInterviewShortcut,
    nextQuestion,
  ]);

  return (
    <div className="h-screen w-full bg-transparent text-white font-mono pointer-events-none select-none flex flex-col">
      {/* Top Bar */}
      <div className="flex-none">
        <TopBar
          onOpenSettings={() => setSettingsOpen(true)}
          settingsOpen={settingsOpen}
          onStartInterview={toggleInterview}
        />
      </div>

      {/* Settings Panel */}
      <AnimatePresence>
        {settingsOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
            style={{ pointerEvents: "auto" }}
          >
            <SettingsPanel onClose={() => setSettingsOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Content Area (only when settings are closed) */}
      {!settingsOpen && (
        <div className="flex-1 min-h-0 flex justify-center mt-2 pb-6 overflow-hidden">
          <div className="w-[860px] space-y-2 flex flex-col h-full">
            {/* Inline Interview Panel */}
            <AnimatePresence>
              {interviewOpen && (
                <motion.div
                  initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                  animate={{ opacity: 1, height: "auto", marginBottom: 8 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  className="overflow-hidden flex-shrink-0"
                  transition={{ duration: 0.2 }}
                >
                  <InterviewModal
                    onClose={closeInterview}
                    onSubmit={handleInterviewSubmit}
                    collapsed={interviewCollapsed}
                    onToggleCollapse={() =>
                      setInterviewCollapsed((prev) => !prev)
                    }
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* What the question-detection gate locked onto. Shown before the
                answer starts (auto mode: during the settle delay) and kept
                visible while it streams, so a mis-read can be spotted instantly. */}
            <AnimatePresence>
              {detectedQuestion && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="px-3 py-2 rounded-xl pointer-events-auto flex-shrink-0"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[9px] uppercase tracking-wider text-accent/70">
                      {detectedQuestion.forced
                        ? "Forced · gate said WAIT"
                        : detectedQuestion.mode === "auto"
                          ? "Auto · detected question"
                          : "Detected question"}
                    </span>
                    {/* Active provider / failover state */}
                    {detectedQuestion.provider && (
                      <span
                        className={`text-[9px] font-mono truncate ${
                          detectedQuestion.note?.includes("→")
                            ? "text-amber-200/70"
                            : "text-white/30"
                        }`}
                      >
                        {detectedQuestion.note ??
                          `Using ${providerLabel(detectedQuestion.provider)}`}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-white/75 font-mono leading-snug line-clamp-2 mt-0.5">
                    {detectedQuestion.text || "(no speech captured)"}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Answer could not be produced (empty) or was cut short. */}
            <AnimatePresence>
              {/*
                ── Session context chip ───────────────────────────────────────
                Placed directly above the detected-question banner because that
                is the only place the user reads the question they are about to
                be asked, so it is also the only place where "what is this
                referring to" is answerable at a glance.

                The "Use as context" offer is only rendered when the Solve /
                screenshot flow actually produced something, and it is a button:
                nothing is ever attached without an explicit click.
              */}
              {(!settingsOpen || true) && (
                <SessionContextChip
                  context={sessionContext}
                  now={ctxTick}
                  onChange={setSessionContext}
                  onClear={clearSessionContext}
                  offerSolution={
                    !sessionContext.activeProblem &&
                    currentSolution?.trim()
                      ? { label: "Use answer as context", source: "screenshot" as ProblemSource }
                      : null
                  }
                  onUseSolution={(source) =>
                    setSessionContext(
                      startProblem(
                        sessionContext,
                        currentSolution.trim(),
                        Date.now(),
                        source,
                      ),
                    )
                  }
                />
              )}

              {answerIssue && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="px-3 py-2 rounded-xl pointer-events-auto flex-shrink-0 flex items-center justify-between gap-3"
                  style={{
                    background: "rgba(255, 90, 90, 0.08)",
                    border: "1px solid rgba(255, 90, 90, 0.20)",
                  }}
                >
                  <div className="min-w-0">
                    <span className="text-[9px] uppercase tracking-wider text-red-200/70">
                      {answerIssue.kind === "empty"
                        ? "No answer received"
                        : "Answer cut off — partial kept"}
                    </span>
                    {/*
                      Rendered as lines rather than one clamped string.

                      A single `line-clamp-2` paragraph cannot show "OpenRouter is
                      out of quota for 3h 15m, Groq is not in your provider
                      chain" — it clips to the first fragment, which is the least
                      useful part. The message is built from short, deliberate
                      lines in `buildCooldownSummary`, so preserving them verbatim
                      is what makes the panel actionable.
                    */}
                    <div className="text-[10px] text-white/55 font-mono leading-snug mt-0.5 space-y-0.5">
                      {answerIssue.message.split("\n").map((line, i) => (
                        <p key={i} className={i === 0 ? "text-white/75" : ""}>
                          {line}
                        </p>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={retryAnswer}
                    disabled={isStreaming}
                    className="flex-none px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-30 text-[10px] font-mono text-white/80 transition-colors"
                  >
                    Retry
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="p-3 rounded-xl pointer-events-auto flex-shrink-0"
                  style={{
                    background: "rgba(255, 60, 60, 0.1)",
                    border: "1px solid rgba(255, 60, 60, 0.15)",
                  }}
                >
                  <p className="text-[11px] text-red-300/80 font-mono">
                    {error}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Agent declined to answer (no clear question detected) */}
            <AnimatePresence>
              {agentNotice && !isStreaming && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="px-3 py-2 rounded-xl pointer-events-auto flex-shrink-0 flex items-baseline gap-2"
                  style={{
                    background: "rgba(255, 190, 60, 0.08)",
                    border: "1px solid rgba(255, 190, 60, 0.18)",
                  }}
                >
                  <span className="text-[10px] tracking-wider text-amber-200/80 font-mono">
                    WAIT
                  </span>
                  <span className="text-[10px] text-white/45 font-mono">
                    · {agentNotice}
                  </span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Screenshots strip */}
            {screenshots.length > 0 &&
              !currentSolution &&
              !isStreaming &&
              sessionMessages.length === 0 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="pointer-events-auto rounded-xl p-3 flex-shrink-0"
                  style={{
                    cursor: "default",
                    background: "rgba(20, 20, 23, 0.90)",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}
                  onMouseEnter={() => window.ghostly.enableMouse()}
                  onMouseLeave={() => window.ghostly.disableMouse()}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] text-white/40 font-mono">
                      📸 {screenshots.length} screenshot
                      {screenshots.length > 1 ? "s" : ""} captured
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-white/25 font-mono">
                        Press{" "}
                        <kbd className="bg-black/40 border border-white/[0.12] rounded px-1 py-0.5 text-[9px] text-white/50">
                          Ctrl
                        </kbd>{" "}
                        <kbd className="bg-black/40 border border-white/[0.12] rounded px-1 py-0.5 text-[9px] text-white/50">
                          ↵
                        </kbd>{" "}
                        to solve
                      </span>
                      <button
                        onClick={() => clearSolution()}
                        className="text-[10px] text-white/30 hover:text-white/60 transition-colors"
                      >
                        Clear all
                      </button>
                    </div>
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {screenshots.map((shot, i) => (
                      <div key={i} className="relative group flex-shrink-0">
                        <img
                          src={shot}
                          alt={`Screenshot ${i + 1}`}
                          className="h-[80px] w-auto rounded-lg border border-white/[0.06] object-cover"
                        />
                        <button
                          onClick={() => removeScreenshot(i)}
                          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500/80 text-white text-[8px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          ✕
                        </button>
                        <span className="absolute bottom-1 left-1 text-[8px] text-white/40 bg-black/50 rounded px-1">
                          #{i + 1}
                        </span>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

            {/* Chat Container */}
            {(sessionMessages.length > 0 || isStreaming) && (
              <div
                className="pointer-events-auto rounded-2xl overflow-hidden flex flex-col flex-1"
                style={{
                  cursor: "default",
                  background: "rgba(20, 20, 23, 0.65)",
                  backdropFilter: "blur(24px)",
                  WebkitBackdropFilter: "blur(24px)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
                onMouseEnter={() => window.ghostly.enableMouse()}
                onMouseLeave={() => window.ghostly.disableMouse()}
              >
                {/* Scrollable messages area */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {sessionMessages.map((msg, idx) => (
                    <div
                      key={msg.id}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      {msg.role === "user" ? (
                        <div className="max-w-[80%] bg-white/[0.08] border border-white/[0.1] rounded-2xl rounded-tr-sm px-4 py-2 text-xs text-white/80 whitespace-pre-wrap shadow-md">
                          {msg.screenshotBase64 && (
                            <img
                              src={msg.screenshotBase64}
                              alt="attached context"
                              className="max-h-24 rounded mb-2 border border-white/10"
                            />
                          )}
                          {msg.content.includes(
                            "Here is a live interview transcript",
                          )
                            ? "🎙️ Live Transcript Submitted"
                            : msg.content}
                        </div>
                      ) : (
                        <div className="w-full">
                          <SolutionCard
                            content={msg.content}
                            isStreaming={false}
                          />
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Completed answer is rendered from `sessionMessages` above. While a run is
                      in flight there is deliberately NO streaming card: the
                      answer is shown only once it is complete, so a losing
                      provider can never overwrite a displayed answer. The
                      "ANSWERING…" state lives in the detected-question banner. */}
                  {isStreaming && (
                    <div className="w-full">
                      <SolutionCard content="" isStreaming />
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Follow-up input */}
                <div className="p-3 bg-black/20 border-t border-white/[0.05]">
                  <form onSubmit={handleFollowUpSubmit} className="relative">
                    <input
                      type="text"
                      value={followUpText}
                      onChange={(e) => setFollowUpText(e.target.value)}
                      placeholder="Ask a follow-up question..."
                      disabled={isStreaming}
                      className="w-full bg-black/40 border border-white/[0.1] rounded-xl pl-4 pr-10 py-2.5 text-xs text-white/90 placeholder:text-white/30 focus:outline-none focus:border-white/20 transition-colors disabled:opacity-50"
                    />
                    <button
                      type="submit"
                      disabled={isStreaming || !followUpText.trim()}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-all"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="22" y1="2" x2="11" y2="13"></line>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                      </svg>
                    </button>
                  </form>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
