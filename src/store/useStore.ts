import { create } from "zustand";
import type { ProviderName } from "../lib/ai";
import type { InterviewTurn } from "../lib/interviewAgent";
import type { DeepgramTelemetry } from "../lib/deepgramProtocol";
import type { GroqAsrTelemetry } from "../lib/groqWhisper";
import { DEFAULT_PRIMARY_ASR, type PrimaryAsr } from "../lib/primaryAsr";

/**
 * Transcription engines. `moonshine` is local and default; `deepgram` is the
 * optional cloud engine used only for A/B comparison.
 */
export type AsrEngine = "moonshine" | "deepgram";

/**
 * Which engine produces the transcript that reaches the question gate and the
 * AI. See `lib/primaryAsr.ts` for why this is a real setting and why the code
 * default is Moonshine.
 */
export type { PrimaryAsr } from "../lib/primaryAsr";

export interface Solution {
  id: string;
  timestamp: number;
  screenshotBase64?: string;
  solution: string;
  provider: ProviderName;
  model: string;
  interviewType: string;
  language: string;
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  screenshotBase64?: string;
}

/** One applied ASR repair, kept for debugging / evaluation. */
export interface TranscriptCorrectionDetail {
  from: string;
  to: string;
  confidence: number;
  reason: string;
}

/** Raw-vs-corrected bookkeeping for a committed transcript. */
export interface TranscriptCorrection {
  applied: boolean;
  confidence: number;
  details: TranscriptCorrectionDetail[];
  reason: string;
}

export interface TranscriptMessage {
  id: string;
  source: "mic" | "system";
  /**
   * The transcript the pipeline uses (corrected). The raw ASR text is never
   * overwritten — it is preserved in `rawText` for debugging and evaluation.
   */
  text: string;
  timestamp: number;
  audioUrl?: string;
  /** Verbatim ASR output before any repair. Equal to `text` when unchanged. */
  rawText?: string;
  /** What the correction engine changed, if anything. */
  correction?: TranscriptCorrection;
}

/**
 * What the question-detection gate locked onto for the turn currently being
 * answered (or about to be). Shown in the overlay so the user can verify it
 * before/while the answer streams.
 */
export interface DetectedQuestion {
  text: string;
  /** `auto` = fired by the auto-answer mode, `manual` = hotkey / Ask Copilot. */
  mode: "auto" | "manual";
  /** True when the gate said WAIT and the user insisted anyway. */
  forced?: boolean;
  /** Provider currently answering this question (updates on failover). */
  provider?: string;
  model?: string;
  /** Human-readable failover state, e.g. "Groq failed → switching to Gemini". */
  note?: string;
}

/**
 * One engine-vs-engine comparison for a single captured segment.
 *
 * Developer-only. Held in its own store slice, NOT in `interviewMessages`,
 * so a Deepgram transcript can never reach the question gate, the prompt or
 * the answer path by accident. Only the hotkey — and only the Moonshine-side
 * transcript — feeds the AI.
 */
export interface AsrComparison {
  id: string;
  /** Segment duration in seconds, identical for both engines by construction. */
  audioSeconds: number;
  moonshineText: string;
  deepgramText: string;
  /** Comparison telemetry from the Deepgram run. */
  deepgramTelemetry: DeepgramTelemetry | null;
  /** Moonshine decode latency in ms, for a like-for-like comparison. */
  moonshineMs: number | null;
  /** Raw Groq Whisper transcript for this segment (comparison only). */
  groqText?: string;
  /** Groq transcript after the SHARED correction engine (never Groq-specific). */
  groqCorrectedText?: string;
  /** Telemetry from the Groq Whisper run. */
  groqTelemetry?: GroqAsrTelemetry | null;
  /**
   * Raw Parakeet transcript for this segment (DEVELOPMENT COMPARISON ONLY).
   *
   * Never read by the question gate, the correction path, the prompt builder
   * or the AI. It lives in this developer-only slice and nowhere else.
   */
  parakeetText?: string;
  /** Parakeet decode latency in ms, for a like-for-like comparison. */
  parakeetMs?: number | null;
  /**
   * Why the Parakeet cell is what it is: a status while loading, or the
   * failure reason when there is no text (`timeout`, `model_missing`, ...).
   * A failed comparison must be visible as a failure, never silently blank.
   */
  parakeetStatus?: string;
  timestamp: number;
}

/** A run that produced nothing usable — surfaced with a Retry action. */
export interface AnswerIssue {
  /** `empty` = no provider returned text, `partial` = text was kept after a failure. */
  kind: "empty" | "partial";
  message: string;
}

