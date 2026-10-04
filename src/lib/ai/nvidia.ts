import type { AIProvider, AIRequestOptions } from "./types";
import {
  fetchWithDiagnostics,
  withModelHint,
} from "./fetchWithDiagnostics";
import {
  isNvidiaMainBridgeAvailable,
  streamNvidiaViaMain,
} from "./nvidiaBridge";

/**
 * Direct NVIDIA NIM provider (build.nvidia.com).
 *
 * ── This is NOT "an NVIDIA model through OpenRouter" ────────────────────────
 * The two are genuinely different and must not be conflated:
 *
 *   A. NVIDIA *via OpenRouter* — Ghostly calls OpenRouter, OpenRouter routes
 *      to an NVIDIA-hosted model. That is just OpenRouter with a different
 *      backend, already reported through `AIStreamMeta.provider`.
 *   B. Direct NVIDIA (this file) — Ghostly calls NVIDIA's own hosted API.
 *
 * ── API contract (verified against NVIDIA's published docs, not guessed) ───
 *   POST https://integrate.api.nvidia.com/v1/chat/completions
 *   Authorization: Bearer <NVIDIA_API_KEY>
 *   Body: OpenAI-compatible — { model, messages, max_tokens, stream: true }
 *   SSE frames: `data: {choices:[{delta:{content}}], finish_reason}`
 *   Models: GET https://integrate.api.nvidia.com/v1/models
 *
 * The curated model ids below are all documented NIM endpoints on the free
 * developer tier.
 *
 * ── WHERE the request runs ──────────────────────────────────────────────────
 * `streamSolution` now prefers the ELECTRON MAIN PROCESS
 * (`electron/nvidiaAi.ts`), because every renderer-side request failed with
 * `TypeError: Failed to fetch`: NVIDIA sends no `Access-Control-Allow-Origin` for
 * the app's origin, so the request was blocked before it left. The main process
 * has no origin and is therefore not subject to the policy, and the key is read
 * from the settings store there so it never crosses the boundary.
 *
 * The renderer `fetch` below is retained as a fallback for runtimes where the
 * bridge is absent (the browser, unit tests). It is the SAME request, byte for
 * byte — only the transport differs — so the SSE parsing, telemetry and error
 * wording below are shared by both paths and cannot drift.
 */
export interface NvidiaChunk {
  text: string;
  finishReason?: string;
  error?: string;
}

export function parseNvidiaEvent(data: any): NvidiaChunk {
  // NVIDIA can report a failure *inside* an HTTP 200 stream.
  if (data?.error) {
    return {
      text: "",
      error:
        typeof data.error === "string"
          ? data.error
          : (data.error.message ?? String(data.error)),
    };
  }

  const choice = data?.choices?.[0];
  const delta = choice?.delta ?? choice?.message;
  const content = typeof delta?.content === "string" ? delta.content : "";

  return {
    text: content,
    finishReason:
      typeof choice?.finish_reason === "string"
        ? choice.finish_reason
        : undefined,
  };
}

const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";

export class NvidiaProvider implements AIProvider {
  name = "nvidia";

  listModels(): string[] {
    // Curated fallback for when live discovery is unavailable.
    return [
      "meta/llama-3.3-70b-instruct",
      "meta/llama-3.1-8b-instruct",
      "nvidia/llama-3.1-nemotron-70b-instruct",
    ];
  }

  async fetchModels(apiKey: string): Promise<string[]> {
    const res = await fetchWithDiagnostics(
      `${NVIDIA_BASE}/models`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      { provider: "nvidia", model: "(list)", apiKey },
    );
    if (!res.ok) {
      throw new Error(
        `NVIDIA models error: ${res.status} ${res.statusText}`,
      );
    }
    const data = await res.json();
    return (data?.data ?? [])
      .map((m: any) => m.id as string)
      .filter((id: string) => id && typeof id === "string")
      .sort();
  }

