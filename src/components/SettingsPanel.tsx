import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { getProvider, type ProviderName } from "../lib/ai";
import { INTERVIEW_PROVIDER_ORDER } from "../lib/providerDiagnostics";
import {
  findShortcutConflicts,
  INTERVIEW_SHORTCUTS,
} from "../lib/interviewShortcuts";
import { normalizePrimaryAsr, type PrimaryAsr } from "../lib/primaryAsr";
import {
  MODEL_INTEGRITY_NOTE,
  canRetryDownload,
  cancelParakeetModelDownload,
  describeModelState,
  downloadParakeetModel,
  formatBytes,
  getParakeetModelStatus,
  isTransferInProgress,
  removeParakeetModel,
  type ParakeetModelState,
} from "../lib/parakeetModelClient";
import {
  PARAKEET_ARCHIVE_BYTES,
  PARAKEET_UNPACKED_BYTES,
} from "../lib/parakeetModelFacts";

/**
 * Interview types split into two top-level groups. The existing types are never
 * removed: everything that is not a DSA type lives under "General", and the
 * existing DSA mode lives under "DSA".
 */
export const INTERVIEW_TYPE_GROUPS: readonly {
  label: string;
  types: readonly { id: string; label: string }[];
}[] = [
  {
    label: "General",
    types: [
      { id: "general", label: "General" },
      { id: "system_design", label: "System Design" },
      { id: "frontend", label: "Frontend" },
      { id: "sql", label: "SQL" },
      { id: "behavioral", label: "Behavioral" },
    ],
  },
  {
    label: "DSA",
    types: [
      { id: "dsa", label: "DSA / Algorithms" },
    ],
  },
];

/** Flat, backwards-compatible list of every existing interview type. */
export const INTERVIEW_TYPES: readonly { id: string; label: string }[] = [
  ...INTERVIEW_TYPE_GROUPS.flatMap((g) => g.types),
];

const LANGUAGES = [
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "java", label: "Java" },
  { id: "cpp", label: "C++" },
  { id: "go", label: "Go" },
];

const PROVIDERS = [
  {
    id: "gemini" as ProviderName,
    label: "Google Gemini",
    docsUrl: "https://aistudio.google.com/app/apikey",
  },
  {
    id: "openai" as ProviderName,
    label: "OpenAI",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic" as ProviderName,
    label: "Anthropic",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "groq" as ProviderName,
    label: "Groq",
    docsUrl: "https://console.groq.com/keys",
  },
  {
    id: "openrouter" as ProviderName,
    label: "OpenRouter (primary gateway)",
    docsUrl: "https://openrouter.ai/keys",
  },
  {
    id: "nvidia" as ProviderName,
    label: "NVIDIA (direct NIM)",
    docsUrl: "https://build.nvidia.com",
  },
];

/**
 * The OpenRouter free router.
 *
 * `openrouter/free` is NOT a model — OpenRouter resolves it to a concrete
 * available free model on every request. It is presented separately so it is
 * never mistaken for a fixed, selectable model.
 */
const OPENROUTER_FREE_OPTION = {
  value: "openrouter/free",
  label: "OpenRouter Free (auto-selects a free model)",
};

// Moonshine ONNX repos (transformers.js v3). Moonshine is purpose-built for
// real-time / on-device ASR — much faster than Whisper at the short chunks a
// live interview produces, and it is what powers the live interim transcript.
/** Shared styling for the dev-only screen-visibility segmented control. */
const VIS_ACTIVE =
  "px-4 py-1.5 text-[10px] font-mono transition-colors bg-white/20 text-white";
const VIS_INACTIVE =
  "px-4 py-1.5 text-[10px] font-mono transition-colors bg-transparent text-white/40 hover:bg-white/[0.06]";

const ASR_MODELS = [
  {
    id: "onnx-community/moonshine-tiny-ONNX",
    label: "Moonshine Tiny (fastest)",
  },
  {
    id: "onnx-community/moonshine-base-ONNX",
    label: "Moonshine Base (balanced)",
  },
];

const SHORTCUTS = [
  { label: "Start / Stop Interview", keys: ["Ctrl", "I"] },
  { label: "Next Question", keys: ["Ctrl", "N"] },
  { label: "Ask AI", keys: ["Ctrl", "↵"] },
  { label: "Start Over", keys: ["Ctrl", "G"] },
  { label: "Screenshot", keys: ["Ctrl", "H"] },
  { label: "Show / Hide", keys: ["Ctrl", "B"] },
  { label: "Move Up", keys: ["Ctrl", "↑"] },
  { label: "Move Left", keys: ["Ctrl", "←"] },
  { label: "Move Down", keys: ["Ctrl", "↓"] },
  { label: "Move Right", keys: ["Ctrl", "→"] },
];