export interface Settings {
  activeProvider: ProviderName;
  /**
   * One model per provider. Deliberately NOT a single shared `activeModel`:
   * with provider failover, a Groq model id must never be written into the
   * Gemini slot (or vice versa).
   */
  models: Record<ProviderName, string>;
  /**
   * Providers live interview answers try, in order (first with a key wins).
   * Groq → Gemini by default; the selection is filtered to providers that
   * actually have an API key.
   */
  providerOrder: ProviderName[];
  interviewType:
    | "dsa"
    | "system_design"
    | "frontend"
    | "sql"
    | "behavioral"
    | "general";
  language: "python" | "javascript" | "typescript" | "java" | "cpp" | "go";
  apiKeys: Record<ProviderName, string>;
  customInstructions?: string;
  // Pre-interview context (set before "Start Interview" in the overlay)
  resumeText?: string;
  companyName?: string;
  jobDescription?: string;
  /** Shapes how the answer is rendered on screen (tone, length, format). */
  answerInstructions?: string;
  micDeviceId?: string;
  /** ASR model id. Now a Moonshine ONNX repo (was `Xenova/whisper-*`). */
  whisperModel?: string;
  /**
   * Which engine transcribes the interviewer.
   *
   * `moonshine` is the default and is fully local. `deepgram` is an optional
   * second opinion used for A/B comparison — it requires a key and a network
   * call, so it is never selected implicitly.
   */
  asrEngine: AsrEngine;
  /**
   * Developer-only: transcribe every captured segment with BOTH engines and
   * show the two results side by side. Deliberately not a UI-facing setting
   * in the shipped app — it costs a second paid API call per utterance.
   */
  asrCompareMode: boolean;
  /**
   * Deepgram API key for the optional cloud ASR engine.
   *
   * Deliberately NOT part of `apiKeys`: that map is `Record<ProviderName,..>`
   * and is typed by the AI provider registry. Deepgram transcribes audio and
   * never answers anything, so making it look like an AI provider would invite
   * it into the answer failover chain.
   *
   * Persisted to electron-store and read ONLY in the main process.
   */
  deepgramKey?: string;
  /**
   * Developer-only: additionally transcribe every segment with Groq Whisper
   * (`whisper-large-v3`) for the three-way comparison. Defaults off and is off
   * in production builds. The API key is NOT part of this object — it lives in
   * the main process only (see electron/groqAsr.ts).
   */
  asrCompareGroq?: boolean;
  /** Configurable Whisper model id. Defaults to `whisper-large-v3`. */
  groqAsrModel?: string;
  /**
   * Developer-only: additionally transcribe every segment with local NVIDIA
   * Parakeet (sherpa-onnx, CPU) for a fourth comparison column.
   *
   * Defaults OFF, and the main process additionally refuses it in a packaged
   * build, so the ~631 MB model is never even resolved unless a developer asks
   * for it. Moonshine remains the production engine and there is no fallback
   * between them in either direction.
   */
  asrCompareParakeet?: boolean;
  /**
   * The engine whose transcript becomes `interviewMessages` — the one the
   * question gate, the prompt and the answer all read.
   *
   * `'moonshine'` (the default, and the value a settings blob written before
   * this phase resolves to) keeps the existing behaviour exactly. `'parakeet'`
   * routes local Parakeet through the SAME downstream pipeline — raw preserved,
   * `correctTranscript`, quality gate, question gate, AI — with no second code
   * path and no engine-specific correction.
   *
   * When Parakeet fails for a segment, the fallback is Moonshine and nothing
   * else. There is deliberately no path from here to Groq or Deepgram: audio
   * must not leave the machine without the user choosing to send it.
   */
  primaryAsr?: PrimaryAsr;
  /**
   * Developer-only: when Parakeet is primary, ALSO run Moonshine over the same
   * buffer and fill the Moonshine column of the comparison grid.
   *
   * Off by default, and off in production builds. Moonshine costs a ~22 s model
   * load, which is the entire reason Parakeet is primary in the first place, so
   * this is opt-in per session and never happens implicitly.
   */
  asrCompareMoonshine?: boolean;
  /**
   * Developer-only: override for {@link PARAKEET_PADDING_MS}, in ms. `0` disables
   * padding entirely, which is what the padded-vs-unpadded A/B on saved real
   * clips flips. Unset means the provisional 300 ms default.
   */
  parakeetPaddingMs?: number;
  /**
   * Optional model directory override, read by the main process when spawning
   * the utility process. Unset means the default location for the install.
   */
  parakeetModelDir?: string;
  /**
   * When on, the answering agent fires by itself as soon as the interviewer
   * finishes a clear question — no hotkey. Manual triggers keep working.
   */
  autoAnswer?: boolean;
}

