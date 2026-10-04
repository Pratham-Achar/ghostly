import type { AIProvider, AIRequestOptions } from "./types";
import {
  fetchWithDiagnostics,
  withModelHint,
} from "./fetchWithDiagnostics";

/**
 * A single parsed SSE payload from `streamGenerateContent`.
 *
 * Text is collected from EVERY non-thought text part — never just `parts[0]`.
 * Thinking models emit a thought part first, so reading only `parts[0]` is one
 * of the ways an answer silently comes back as "nothing".
 */
export interface GeminiChunk {
  text: string;
  finishReason?: string;
  blockReason?: string;
}

export function parseGeminiEvent(data: any): GeminiChunk {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts;

  let text = "";
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!part || part.thought === true) continue; // never surface thinking
      if (typeof part.text === "string") text += part.text;
    }
  }

  return {
    text,
    finishReason:
      typeof candidate?.finishReason === "string"
        ? candidate.finishReason
        : undefined,
    blockReason:
      data?.promptFeedback?.blockReason ??
      data?.promptFeedback?.blockReasonMessage,
  };
}

/**
 * Model-specific generation config.
 *
 * Gemini 2.5/3 think by default and those reasoning tokens are billed against
 * `maxOutputTokens` — one of the ways a request returns HTTP 200 with no text.
 * Flash can switch thinking off; Pro cannot (`thinkingBudget: 0` is a 400
 * there) so it gets the documented minimum of 128. Gemini 1.5/2.0 reject the
 * field outright, hence the version check.
 */
export function geminiGenerationConfig(
  model: string,
  maxTokens: number,
  /**
   * Overrides for the thinking budget.
   *
   * ── Why an override exists ────────────────────────────────────────────────
   * The default below is the shipping policy: Flash thinks 0, Pro thinks the
   * documented minimum of 128. That is right for an interview answer and wrong
   * for a MEASUREMENT, because Phase 8.3 needs to compare the two on latency and
   * quality — which is impossible if only one of them is reachable.
   *
   * `thinkingBudget` is therefore overridable, and `undefined` (the default)
   * means "use the shipping policy exactly as before". Nothing about the live
   * path changes; the benchmark passes a number.
   *
   * The string `"provider-default"` is the third state and it is the one the
   * benchmark actually needs. For Flash the shipping policy IS `thinkingBudget:
   * 0`, so "compare against the default" is impossible unless the field can be
   * omitted entirely — which is how you ask for the API's own default
   * (dynamic thinking on 2.5 Flash). Sending `0` twice would produce a benchmark
   * that reports a real-looking delta of zero and teaches the wrong lesson.
   */
  opts: { thinkingBudget?: number | "provider-default" } = {},
) {
  const config: any = { maxOutputTokens: maxTokens, temperature: 0.3 };

  if (/^gemini-(?:2\.5|3)/i.test(model)) {
    if (opts.thinkingBudget === "provider-default") {
      // Field omitted entirely: the provider applies its own default.
      return config;
    }
    const budget =
      typeof opts.thinkingBudget === "number"
        ? Math.max(0, Math.floor(opts.thinkingBudget))
        : // Pro cannot take 0 (it is a 400), so it gets the documented floor.
          /pro/i.test(model)
          ? 128
          : 0;
    config.thinkingConfig = { thinkingBudget: budget };
  }

  return config;
}

export class GeminiProvider implements AIProvider {
  name = "gemini";

  listModels(): string[] {
    // Curated fallback. `fetchModels()` below asks the API what this key can
    // actually use, so preview/renamed ids never go stale here.
    return [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ];
  }

  async fetchModels(apiKey: string): Promise<string[]> {
    const res = await fetchWithDiagnostics(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { method: "GET" },
      { provider: "gemini", model: "(list)", apiKey },
    );
    if (!res.ok) {
      throw new Error(`Gemini models error: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return (data?.models ?? [])
      .filter((m: any) =>
        (m.supportedGenerationMethods ?? []).includes("generateContent"),
      )
      .map((m: any) => String(m.name).replace(/^models\//, ""))
      .filter((id: string) => id.startsWith("gemini"))
      .sort();
  }

  async *streamSolution(options: AIRequestOptions): AsyncGenerator<string> {
    const {
      base64Image,
      mimeType = "image/png",
      prompt,
      system,
      messages = [],
      model,
      apiKey,
    maxTokens = 4096,
    signal,
    meta,
    /**
     * Phase 8.3 benchmark seam. Not part of `AIRequestOptions` on purpose —
     * adding it there would put a measurement knob on the live request path,
     * where it could be set by accident.
     */
    thinkingBudget,
  } = options as AIRequestOptions & {
    thinkingBudget?: number | "provider-default";
  };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    // Strip data URL prefix if present
    const imageData = base64Image?.includes(",")
      ? base64Image.split(",")[1]
      : base64Image;

    const contents: any[] = [];

    // Map previous messages
    for (const msg of messages) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      });
    }

    // Append new prompt + image
    const parts: any[] = [];
    if (imageData) {
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: imageData,
        },
      });
    }
    parts.push({ text: prompt });

    contents.push({
      role: "user",
      parts,
    });

    const body: any = {
      contents,
      generationConfig: geminiGenerationConfig(model, maxTokens, { thinkingBudget }),
    };

    // Behavioural rules live in Gemini's native system slot so a user-role
    // prompt can never override them.
    if (system?.trim()) {
      body.systemInstruction = { parts: [{ text: system }] };
    }

    const response = await fetchWithDiagnostics(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
      { provider: "gemini", model, apiKey },
    );

    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ error: { message: response.statusText } }));
      throw new Error(
        withModelHint(
          `Gemini API error: ${err.error?.message || response.statusText}`,
        ),
      );
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const consume = (line: string) => {
      if (!line.startsWith("data: ")) return "";
      try {
        const parsed = parseGeminiEvent(JSON.parse(line.slice(6)));
        if (parsed.blockReason && meta) meta.blockReason = parsed.blockReason;
        if (parsed.finishReason && meta) meta.finishReason = parsed.finishReason;
        return parsed.text;
      } catch {
        return ""; // skip malformed chunks
      }
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

    // Process remaining buffer
    const tail = consume(buffer);
    if (tail) yield tail;
  }
}
