import React, { useEffect } from "react";
import { useStore } from "./store/useStore";
import type { ProviderName } from "./lib/ai";
import { PROVIDER_NAMES, isProviderName } from "./lib/ai";
import {
  isOpenRouterFreeModel,
  OPENROUTER_FREE_MODEL,
} from "./lib/ai/openrouter";
import {
  describeProviderChain,
  normalizeProviderOrder,
} from "./lib/providerDiagnostics";
import { Home } from "./pages/Home";
import "./styles/global.css";

const App: React.FC = () => {
  const { setSettings, setHistory } = useStore();

  // Load persisted settings & history on mount
  useEffect(() => {
    const loadData = async () => {
      if (!window.ghostly) {
        console.warn("[Ghostly] window.ghostly missing — skipping settings load (browser?)");
        return;
      }
      try {
        const [savedSettings, savedHistory] = await Promise.all([
          window.ghostly.getSettings(),
          window.ghostly.getHistory(),
        ]);
        if (savedSettings) {
          // Sanitize — ensure required fields exist and are valid
          const defaults = useStore.getState().settings;

          // The single shared `activeModel` is gone: with provider failover each
          // provider owns its model, so a Groq id can never be written into the
          // Gemini slot (or the reverse).
          const { activeModel: legacyModel, ...rest } = savedSettings as any;
          const activeProvider: ProviderName = isProviderName(
            rest.activeProvider,
          )
            ? rest.activeProvider
            : defaults.activeProvider;

          // Iterate the REGISTRY, not a hardcoded array. The previous literal
          // list omitted "openrouter", so a saved `models.openrouter` choice was
          // discarded on every launch and reset to the default.
          const savedModels = (rest.models ?? {}) as Record<string, unknown>;
          const models = { ...defaults.models };
          for (const p of PROVIDER_NAMES) {
            const saved = savedModels[p];
            models[p] =
              typeof saved === "string" && saved.trim()
                ? saved
                : defaults.models[p];
          }
          // Migrate whatever the old field held into the provider it belonged to.
          if (typeof legacyModel === "string" && legacyModel.trim()) {
            models[activeProvider] = legacyModel;
          }

          // ── Migration: move OpenRouter to the free router ───────────────
          // Earlier builds shipped `openai/gpt-oss-120b` as the OpenRouter
          // default, so a store written then pins us to one model that may be
          // unavailable or rate-limited. The free ROUTER removes that single
          // point of failure, but it is only a *default* — an explicit user
          // choice of any other model is preserved.
          if (
            typeof savedModels.openrouter === "string" &&
            savedModels.openrouter.trim() &&
            savedModels.openrouter !== defaults.models.openrouter &&
            savedModels.openrouter === "openai/gpt-oss-120b"
          ) {
            models.openrouter = OPENROUTER_FREE_MODEL;
            console.warn(
              `[Ghostly] settings migration — OpenRouter model "${savedModels.openrouter}" → "${OPENROUTER_FREE_MODEL}" (free router picks a model per request).`,
            );
          }

          const savedOrder = Array.isArray(rest.providerOrder)
            ? rest.providerOrder.filter(isProviderName)
            : [];

          // The ASR engine is now Moonshine (transformers.js v3), so a saved
          // `Xenova/whisper-*` id is no longer offered in Settings — migrate it.
          const asrModel =
            typeof rest.whisperModel === "string" &&
            rest.whisperModel.startsWith("onnx-community/")
              ? rest.whisperModel
              : defaults.whisperModel;

          const apiKeys = { ...defaults.apiKeys, ...rest.apiKeys };

          // ── Migration: full OpenRouter-led chain ──
          // A store written before the gateway migration can still carry a
          // legacy direct-provider order such as ["groq", "gemini"]. That order
          // is perfectly valid once reloaded, so it survived every previous
          // sanitisation and live answers kept going straight to Groq/Gemini
          // while the UI reported OpenRouter as configured.
          //
          // `normalizeProviderOrder` re-expresses the whole documented chain
          // (OpenRouter → Groq → NVIDIA → Gemini), putting OpenRouter first
          // whenever it has a key and adding every other provider that does.
          // Anything it changes is logged, never silent.
          const providerOrder = normalizeProviderOrder(
            savedOrder.length > 0 ? savedOrder : defaults.providerOrder,
            apiKeys,
          );
          if (
            savedOrder.length > 0 &&
            providerOrder.join(",") !== savedOrder.join(",")
          ) {
            console.warn(
              `[Ghostly] settings migration — providerOrder [${savedOrder.join(", ")}] → [${providerOrder.join(", ")}]`,
            );
          }

          const nextSettings = {
            ...defaults,
            ...rest,
            activeProvider,
            models,
            providerOrder,
            apiKeys,
            whisperModel: asrModel,
          };
          setSettings(nextSettings);

          // Print the whole chain plus the reason every provider is used or
          // skipped. Makes "Groq didn't answer" immediately explainable instead
          // of looking like broken provider architecture.
          for (const line of describeProviderChain(nextSettings).lines) {
            console.log(line);
          }
        }
        if (savedHistory) setHistory(savedHistory);
      } catch (err) {
        console.warn("[Ghostly] Failed to load settings:", err);
      }
    };
    loadData();
  }, [setSettings, setHistory]);

  return <Home />;
};

export default App;