interface GhostlyStore {
  // Session
  currentSolution: string;
  isStreaming: boolean;
  screenshots: string[]; // accumulated screenshots (multiple Ctrl+H)
  currentScreenshot: string | null; // latest screenshot (for backward compat)
  error: string | null;
  sessionMessages: SessionMessage[];
  interviewMessages: TranscriptMessage[];
  /** In-progress utterance shown live while Moonshine is still transcribing it. */
  interviewInterim: { source: "mic" | "system"; text: string } | null;

  /** Side-by-side engine comparison, newest first. Developer-only. */
  asrComparisons: AsrComparison[];
  /**
   * Set when the answering agent declined to answer (no clear question yet).
   * Holds the human-readable reason; the UI renders it as `WAIT · <reason>`.
   */
  agentNotice: string | null;
  /** The question the agent is answering right now (null when idle). */
  detectedQuestion: DetectedQuestion | null;
  /** Set when an answer could not be produced (empty) or was cut short. */
  answerIssue: AnswerIssue | null;
  /**
   * Which backend OpenRouter actually routed the last answer to (e.g. "groq",
   * "google"). Runtime-only, deliberately NOT part of `settings`: it changes
   * on every answer and must not trigger settings persistence or recreate the
   * `runAIStream` callback (which `settings` is a dependency of).
   */
  openRouterBackendProvider: string | null;

  // History
  history: Solution[];

  // Settings
  settings: Settings;

  // Mouse state
  mouseEnabled: boolean;

  // Actions — session
  setCurrentSolution: (text: string) => void;
  appendToSolution: (chunk: string) => void;
  setIsStreaming: (v: boolean) => void;
  setCurrentScreenshot: (b64: string | null) => void;
  addScreenshot: (b64: string) => void;
  clearScreenshots: () => void;
  removeScreenshot: (index: number) => void;
  setError: (err: string | null) => void;
  clearSolution: () => void;
  setMouseEnabled: (v: boolean) => void;
  addSessionMessage: (msg: SessionMessage) => void;

  // Actions — live interview transcript (shared between overlay + interview panel)
  addInterviewMessage: (msg: TranscriptMessage) => void;
  clearInterviewMessages: () => void;
  /** Record one engine-vs-engine comparison. Developer-only diagnostics. */
  addAsrComparison: (comparison: AsrComparison) => void;
  /** Drop all comparison records. */
  clearAsrComparisons: () => void;
  setInterviewInterim: (
    value: { source: "mic" | "system"; text: string } | null,
  ) => void;
  /**
   * The current interview turn: committed (finalized) utterances plus the
   * in-progress one. This is the single source the answering agent reads, so
   * partial transcripts can never be mistaken for a finished question.
   */
  getInterviewTurn: () => InterviewTurn;
  setAgentNotice: (reason: string | null) => void;
  setDetectedQuestion: (value: DetectedQuestion | null) => void;
  setAnswerIssue: (value: AnswerIssue | null) => void;
  /** Records which backend OpenRouter actually routed the last answer to. */
  setOpenRouterBackendProvider: (value: string | null) => void;

  // Actions — history
  addToHistory: (s: Solution) => void;
  removeFromHistory: (id: string) => void;
  clearHistory: () => void;
  setHistory: (history: Solution[]) => void;

  // Actions — settings
  updateSettings: (partial: Partial<Settings>) => void;
  setApiKey: (provider: ProviderName, key: string) => void;
  setSettings: (settings: Settings) => void;
}

