import { ipcMain, type IpcMainInvokeEvent } from "electron";

/**
 * NVIDIA NIM requests, executed in the MAIN process.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every live turn logged this:
 *
 *   [AI:NVIDIA] network error reaching integrate.api.nvidia.com:
 *   TypeError: Failed to fetch
 *
 * That is Chromium refusing a cross-origin request. `integrate.api.nvidia.com`
 * does not send `Access-Control-Allow-Origin` for the app's origin, so the
 * response is never readable and the renderer can never tell a CORS block from a
 * dead network. Retrying it per turn burns the whole timeout budget on a request
 * that structurally cannot succeed from a web context.
 *
 * The main process is not subject to the renderer's CORS rules — it is a Node
 * context with `fetch` and no origin — so the same request works here. This
 * mirrors `electron/groqAsr.ts` exactly: the renderer asks, the main process
 * does the work, and the key never crosses the boundary.
 *
 * ── The key ─────────────────────────────────────────────────────────────────
 * Read from the persisted settings store HERE, per request. The renderer sends
 * a request without a key, which is a structural guarantee rather than a
 * convention: there is no code path that puts the secret on the wire. (It is
 * still in the settings blob the renderer writes, because Settings has to be
 * able to save it — but it is never used for a network call from there.)
 *
 * ── Protocol ───────────────────────────────────────────────────────────────
 * Streaming, not buffered. The orchestrator's whole hedge design depends on
 * seeing the first text arrive early, and buffering a whole answer in main
 * would destroy the signal that decides which provider wins.
 *
 *   renderer → invoke("nvidia:stream-start", { model, messages, maxTokens })
 *              ← { ok: true, id }  |  { ok: false, code, message }
 *   main     → send("nvidia:stream-event", { id, type, text? , code?, message? })
 *              type is "chunk" | "done" | "error"
 *   renderer → invoke("nvidia:stream-abort", { id })
 */

const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";

/** Channel the main process pushes stream events on. Mirrored in preload. */
export const NVIDIA_STREAM_EVENT = "nvidia:stream-event";

export interface NvidiaStreamRequest {
  model: string;
  messages: unknown[];
  maxTokens?: number;
}

/** One SSE line from NVIDIA. Mirrors `parseNvidiaEvent` in src/lib/ai/nvidia.ts. */
export function parseNvidiaSseLine(
  line: string,
): { text: string; finishReason?: string; error?: string } | null {
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice(6).trim();
  if (!payload || payload === "[DONE]") return null;

  let data: any;
  try {
    data = JSON.parse(payload);
  } catch {
    // A malformed keep-alive frame is not fatal; skip it exactly as the
    // renderer path does.
    return null;
  }

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
  return {
    text: typeof delta?.content === "string" ? delta.content : "",
    finishReason:
      typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
  };
}

/** Minimal store surface, so this file does not depend on electron-store's type. */
export interface NvidiaKeyStore {
  get(key: string): unknown;
}

interface LiveStream {
  controller: AbortController;
  /** Which window asked, so an event can never be sent to the wrong renderer. */
  sender: IpcMainInvokeEvent["sender"];
}

const live = new Map<number, LiveStream>();
let nextId = 1;

