export interface FetchDiagnosticsContext {
  provider: string;
  model: string;
  apiKey?: string;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Wraps fetch() for AI provider calls so that network-level failures are
 * classified and surfaced with actionable context instead of the bare
 * browser message "Failed to fetch".
 *
 * On success, logs the target host / model / whether a key was supplied,
 * plus the response status — useful for diagnosing "Failed to fetch" reports.
 */
export async function fetchWithDiagnostics(
  url: string,
  init: RequestInit,
  context: FetchDiagnosticsContext,
): Promise<Response> {
  const { provider, model, apiKey } = context;
  const host = safeHost(url);
  const keyPresent = Boolean(apiKey && apiKey.trim());

  const method = (init.method ?? "GET").toUpperCase();
  console.log(
    `[AI:${provider}] → ${method} ${host} model=${model} apiKeyPresent=${keyPresent}`,
  );

  if (!keyPresent) {
    throw new Error(
      `${provider} API key is missing. Add it in Settings → API Keys.`,
    );
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    // Preserve intentional aborts untouched.
    if (err instanceof Error && err.name === "AbortError") throw err;

    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[AI:${provider}] network error reaching ${host}:`, err);
    throw new Error(
      `Cannot reach ${host} (${provider} / ${model}). ` +
        `Network error: ${detail}. ` +
        `Check your internet/VPN, or switch provider in Settings.`,
    );
  }

  console.log(
    `[AI:${provider}] ← HTTP ${response.status} ${response.statusText}`,
  );
  return response;
}

/**
 * Appends actionable guidance when a provider rejects a request because the
 * selected model doesn't exist / isn't accessible to the account. Without this,
 * a deprecated model id (e.g. a retired Groq model) looks like a dead end.
 */
const MODEL_UNAVAILABLE_RE =
  /does not exist|not found|do not have access|not available|unsupported|invalid model|no such model/i;

/** True when a provider error looks like a missing/deprecated/restricted model id. */
export function isModelUnavailableError(message: string): boolean {
  return MODEL_UNAVAILABLE_RE.test(message);
}

export function withModelHint(message: string): string {
  if (isModelUnavailableError(message)) {
    return (
      `${message} — the selected model may be deprecated or not enabled for ` +
      `your account. Open Settings (⚙) and pick a different model.`
    );
  }
  return message;
}