  async *streamSolution(options: AIRequestOptions): AsyncGenerator<string> {
    const {
      base64Image,
      prompt,
      system,
      messages = [],
      model,
      apiKey,
      maxTokens = 4096,
      signal,
      meta,
    } = options;

    const imageUrl = base64Image?.startsWith("data:")
      ? base64Image
      : base64Image
        ? `data:image/png;base64,${base64Image}`
        : undefined;

    const apiMessages: any[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    if (system?.trim()) {
      apiMessages.unshift({ role: "system", content: system });
    }

    const currentContent: any[] = [];
    if (imageUrl) {
      currentContent.push({ type: "image_url", image_url: { url: imageUrl } });
    }
    currentContent.push({ type: "text", text: prompt });
    apiMessages.push({ role: "user", content: currentContent as any });

    // One clock for the whole attempt, main process or renderer, so the
    // telemetry a caller sees covers whichever transport actually ran.
    const startedAt = performance.now();

    // ── Preferred path: main process (no CORS) ──────────────────────────────
    // Tried BEFORE any renderer fetch, because from a web context that fetch
    // cannot succeed at all. An empty stream means the bridge declined to start
    // the request (no key in the main store, or no bridge in this runtime), in
    // which case the original renderer path below runs unchanged.
    if (isNvidiaMainBridgeAvailable()) {
      const viaMain = streamNvidiaViaMain(
        { model, messages: apiMessages, maxTokens },
        signal,
      );
      let produced = false;
      for await (const chunk of viaMain) {
        produced = true;
        yield chunk;
      }
      if (produced) {
        if (meta) meta.httpMs = Math.round(performance.now() - startedAt);
        console.log(
          `[NVIDIA] completed via main process in ${Math.round(
            performance.now() - startedAt,
          )}ms`,
        );
        return;
      }
      console.warn(
        "[NVIDIA] main process declined the request — retrying from the renderer (a CORS block is likely).",
      );
    }

    // `apiKeyPresent` only — the key itself is never logged.
    console.log(
      `[NVIDIA] request started — model=${model} maxTokens=${maxTokens} apiKeyPresent=${!!apiKey}`,
    );

    const response = await fetchWithDiagnostics(
      `${NVIDIA_BASE}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: true,
          messages: apiMessages,
        }),
        signal,
      },
      { provider: "nvidia", model, apiKey },
    );

    console.log(
      `[NVIDIA] http=${Math.round(performance.now() - startedAt)}ms status=${response.status}`,
    );
    if (meta) meta.httpMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ error: { message: response.statusText } }));
      console.error(
        `[NVIDIA] error: ${JSON.stringify(err).slice(0, 500)}`,
      );
      throw new Error(
        withModelHint(
          `NVIDIA API error: ${err.error?.message || response.statusText}`,
        ),
      );
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunkCount = 0;
    let firstChunkAt: number | null = null;

    const consume = (line: string): string => {
      if (!line.startsWith("data: ") || line === "data: [DONE]") return "";
      chunkCount++;
      let parsed: NvidiaChunk;
      try {
        parsed = parseNvidiaEvent(JSON.parse(line.slice(6).trim()));
      } catch {
        return ""; // malformed keep-alive frame is not fatal
      }
      if (parsed.error) {
        throw new Error(`NVIDIA stream error: ${parsed.error}`);
      }
      if (firstChunkAt === null) {
        firstChunkAt = performance.now();
        console.log(
          `[NVIDIA] firstChunk=${Math.round(firstChunkAt - startedAt)}ms`,
        );
      }
      if (parsed.finishReason) {
        meta.finishReason = parsed.finishReason;
        console.log(`[NVIDIA] finishReason=${parsed.finishReason}`);
      }
      return parsed.text;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const text = consume(line);
        if (text) yield text;
      }
    }

    if (buffer.trim()) {
      const text = consume(buffer);
      if (text) yield text;
    }

    console.log(
      `[NVIDIA] stream ended: chunks=${chunkCount} total=${Math.round(
        performance.now() - startedAt,
      )}ms`,
    );
  }
}