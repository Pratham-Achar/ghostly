import { GeminiProvider } from "./gemini";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GroqProvider } from "./groq";
import { OpenRouterProvider } from "./openrouter";
import { NvidiaProvider } from "./nvidia";
import type { AIProvider } from "./types";

export type ProviderName =
  | "gemini"
  | "openai"
  | "anthropic"
  | "groq"
  | "openrouter"
  | "nvidia";

const providers: Record<ProviderName, AIProvider> = {
  gemini: new GeminiProvider(),
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
  groq: new GroqProvider(),
  openrouter: new OpenRouterProvider(),
  nvidia: new NvidiaProvider(),
};

/**
 * The registered provider names, derived from the registry itself.
 *
 * Never hardcode this list elsewhere. It previously lived as a literal array
 * in `App.tsx`, where it silently fell behind the registry and caused the
 * persisted-settings migration to discard "openrouter" from `providerOrder`.
 */
export const PROVIDER_NAMES = Object.keys(providers) as ProviderName[];

export function isProviderName(value: unknown): value is ProviderName {
  return (
    typeof value === "string" &&
    (PROVIDER_NAMES as string[]).includes(value)
  );
}

export function getProvider(name: ProviderName): AIProvider {
  return providers[name] ?? providers.gemini;
}

export function getAllProviders(): Record<ProviderName, AIProvider> {
  return providers;
}

export { providers };