/** Any two global actions sharing a key. Empty in a healthy build. */
const SHORTCUT_CONFLICTS = findShortcutConflicts(INTERVIEW_SHORTCUTS);

interface SettingsPanelProps {
  onClose: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ onClose }) => {
  const { settings, updateSettings, setApiKey } = useStore();
  const [showKey, setShowKey] = useState(false);

  // Models for the active provider. Starts from the curated fallback list and
  // is upgraded to the provider's live list as soon as we have an API key.
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const activeProviderName = settings.activeProvider;
  const apiKeyForProvider = settings.apiKeys[activeProviderName] ?? "";
  // Per-provider model — never a shared one, so failover can't cross models.
  const activeModelForProvider = settings.models?.[activeProviderName] ?? "";
  const setModelForProvider = (model: string) =>
    updateSettings({
      models: { ...settings.models, [activeProviderName]: model },
    });
  const failoverChain = (settings.providerOrder ?? [])
    .filter((p) => (settings.apiKeys[p] ?? "").trim())
    .map((p) => PROVIDERS.find((x) => x.id === p)?.label ?? p);

  // ── Interview answer chain (ordered, independently toggleable) ──────────
  // OpenRouter is the primary gateway; Groq / NVIDIA / Gemini are independent
  // secondaries that Ghostly calls directly. Toggle a provider off to drop it
  // from the chain; drag order is not needed because OpenRouter is always
  // first when it is enabled.
  const chainOrder = settings.providerOrder ?? [];
  const isInChain = (p: ProviderName) => chainOrder.includes(p);
  const hasKey = (p: ProviderName) => Boolean((settings.apiKeys[p] ?? "").trim());
  const toggleInChain = (p: ProviderName) => {
    const without = chainOrder.filter((x) => x !== p);
    const withIt = isInChain(p)
      ? without
      : p === "openrouter"
        ? [p, ...without]
        : [...without, p];
    updateSettings({ providerOrder: withIt });
  };

  // Microphone selection state
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micDropdownOpen, setMicDropdownOpen] = useState(false);
  // ── Dev-only screen visibility ──────────────────────────────────────
  // Runtime-only: deliberately NOT in the settings store, so nothing is
  // persisted and a restart always returns to `hidden`.
  const [visibility, setVisibility] = useState<"visible" | "hidden">("hidden");

  const applyVisibility = async (mode: "visible" | "hidden") => {
    const res = await window.ghostly.setVisibility(mode);
    // Adopt the mode the MAIN process says took effect, not the one we asked
    // for — a packaged build refuses, and the UI must not lie about it.
    setVisibility(res.mode);
  };

  // ── Groq Whisper ASR key (dev-only comparison) ──────────────────────
  // The key is NEVER held in the settings store. It is typed into a local
  // draft, sent straight to the main process, and only a boolean comes back.
  const [groqKeyDraft, setGroqKeyDraft] = useState("");
  const [groqKeyConfigured, setGroqKeyConfigured] = useState(false);
  const [groqKeySaving, setGroqKeySaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.ghostly.groqAsrHasKey().then((v) => {
      if (alive) setGroqKeyConfigured(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const saveGroqKey = async () => {
    if (!groqKeyDraft.trim()) return;
    setGroqKeySaving(true);
    try {
      const res = await window.ghostly.groqSetKey(groqKeyDraft);
      setGroqKeyConfigured(res.configured);
      setGroqKeyDraft("");
    } finally {
      setGroqKeySaving(false);
    }
  };

  const clearGroqKey = async () => {
    setGroqKeySaving(true);
    try {
      const res = await window.ghostly.groqSetKey("");
      setGroqKeyConfigured(res.configured);
    } finally {
      setGroqKeySaving(false);
    }
  };

  const micDropdownRef = useRef<HTMLDivElement>(null);

  // ── Primary ASR engine ──────────────────────────────────────────────────
  // Read through the store's own normaliser rather than casting, so a
  // hand-edited settings file with a nonsense value cannot reach a branch that
  // expects two engines.
  const primaryAsr = normalizePrimaryAsr(useStore((s) => s.settings.primaryAsr));
  /** One-line confirmation of the last engine change, shown under the picker. */
  const [engineNote, setEngineNote] = useState<string | null>(null);

  // ── Model download state ────────────────────────────────────────────────
  // Polled while the picker is on Parakeet. A poll is cheap — the main process
  // stats four files — and polling is what makes the progress bar move, because
  // the download call itself does not resolve until the transfer finishes.
  const [modelState, setModelState] = useState<ParakeetModelState>(() => ({
    status: "missing",
    progress: null,
    bytesDownloaded: 0,
    bytesTotal: PARAKEET_ARCHIVE_BYTES,
    message: null,
    dir: "",
  }));
  const [modelBusy, setModelBusy] = useState(false);
  /** Set once a download has been started, so polling does not spam the log. */
  const modelStartedRef = useRef(false);

  useEffect(() => {
    if (primaryAsr !== "parakeet") return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      const next = await getParakeetModelStatus();
      if (cancelled) return;
      setModelState(next);
      // While a transfer is running, poll fast enough to animate the bar. Once
      // it settles, back off to a slow heartbeat so an idle Settings page is
      // not stat-ing files four times a second forever.
      timer = window.setTimeout(
        () => void poll(),
        isTransferInProgress(next) ? 400 : 4000,
      );
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [primaryAsr]);

  const startDownload = useCallback(async () => {
    if (modelBusy) return;
    setModelBusy(true);
    if (!modelStartedRef.current) {
      modelStartedRef.current = true;
      setEngineNote(
        "Downloading the speech model. It is stored in this app's data folder, never bundled with the installer, and can be deleted at any time.",
      );
    }
    try {
      // The poll above renders progress; this call only reports the OUTCOME, so
      // its result is deliberately not used to drive the bar.
      const finalState = await downloadParakeetModel();
      setModelState(finalState);
      if (finalState.status === "ready") {
        setEngineNote(
          "Speech model installed. It loads on Start Interview (~7 s).",
        );
      }
    } finally {
      setModelBusy(false);
    }
  }, [modelBusy]);

  const cancelDownload = useCallback(async () => {
    await cancelParakeetModelDownload();
    setModelState(await getParakeetModelStatus());
  }, []);

  const removeModel = useCallback(async () => {
    const next = await removeParakeetModel();
    setModelState(next);
    setEngineNote(
      "Speech model deleted. If Parakeet is selected it will fall back to Moonshine until it is downloaded again.",
    );
  }, []);

  /**
   * Change the primary engine AND persist it immediately.
   *
   * ── Why the explicit write-through, when auto-save already exists ─────────
   * The 500 ms debounced auto-save effect further down this file is the
   * mechanism that actually works, and this component is the only reason it does.
   *
   * The earlier Parakeet comparison toggle lived in a different component, had
   * no auto-save, updated zustand, and therefore never reached electron-store —
   * so the main process, which is the thing that actually decides, never saw it
   * and the feature could not be switched on at all. Writing through here makes
   * the ordering irrelevant: even if the debounce is still pending, or the panel
   * is closed, the main process already knows.
   */
  const selectPrimaryAsr = useCallback(
    (next: PrimaryAsr) => {
      const settings = useStore.getState().settings;
      updateSettings({ primaryAsr: next });
      void window.ghostly.saveSettings({ ...settings, primaryAsr: next });
      if (next === "parakeet") {
        setEngineNote(
          "Parakeet selected. It loads on Start Interview (~7 s, a few hundred MB). Moonshine stays unloaded unless a single segment needs it.",
        );
      } else {
        setEngineNote(
          "Moonshine selected. It loads on Start Interview and streams words as the interviewer speaks.",
        );
      }
    },
    [],
  );

  // Fetch microphones
  useEffect(() => {
    const getMics = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMics(devices.filter((d) => d.kind === "audioinput"));
        stream.getTracks().forEach((track) => track.stop());
      } catch (err) {
        console.error("Microphone access denied or error:", err);
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMics(devices.filter((d) => d.kind === "audioinput"));
      }
    };
    getMics();
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        micDropdownRef.current &&
        !micDropdownRef.current.contains(event.target as Node)
      ) {
        setMicDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Enable mouse for the ENTIRE time the settings panel is open
  // This is the authoritative mouse state controller while visible
  useEffect(() => {
    // Force enable — overrides any other disable calls
    window.ghostly.enableMouse();

    // Re-enable periodically to combat any race conditions
    const interval = setInterval(() => {
      window.ghostly.enableMouse();
    }, 200);

    return () => {
      clearInterval(interval);
      window.ghostly.disableMouse();
    };
  }, []);

  // Auto-save settings
  useEffect(() => {
    const timer = setTimeout(() => {
      window.ghostly.saveSettings(settings);
    }, 500);
    return () => clearTimeout(timer);
  }, [settings]);

  // Resolve the model list whenever the provider or its key changes.
  useEffect(() => {
    let cancelled = false;
    const provider = getProvider(activeProviderName);
    const fallback = provider ? provider.listModels() : [];
    setAvailableModels(fallback);

    if (
      !provider ||
      typeof provider.fetchModels !== "function" ||
      !apiKeyForProvider.trim()
    ) {
      return;
    }

    setModelsLoading(true);
    provider
      .fetchModels(apiKeyForProvider)
      .then((models) => {
        if (cancelled || models.length === 0) return;
        setAvailableModels(models);
        // Auto-heal a stale selection (e.g. a model the provider retired) — for
        // THIS provider only.
        const current = useStore.getState().settings.models?.[activeProviderName];
        if (!current || !models.includes(current)) {
          updateSettings({
            models: { ...useStore.getState().settings.models, [activeProviderName]: models[0] },
          });
        }
      })
      .catch((err) => {
        // Live discovery is best-effort; the fallback list stays in place.
        console.warn(
          `[Ghostly] Could not fetch live models for ${activeProviderName}:`,
          err,
        );
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // The stored model is intentionally omitted from the deps: including it
    // would refetch on every auto-heal. The heal above reads it at fetch time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProviderName, apiKeyForProvider, updateSettings]);

  const handleProviderChange = (id: ProviderName) => {
    const provider = getProvider(id);
    const models = provider ? provider.listModels() : [];
    // Only ever fills in this provider's own slot.
    updateSettings({
      activeProvider: id,
      models: {
        ...settings.models,
        [id]: settings.models?.[id] || models[0] || "",
      },
    });
  };

  const activeModels = availableModels;
  const isOpenRouterActive = settings.activeProvider === "openrouter";
  const isOpenRouterFree = isOpenRouterActive && activeModelForProvider === OPENROUTER_FREE_OPTION.value;

  // Live discovery returns the whole catalog; for free mode that list would be
  // misleading because we never pick from it ourselves — OpenRouter does.
  const modelOptions = isOpenRouterActive
    ? [
        OPENROUTER_FREE_OPTION.value,
        ...availableModels.filter((m) => m !== OPENROUTER_FREE_OPTION.value),
      ]
    : availableModels;

  return (
    <div
      className="fixed inset-0 flex justify-center pt-16 z-50"
      onClick={(e) => {
        // Close if clicking the backdrop (outside the panel)
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ pointerEvents: "auto" }}
    >
      <div
        className="
          bg-[rgba(25,25,28,0.97)]
          backdrop-blur-2xl
          border border-white/[0.08]
          rounded-2xl
          w-[380px]
          max-h-[75vh]
          overflow-y-auto
          p-5
          text-xs font-mono text-white/80
          shadow-2xl shadow-black/60
        "
        onClick={(e) => e.stopPropagation()}
        style={{ pointerEvents: "auto", WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <span className="text-sm font-semibold text-white/90">Settings</span>
          <button
            onClick={onClose}
            className="text-white/30 hover:text-white/70 text-sm transition-colors"
          >
            ✕
          </button>
        </div>

        {/* AI Provider */}
        <Section label="AI Provider">
          <select
            value={settings.activeProvider}
            onChange={(e) =>
              handleProviderChange(e.target.value as ProviderName)
            }
            className="settings-select"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Section>

        {/* API Key */}
        <Section label="API Key">
          <div className="flex gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={settings.apiKeys[settings.activeProvider]}
              onChange={(e) =>
                setApiKey(settings.activeProvider, e.target.value)
              }
              placeholder={`Enter ${settings.activeProvider} API key`}
              className="settings-input flex-1"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="text-white/40 hover:text-white/70 text-[10px] px-2 transition-colors"
            >
              {showKey ? "🙈" : "👁"}
            </button>
          </div>
          <a
            href={
              PROVIDERS.find((p) => p.id === settings.activeProvider)?.docsUrl
            }
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-accent/60 hover:text-accent/90 mt-1 inline-block transition-colors"
          >
            Get API key →
          </a>
        </Section>

        {/* Model */}
        <Section label="Model">
          <select
            value={activeModelForProvider}
            onChange={(e) => setModelForProvider(e.target.value)}
            className="settings-select"
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m === OPENROUTER_FREE_OPTION.value ? OPENROUTER_FREE_OPTION.label : m}
              </option>
            ))}
          </select>
          <p className="text-[9px] text-white/30 mt-1">
            {isOpenRouterFree
              ? "OpenRouter Free is a ROUTER, not a model — OpenRouter picks whichever free model is available for each request. The live model and backend are shown in the overlay and in the log."
              : modelsLoading
                ? "Checking available models…"
                : apiKeyForProvider.trim()
                  ? "Models available to your API key."
                  : "Add an API key to load models available to your account."}
          </p>
          <p className="text-[9px] text-white/25 mt-1">
            Saved per provider — changing provider keeps its own model.
          </p>
          <p className="text-[9px] text-white/25 mt-1">
            Live interview answers try:{" "}
            {failoverChain.length > 0
              ? failoverChain.join(" → ")
              : "add an API key for OpenRouter"}
            . An error, timeout or empty reply falls back to the next one — but
            never once answer text is already on screen.
          </p>
        </Section>

        {/* Interview Answer Chain — which providers are eligible, in order */}
        <Section label="Interview Answer Chain">
          <div className="flex flex-col gap-1">
            {INTERVIEW_PROVIDER_ORDER.map((p) => {
              const on = isInChain(p);
              const keyed = hasKey(p);
              const isPrimary = p === "openrouter";
              return (
                <button
                  key={p}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() => toggleInChain(p)}
                  className="w-full flex items-center justify-between gap-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[10px] font-mono text-white/75 outline-none cursor-pointer transition-colors"
                >
                  <span className="flex items-center gap-1.5 truncate text-left">
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-none ${
                        on && keyed
                          ? "bg-emerald-400"
                          : on
                            ? "bg-amber-400"
                            : "bg-white/20"
                      }`}
                    />
                    <span className="truncate">
                      {PROVIDERS.find((x) => x.id === p)?.label ?? p}
                    </span>
                    {isPrimary && (
                      <span className="text-[8px] text-accent/70 flex-none">
                        primary
                      </span>
                    )}
                  </span>
                  <span className="flex-none text-[9px] text-white/35">
                    {!keyed
                      ? "no key · skipped"
                      : on
                        ? "ready"
                        : "off · skipped"}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[9px] text-white/30 mt-1">
            Tried top to bottom. A provider is skipped when it has no API key or is
            switched off here — the startup log prints the reason for each one.
          </p>
        </Section>

        {/* Interview Type — top-level General / DSA groups (existing types unchanged). */}
        <Section label="Interview Type">
          <select
            value={settings.interviewType}
            onChange={(e) =>
              updateSettings({ interviewType: e.target.value as any })
            }
            className="settings-select"
          >
            {INTERVIEW_TYPE_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Section>

        {/* Live Answering */}
        <Section label="Live Answering">
          <button
            type="button"
            role="switch"
            aria-checked={!!settings.autoAnswer}
            onClick={() => updateSettings({ autoAnswer: !settings.autoAnswer })}
            className="w-full flex items-center justify-between gap-3 bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] rounded-lg px-3 py-2.5 text-[11px] font-mono text-white/80 outline-none cursor-pointer transition-colors"
          >
            <span className="truncate text-left">
              Auto-answer when a question ends
            </span>
            <span
              className={`flex-none w-8 h-4 rounded-full p-0.5 transition-colors ${
                settings.autoAnswer ? "bg-accent/70" : "bg-white/[0.12]"
              }`}
            >
              <span
                className={`block w-3 h-3 rounded-full bg-white transition-transform ${
                  settings.autoAnswer ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </span>
          </button>
          <p className="text-[9px] text-white/30 mt-1">
            Answers fire on their own the moment the interviewer stops talking on
            a clear question. Incomplete or conversational speech is still
            ignored (WAIT). Ctrl+Enter / Ask Copilot keep working either way.
          </p>
        </Section>

        {/* Code Language */}
        <Section label="Code Language">
          <select
            value={settings.language}
            onChange={(e) =>
              updateSettings({ language: e.target.value as any })
            }
            className="settings-select"
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </Section>

        {/* ── Speech recognition engine (primary) ─────────────────────────── */}
        {/*
         * The one switch that decides which engine's transcript reaches the
         * question gate and the AI. It lives HERE, inside SettingsPanel, rather
         * than in a debug panel for a specific reason: the auto-save effect at
         * the bottom of this file mirrors `settings` to electron-store, which is
         * the ONLY store the main process reads. A control anywhere else updates
         * zustand and the main process never learns about it — which is exactly
         * the bug that made the Parakeet comparison toggle appear dead.
         */}
        <Section label="Speech Recognition">
          <div className="inline-flex rounded-lg overflow-hidden border border-white/[0.12]">
            <button
              type="button"
              onClick={() => selectPrimaryAsr("moonshine")}
              aria-pressed={primaryAsr === "moonshine"}
              className={primaryAsr === "moonshine" ? VIS_ACTIVE : VIS_INACTIVE}
            >
              Moonshine (local)
            </button>
            <button
              type="button"
              onClick={() => selectPrimaryAsr("parakeet")}
              aria-pressed={primaryAsr === "parakeet"}
              className={primaryAsr === "parakeet" ? VIS_ACTIVE : VIS_INACTIVE}
            >
              Parakeet (local)
            </button>
          </div>
          <p className="text-[9px] text-white/30 mt-1">
            {primaryAsr === "parakeet" ? (
              <>
                Parakeet runs entirely on this machine and is more accurate than
                Moonshine on interview speech. It needs a one-time ~631 MB model
                download and about 700 MB of memory while an interview runs, and
                it takes ~7 s to start the first time. Moonshine is NOT loaded
                while Parakeet is healthy — it starts only if a single segment
                fails, and that fallback stays local too. Audio is never sent to
                a cloud service by either engine.
              </>
            ) : (
              <>
                Moonshine runs locally and shows words as the interviewer
                speaks. It needs no download beyond the model itself and is the
                default for new installs.
              </>
            )}
          </p>
          {engineNote && (
            <p className="text-[9px] text-white/35 mt-1">{engineNote}</p>
          )}
        </Section>

        {/* ── Parakeet model download ───────────────────────────────────── */}
        {/*
         * Shown whenever Parakeet is selected. The model is NEVER bundled: it
         * is ~631 MB unpacked, and shipping it would put half a gigabyte into
         * every installer for a feature that is off by default and make the
         * installer the thing that decides which engine you get.
         *
         * Every button here is retry-safe. "Retry" is hidden while a transfer
         * is running (a retry would just join the in-flight one and look inert),
         * and the main process joins a concurrent download rather than starting
         * a second 460 MB transfer.
         */}
        {primaryAsr === "parakeet" && (
          <Section label="Speech model (local)">
            <p className="text-[9px] text-white/40">
              {describeModelState(modelState)}
            </p>

            {isTransferInProgress(modelState) && (
              <div className="mt-1.5">
                <div className="h-1.5 rounded bg-white/[0.08] overflow-hidden">
                  <div
                    className="h-full bg-white/40 transition-all"
                    style={{ width: `${modelState.progress ?? 0}%` }}
                    role="progressbar"
                    aria-valuenow={modelState.progress ?? 0}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  />
                </div>
                <p className="text-[9px] text-white/30 mt-1">
                  {modelState.status === "verifying"
                    ? "Unpacking and checking files…"
                    : `${modelState.progress ?? 0}% · ${formatBytes(modelState.bytesDownloaded)} of ${formatBytes(modelState.bytesTotal)}`}
                </p>
              </div>
            )}

            {modelState.status === "error" && modelState.message && (
              <p className="text-[9px] text-red-300/80 mt-1.5">
                {modelState.message}
              </p>
            )}

            {modelState.status === "error" && (
              <p className="text-[9px] text-amber-200/70 mt-1.5">
                Moonshine will be used for every segment until this is fixed —
                still entirely on this machine.
              </p>
            )}

            <div className="flex flex-wrap gap-2 mt-2">
              {canRetryDownload(modelState) && (
                <button
                  type="button"
                  onClick={() => void startDownload()}
                  disabled={modelBusy}
                  className="px-2 py-1 rounded bg-white/[0.08] hover:bg-white/[0.14] text-white/70 text-[9px] disabled:opacity-40"
                >
                  {modelState.status === "error" ? "Retry download" : "Download the model"}
                </button>
              )}
              {isTransferInProgress(modelState) && (
                <button
                  type="button"
                  onClick={() => void cancelDownload()}
                  className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[9px]"
                >
                  Cancel
                </button>
              )}
              {modelState.status === "ready" && (
                <button
                  type="button"
                  onClick={() => void removeModel()}
                  className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/50 text-[9px]"
                >
                  Delete the {formatBytes(PARAKEET_UNPACKED_BYTES)} model
                </button>
              )}
              {/* ── The way out ───────────────────────────────────────────
                  Always present, and not only on failure: the clean recovery
                  from "this model will not install on my machine" must be
                  obvious without reading an error message first. Moonshine
                  needs no download and is already installed. */}
              <button
                type="button"
                onClick={() => selectPrimaryAsr("moonshine")}
                className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[9px]"
              >
                Switch back to Moonshine
              </button>
            </div>

            {modelState.status === "ready" && (
              <p className="text-[9px] text-white/25 mt-1.5">{MODEL_INTEGRITY_NOTE}</p>
            )}
            {modelState.dir && (
              <p className="text-[9px] text-white/20 mt-1 break-all">
                Installed in {modelState.dir}
              </p>
            )}
          </Section>
        )}

        {/* Transcription Model (Moonshine only) */}
        <Section label="Transcription Model">
          <select
            value={settings.whisperModel ?? "onnx-community/moonshine-base-ONNX"}
            onChange={(e) => updateSettings({ whisperModel: e.target.value })}
            className="settings-select"
            disabled={primaryAsr === "parakeet"}
          >
            {ASR_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <p className="text-[9px] text-white/30 mt-1">
            {primaryAsr === "parakeet"
              ? "Moonshine is not loaded while Parakeet is the primary engine. This still chooses which Moonshine model starts if it ever has to load as the fallback."
              : "Moonshine runs locally and streams text as the interviewer speaks. Switching reloads the engine (~first run downloads the model)."}
          </p>
        </Section>

        {/* ── Screen visibility (dev/test only) ────────────────────────── */}
        {/*
         * Lets Ghostly be screenshotted and screen-shared while testing.
         * Dev builds only, and runtime-only: it is not part of the persisted
         * settings, so a restart always comes back hidden. Both modes route
         * through the SAME Win32 `SetWindowDisplayAffinity` mechanism — there
         * is no second capture-exclusion path.
         */}
        {import.meta.env.DEV && (
          <Section label="Screen Visibility (dev only)">
            <div className="inline-flex rounded-lg overflow-hidden border border-white/[0.12]">
              <button
                type="button"
                onClick={() => void applyVisibility("visible")}
                aria-pressed={visibility === "visible"}
                className={visibility === "visible" ? VIS_ACTIVE : VIS_INACTIVE}
              >
                Visible
              </button>
              <button
                type="button"
                onClick={() => void applyVisibility("hidden")}
                aria-pressed={visibility === "hidden"}
                className={visibility === "hidden" ? VIS_ACTIVE : VIS_INACTIVE}
              >
                Hidden
              </button>
            </div>
            <p className="text-[9px] text-white/30 mt-1">
              Visible lets Ghostly appear in screen capture. Hidden (default)
              keeps it excluded. Resets on restart and never affects the
              interview, audio or AI.
            </p>
          </Section>
        )}

        {/* ── Second ASR engine (optional, Deepgram) ──────────────────── */}
        {/*
         * Deepgram is a COMPARISON engine, not a replacement. The default
         * engine (Moonshine, local) is untouched and fully functional without
         * any key. Everything here is developer-only and is hidden outside a
         * dev build.
         */}
        {import.meta.env.DEV && (
          <Section label="ASR Comparison (dev only)">
            <p className="text-[9px] text-white/30 mb-1">
              Moonshine (local) is the default and always runs. The engines
              below are COMPARISON-ONLY: the same captured audio is sent to
              each, and results are shown side by side. They never reach the
              AI, and failures never affect the interview.
            </p>

            <input
              type="password"
              value={settings.deepgramKey ?? ""}
              onChange={(e) => updateSettings({ deepgramKey: e.target.value })}
              placeholder="Deepgram API key (optional)"
              className="settings-input w-full"
              autoComplete="off"
            />
            <label className="flex items-center gap-2 mt-2 text-[10px] text-white/50 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.asrCompareMode ?? false}
                onChange={(e) =>
                  updateSettings({ asrCompareMode: e.target.checked })
                }
              />
              <span>Compare with Deepgram Nova-3</span>
            </label>
            <p className="text-[9px] text-white/30 mt-1">
              Sends the same captured audio to Deepgram Nova-3. Costs one API
              call per utterance. The key is stored on disk but is only ever
              read by the main process, which hands the renderer a 30-second
              token.
            </p>

            {/* ── Groq Whisper (comparison only) ─────────────────────── */}
            <div className="mt-3 pt-3 border-t border-white/[0.06]">
              <input
                type="password"
                value={groqKeyDraft}
                onChange={(e) => setGroqKeyDraft(e.target.value)}
                placeholder={
                  groqKeyConfigured
                    ? "Groq API key (configured — type to replace)"
                    : "Groq API key (optional)"
                }
                className="settings-input w-full"
                autoComplete="off"
              />
              <div className="flex items-center gap-2 mt-1.5">
                <button
                  type="button"
                  onClick={() => void saveGroqKey()}
                  disabled={!groqKeyDraft.trim() || groqKeySaving}
                  className="px-2 py-1 text-[10px] rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 text-white"
                >
                  Save key
                </button>
                {groqKeyConfigured && (
                  <button
                    type="button"
                    onClick={() => void clearGroqKey()}
                    disabled={groqKeySaving}
                    className="px-2 py-1 text-[10px] rounded bg-white/5 hover:bg-white/10 disabled:opacity-30 text-white/70"
                  >
                    Clear
                  </button>
                )}
                <span className="text-[9px] text-white/40">
                  {groqKeyConfigured ? "key configured" : "no key"}
                </span>
              </div>

              <label className="flex items-center gap-2 mt-2 text-[10px] text-white/50 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={settings.asrCompareGroq ?? false}
                  onChange={(e) =>
                    updateSettings({ asrCompareGroq: e.target.checked })
                  }
                />
                <span>Compare with Groq Whisper</span>
              </label>

              <input
                type="text"
                value={settings.groqAsrModel ?? "whisper-large-v3"}
                onChange={(e) =>
                  updateSettings({ groqAsrModel: e.target.value })
                }
                placeholder="whisper-large-v3"
                className="settings-input w-full mt-1.5"
                autoComplete="off"
              />
              <p className="text-[9px] text-white/30 mt-1">
                Sends the same captured audio to Groq Whisper
                (whisper-large-v3). The key is stored in the main process only
                and is never exposed to the app UI or bundled JavaScript.
              </p>
            </div>
          </Section>
        )}

        {/* Audio Input (Mic) */}
        <Section label="Audio Input (Mic)">
          <div
            className="relative"
            ref={micDropdownRef}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <button
              onClick={() => setMicDropdownOpen(!micDropdownOpen)}
              className="w-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] rounded-lg px-3 py-2.5 text-[11px] text-white/80 font-mono outline-none cursor-pointer transition-colors flex items-center justify-between gap-2"
            >
              <span className="truncate">
                {settings.micDeviceId === "default" || !settings.micDeviceId
                  ? "Default Microphone"
                  : mics.find((m) => m.deviceId === settings.micDeviceId)
                      ?.label || "Unknown Microphone"}
              </span>
              <span className="text-[8px] opacity-60">▼</span>
            </button>

            {micDropdownOpen && (
              <div
                className="absolute top-full mt-2 left-0 w-full bg-[rgba(30,30,30,0.95)] backdrop-blur-md border border-white/[0.12] rounded-xl shadow-xl overflow-hidden z-50 flex flex-col pointer-events-auto max-h-48 overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => {
                    updateSettings({ micDeviceId: "default" });
                    setMicDropdownOpen(false);
                  }}
                  className={`text-left px-3 py-2 text-[11px] font-mono transition-colors hover:bg-white/[0.08] truncate ${
                    settings.micDeviceId === "default" || !settings.micDeviceId
                      ? "bg-white/[0.04] text-white"
                      : "text-white/70"
                  }`}
                >
                  Default Microphone
                </button>
                {mics.map((t) => (
                  <button
                    key={t.deviceId}
                    onClick={() => {
                      updateSettings({ micDeviceId: t.deviceId });
                      setMicDropdownOpen(false);
                    }}
                    className={`text-left px-3 py-2 text-[11px] font-mono transition-colors hover:bg-white/[0.08] truncate ${
                      settings.micDeviceId === t.deviceId
                        ? "bg-white/[0.04] text-white"
                        : "text-white/70"
                    }`}
                  >
                    {t.label || `Microphone (${t.deviceId.slice(0, 5)}...)`}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Section>

        {/* Manage Prompts */}
        {/* <div className="mt-4 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          <div className="flex items-center justify-between">
            <span className="text-white/60">Manage Prompts</span>
            <span className="text-[9px] px-2 py-0.5 rounded-full bg-accent/15 text-accent/80 font-semibold">
              Open
            </span>
          </div>
        </div> */}

        {/* Shortcuts */}
        <div className="mt-5">
          <span className="text-[10px] text-white/40 uppercase tracking-wider">
            Keyboard Shortcuts
          </span>
          <div className="mt-2 space-y-1.5">
            {SHORTCUTS.map((s) => (
              <ShortcutRow key={s.label} label={s.label} keys={s.keys} />
            ))}
          </div>
          {/* Surfaced rather than silently overwritten: if two actions were
              ever assigned the same key, the user sees it here. */}
          {SHORTCUT_CONFLICTS.length > 0 && (
            <div className="mt-2 p-2 rounded-lg bg-red-500/10 border border-red-500/25">
              {SHORTCUT_CONFLICTS.map((c) => (
                <p key={c.accelerator} className="text-[10px] text-red-300/90 font-mono">
                  Shortcut conflict: {c.accelerator} is assigned to {c.ids.join(" and ")}.
                </p>
              ))}
            </div>
          )}
        </div>

        {/* Bottom buttons */}
        <div className="mt-5 pt-4 border-t border-white/[0.06] grid grid-cols-1 gap-2">
          <BottomButton label="Quit" onClick={() => window.close()} />
        </div>
      </div>
    </div>
  );
};

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <label className="text-[10px] text-white/40 uppercase tracking-wider mb-1.5 block">
        {label}
      </label>
      {children}
    </div>
  );
}

function ShortcutRow({ label, keys }: { label: string; keys: string[] }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-white/55">{label}</span>
      <div className="flex items-center gap-1">
        {keys.map((k, i) => (
          <kbd
            key={`${k}-${i}`}
            className="bg-black/40 border border-white/[0.12] rounded px-1.5 py-0.5 text-[10px] text-white/70 font-mono"
          >
            {k}
          </kbd>
        ))}
      </div>
    </div>
  );
}

function BottomButton({
  label,
  onClick,
}: {
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[11px] text-white/50 hover:text-white/70 transition-all"
    >
      {label}
    </button>
  );
}