export function registerNvidiaAiHandlers(store: NvidiaKeyStore): void {
  ipcMain.handle(
    "nvidia:stream-start",
    async (
      event,
      payload: NvidiaStreamRequest,
    ): Promise<
      | { ok: true; id: number }
      | { ok: false; code: string; message: string }
    > => {
      const model = payload?.model?.trim();
      if (!model) {
        return {
          ok: false,
          code: "invalid_request",
          message: "No NVIDIA model was requested.",
        };
      }
      if (!Array.isArray(payload?.messages) || payload.messages.length === 0) {
        return {
          ok: false,
          code: "invalid_request",
          message: "NVIDIA request had no messages.",
        };
      }

      // The key is resolved HERE and never leaves this process.
      const key = String(
        (
          store.get("settings") as
            | { apiKeys?: Record<string, string> }
            | undefined
        )?.apiKeys?.nvidia ?? "",
      );
      if (!key.trim()) {
        return {
          ok: false,
          code: "no_api_key",
          message: "NVIDIA API key is missing. Add it in Settings → API Keys.",
        };
      }

      const id = nextId++;
      const controller = new AbortController();
      live.set(id, { controller, sender: event.sender });

      const startedAt = Date.now();
      // Deliberately not awaited: the renderer's `invoke` must return the id
      // immediately so it can start receiving chunks. The stream itself is
      // driven to completion by `runStream`, which always deletes the entry.
      void runStream(id, model, payload, key.trim(), controller, startedAt);

      console.log(
        `[NVIDIA:main] stream started id=${id} model=${model} apiKeyPresent=true`,
      );
      return { ok: true, id };
    },
  );

  ipcMain.handle("nvidia:stream-abort", (_event, payload: { id?: number }) => {
    const entry = live.get(Number(payload?.id));
    if (!entry) return { ok: false };
    entry.controller.abort();
    live.delete(Number(payload?.id));
    return { ok: true };
  });
}

/**
 * Drive one NVIDIA stream and push every event to the requesting renderer.
 *
 * Never throws. Every terminal state — success, HTTP error, network error,
 * abort — ends as exactly one `done` or `error` event, because the renderer's
 * generator would otherwise wait forever for a completion that never came.
 */
async function runStream(
  id: number,
  model: string,
  payload: NvidiaStreamRequest,
  apiKey: string,
  controller: AbortController,
  startedAt: number,
): Promise<void> {
  const entry = live.get(id);
  const sender = entry?.sender;
  const send = (message: unknown) => {
    try {
      sender?.send(NVIDIA_STREAM_EVENT, message);
    } catch {
      /* the window went away mid-stream; nothing to report to */
    }
  };

  try {
    const response = await fetch(`${NVIDIA_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: payload.maxTokens ?? 4096,
        stream: true,
        messages: payload.messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({ error: { message: response.statusText } }));
      const message =
        (body?.error?.message as string | undefined) || response.statusText;
      console.error(
        `[NVIDIA:main] HTTP ${response.status} id=${id} model=${model}: ${message}`,
      );
      send({
        id,
        type: "error",
        code: "http",
        status: response.status,
        message: `NVIDIA API error: ${message}`,
      });
      return;
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunks = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseNvidiaSseLine(line);
        if (!parsed) continue;
        if (parsed.error) {
          console.error(`[NVIDIA:main] stream error id=${id}: ${parsed.error}`);
          send({
            id,
            type: "error",
            code: "stream",
            message: `NVIDIA stream error: ${parsed.error}`,
          });
          return;
        }
        if (parsed.text) {
          chunks++;
          send({ id, type: "chunk", text: parsed.text });
        }
      }
    }

    const tail = parseNvidiaSseLine(buffer);
    if (tail?.text) {
      chunks++;
      send({ id, type: "chunk", text: tail.text });
    }

    console.log(
      `[NVIDIA:main] stream done id=${id} chunks=${chunks} totalMs=${
        Date.now() - startedAt
      }`,
    );
    send({ id, type: "done", chunks });
  } catch (err) {
    if (controller.signal.aborted) {
      // Aborts are the caller's own doing (a winner elsewhere cancelled us), so
      // no error event is pushed: the caller already stopped listening.
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[NVIDIA:main] network error id=${id}: ${message}`);
    send({
      id,
      type: "error",
      code: "network",
      // The renderer classifies this as CORS/network, which is now accurate:
      // it genuinely is a Node-side transport failure, not a browser policy.
      message: `Cannot reach integrate.api.nvidia.com. Network error: ${message}.`,
    });
  } finally {
    live.delete(id);
  }
}

/** Test seam. */
export function __resetNvidiaStreamsForTests(): void {
  for (const entry of live.values()) {
    try {
      entry.controller.abort();
    } catch {
      /* already gone */
    }
  }
  live.clear();
}