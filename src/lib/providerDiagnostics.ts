import { isProviderName, type ProviderName } from "./ai";
import { isOpenRouterFreeModel, OPENROUTER_FREE_MODEL } from "./ai/openrouter";

/**
 * The interview provider chain.
 *
 * OpenRouter is the PRIMARY gateway. Groq, NVIDIA and Gemini are INDEPENDENT
 * secondary providers — Ghostly calls them directly, and never lets OpenRouter
 * call them on our behalf. Keeping them independently controllable is the whole
 * point: each has its own key, its own quota and its own failure mode.
 *
 * All four are always represented in `providerOrder`. Whether one is actually
 * *used* is decided at run time by whether it has credentials — so the
 * architecture is visible and configurable even on a machine that only has one
 * key, and the log can always explain why a provider was skipped.
 */
export const INTERVIEW_PROVIDER_ORDER: ProviderName[] = [
  "openrouter",
  "groq",
  "nvidia",
  "gemini",
];

export type ProviderAvailability =
  /** In the chain with a credential — will be attempted. */
  | "ready"
  /** In the chain but no API key saved — skipped. */
  | "missing-api-key"
  /** Has a key but is not in the configured chain — skipped. */
  | "not-in-chain";

export interface ProviderStatus {
  provider: ProviderName;
  model: string;
  availability: ProviderAvailability;
  /** Short human-readable explanation, e.g. "no API key saved". */
  detail: string;
}

export interface ChainDescription {
  /** Every provider in the configured order, e.g. `openrouter(openrouter/free) → groq(x)`. */
  configured: string;
  /** Only the providers that will actually be attempted. */
  resolved: string;
  status: ProviderStatus[];
  /** Ready-to-log lines, including the per-provider reasons. */
  lines: string[];
}

interface ChainSettings {
  providerOrder?: ProviderName[];
  models?: Partial<Record<ProviderName, string>>;
  apiKeys?: Partial<Record<ProviderName, string>>;
}

const label = (p: ProviderName) => p.toUpperCase();

const withModel = (p: ProviderName, model: string) =>
  `${p}(${model || "unset"})`;

/**
 * Normalise a persisted `providerOrder`.
 *
 * Guarantees, in order of precedence:
 *  1. every entry is a provider that actually exists in the registry;
 *  2. OpenRouter comes FIRST whenever it has a key — it is the primary gateway
 *     and an old store must never silently route around it;
 *  3. every other known provider is present, so the documented
 *     OpenRouter → Groq → NVIDIA → Gemini chain is always fully expressed
 *     regardless of which keys happen to be saved today.
 *
 * Providers without a key are still kept if the user already had them in their
 * saved order (so an intentional slot is never dropped); whether they are used
 * is decided per run.
 */
export function normalizeProviderOrder(
  saved: unknown,
  apiKeys: Partial<Record<ProviderName, string>> | undefined,
): ProviderName[] {
  const keys = apiKeys ?? {};
  const hasKey = (p: ProviderName) => Boolean(keys[p]?.trim());
  void hasKey;

  const valid = Array.isArray(saved) ? saved.filter(isProviderName) : [];

  const result: ProviderName[] = [];
  const add = (p: ProviderName) => {
    if (!result.includes(p)) result.push(p);
  };

  // 1 + 2 + 3. The canonical architecture, always, in its documented order:
  //    OpenRouter → Groq → NVIDIA → Gemini.
  //
  // `providerOrder` is the user's ENABLED chain, not a list of things that
  // happen to work today, so every known provider is expressed regardless of
  // whether a key exists yet. That keeps the architecture visible in Settings
  // and keeps the order stable when a key is added later. Whether a provider
  // is actually attempted is decided per run by the key filter, and the startup
  // diagnostic always states the reason it was skipped.
  for (const p of INTERVIEW_PROVIDER_ORDER) add(p);

  // Anything else the user had (a provider added after this table was
  // written) is preserved, appended.
  for (const p of valid) add(p);

  return result;
}

/**
 * Describe the chain in full: what is configured, what will actually run, and —
 * for every provider that will NOT run — exactly why.
 *
 * This exists so "Groq didn't answer" is never a mystery: the log states
 * `missing API key` or `not in chain` rather than leaving the user to guess
 * whether the provider architecture is broken.
 */
export function describeProviderChain(settings: ChainSettings): ChainDescription {
  const order = settings.providerOrder ?? [];
  const models = settings.models ?? {};
  const keys = settings.apiKeys ?? {};

  const modelFor = (p: ProviderName): string => {
    const configured = models[p]?.trim();
    if (configured) return configured;
    // The gateway default is always valid even without a saved model.
    return p === "openrouter" ? OPENROUTER_FREE_MODEL : "unset";
  };

  const status: ProviderStatus[] = INTERVIEW_PROVIDER_ORDER.map((p) => {
    const model = modelFor(p);
    const inChain = order.includes(p);

    if (!inChain) {
      return {
        provider: p,
        model,
        availability: keys[p]?.trim() ? "not-in-chain" : "not-in-chain",
        detail: keys[p]?.trim()
          ? "not in the configured chain"
          : "not in the configured chain; no API key",
      };
    }
    if (!keys[p]?.trim()) {
      return {
        provider: p,
        model,
        availability: "missing-api-key",
        detail: "no API key",
      };
    }
    return {
      provider: p,
      model,
      availability: "ready",
      detail: isOpenRouterFreeModel(model)
        ? "free router — model chosen per request"
        : "",
    };
  });

  const configured = order
    .map((p) => withModel(p, modelFor(p)))
    .join(" → ");
  const resolved = status
    .filter((s) => s.availability === "ready")
    .map((s) => withModel(s.provider, s.model))
    .join(" → ");

  return {
    configured,
    resolved: resolved || "(none — no provider has an API key)",
    status,
    lines: [
      `[AI] configured provider chain: ${configured || "(empty)"}`,
      `[AI] resolved interview provider chain: ${resolved}`,
      "[AI] provider status:",
      ...status.map((s) =>
        s.availability === "ready"
          ? `  ${label(s.provider)} [${s.model}] — ready${s.detail ? ` (${s.detail})` : ""}`
          : `  ${label(s.provider)} [${s.model}] — SKIPPED: ${s.detail}`,
      ),
    ],
  };
}