export const useStore = create<GhostlyStore>((set, get) => ({
  // State
  currentSolution: "",
  isStreaming: false,
  screenshots: [],
  currentScreenshot: null,
  error: null,
  sessionMessages: [],
  interviewMessages: [],
  interviewInterim: null,
  asrComparisons: [],
  agentNotice: null,
  detectedQuestion: null,
  answerIssue: null,
  openRouterBackendProvider: null,
  history: [],
  mouseEnabled: false,
  settings: {
    // OpenRouter is the single gateway for every AI call (interview answers,
    // screenshots and follow-ups all route through it).
    activeProvider: "openrouter",
    models: {
      gemini: "gemini-2.5-flash",
      openai: "gpt-4o",
      anthropic: "claude-3-5-sonnet-20241022",
      groq: "openai/gpt-oss-120b",
      // The free ROUTER, not a fixed model: OpenRouter resolves it to a
      // concrete available free model per request, so a single unavailable
      // model can no longer take the interview path down.
      openrouter: "openrouter/free",
      nvidia: "meta/llama-3.3-70b-instruct",
    },
    // The full interview chain. All four are always represented so the
    // architecture stays visible and configurable; which ones actually run is
    // decided per run by whether they have an API key.
    providerOrder: ["openrouter", "groq", "nvidia", "gemini"],
    interviewType: "dsa",
    language: "python",
    apiKeys: {
      gemini: "",
      openai: "",
      anthropic: "",
      groq: "",
      openrouter: "",
      nvidia: "",
    },
    customInstructions: "",
    resumeText: "",
    companyName: "",
    jobDescription: "",
    answerInstructions: "",
    micDeviceId: "default",
    whisperModel: "onnx-community/moonshine-base-ONNX",
    asrEngine: "moonshine",
    asrCompareMode: false,
    asrCompareGroq: false,
    // Dev-only, and OFF by default: the Parakeet model is ~631 MB and costs
    // several hundred MB of resident memory.
    asrCompareParakeet: false,
    // Moonshine stays the code default so a settings blob written before
    // Parakeet existed resolves to a working engine on upgrade. Selecting
    // Parakeet is a UI action, never a source edit.
    primaryAsr: DEFAULT_PRIMARY_ASR,
    asrCompareMoonshine: false,
    groqAsrModel: "whisper-large-v3",
    autoAnswer: false,
  },

  // Session actions
  setCurrentSolution: (text) => set({ currentSolution: text }),
  appendToSolution: (chunk) =>
    set((s) => ({ currentSolution: s.currentSolution + chunk })),
  setIsStreaming: (v) => set({ isStreaming: v }),
  setCurrentScreenshot: (b64) => set({ currentScreenshot: b64 }),
  addScreenshot: (b64) =>
    set((s) => ({
      screenshots: [...s.screenshots, b64],
      currentScreenshot: b64,
    })),
  clearScreenshots: () => set({ screenshots: [], currentScreenshot: null }),
  removeScreenshot: (index) =>
    set((s) => {
      const next = s.screenshots.filter((_, i) => i !== index);
      return {
        screenshots: next,
        currentScreenshot: next.length > 0 ? next[next.length - 1] : null,
      };
    }),
  setError: (err) => set({ error: err }),
  clearSolution: () =>
    set({
      currentSolution: "",
      screenshots: [],
      currentScreenshot: null,
      error: null,
      sessionMessages: [],
      interviewMessages: [],
      interviewInterim: null,
      agentNotice: null,
      detectedQuestion: null,
      answerIssue: null,
    }),
  setMouseEnabled: (v) => set({ mouseEnabled: v }),
  addSessionMessage: (msg) => 
    set((state) => ({ sessionMessages: [...state.sessionMessages, msg] })),
  addInterviewMessage: (msg) =>
    set((state) => ({ interviewMessages: [...state.interviewMessages, msg] })),
  clearInterviewMessages: () =>
    set({
      interviewMessages: [],
      interviewInterim: null,
      agentNotice: null,
      detectedQuestion: null,
      answerIssue: null,
    }),
  setInterviewInterim: (value) => set({ interviewInterim: value }),
  // Capped so a long session cannot grow this slice without bound. This is a
  // developer diagnostic, not a transcript log.
  // Upsert by id: a comparison row is created by one engine and completed by
  // the others (all keyed on the same phraseId), so writing the same id must
  // UPDATE the row rather than prepend a duplicate.
  addAsrComparison: (comparison) =>
    set((state) => {
      const index = state.asrComparisons.findIndex((c) => c.id === comparison.id);
      if (index >= 0) {
        const next = state.asrComparisons.slice();
        next[index] = comparison;
        return { asrComparisons: next };
      }
      return {
        asrComparisons: [comparison, ...state.asrComparisons].slice(0, 20),
      };
    }),
  clearAsrComparisons: () => set({ asrComparisons: [] }),
  setAgentNotice: (reason) => set({ agentNotice: reason }),
  setDetectedQuestion: (value) => set({ detectedQuestion: value }),
  setAnswerIssue: (value) => set({ answerIssue: value }),
  setOpenRouterBackendProvider: (
    v: string | null,
  ) => set({ openRouterBackendProvider: v }),
  getInterviewTurn: () => ({
    finals: get().interviewMessages.map((m) => ({
      source: m.source,
      text: m.text,
    })),
    interim: get().interviewInterim,
  }),


  // History actions
  addToHistory: (s) => set((state) => ({ history: [s, ...state.history] })),
  removeFromHistory: (id) =>
    set((state) => ({ history: state.history.filter((s) => s.id !== id) })),
  clearHistory: () => set({ history: [] }),
  setHistory: (history) => set({ history }),

  // Settings actions
  updateSettings: (partial) =>
    set((s) => ({ settings: { ...s.settings, ...partial } })),
  setApiKey: (provider, key) =>
    set((s) => ({
      settings: {
        ...s.settings,
        apiKeys: { ...s.settings.apiKeys, [provider]: key },
      },
    })),
  setSettings: (settings) => set({ settings }),
}));
