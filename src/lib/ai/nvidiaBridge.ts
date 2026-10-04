/**
 * Renderer-side half of the NVIDIA main-process bridge.
 *
 * ── The problem it exists to solve ──────────────────────────────────────────
 * From a web context, every NVIDIA request failed with `TypeError: Failed to
 * fetch` — a CORS block, because `integrate.api.nvidia.com` sends no
 * `Access-Control-Allow-Origin` for the app's origin. The failure is structural
 * and cannot be fixed in the renderer.
 *
 * `electron/nvidiaAi.ts` performs the same request from the main process, where
 * there is no origin and therefore no CORS. This module is the thin adapter
 * that turns that push-based IPC into the async-generator the orchestrator
 * already knows how to consume, so `NvidiaProvider.streamSolution` changes
 * *where* the request runs and nothing else about it.
 *
 * ── What is unchanged ───────────────────────────────────────────────────────
 * The request body, the SSE parsing, the `AIStreamMeta` fields, the model list
 * and the error wording all stay in `nvidia.ts`. This file only moves the
 * transport, and only for `streamSolution`.
 *
 * ── Never throws during setup ───────────────────────────────────────────────
 * A missing bridge (browser, tests, packaged build without the handler) returns
 * `null` from {@link isNvidiaMainBridgeAvailable}, and `nvidia.ts` falls back to
 * its original renderer `fetch`. That fallback is deliberate rather than an
 * oversight: on a machine where the origin IS allowed it still works, and
 * removing it would make this file the single point of failure for the provider.
 */

export interface NvidiaMainStreamEvent {
  id: number;
  type: "chunk" | "done" | "error";
  text?: string;
  code?: string;
  status?: number;
  message?: string;
}

interface PendingMainStream {
  push: (text: string) => void;
  fail: (err: Error) => void;
  finish: () => void;
}

/**
 * Streams for every in-flight request, keyed by the id main handed back.
 *
 * A single module-level listener rather than one per call: `ipcRenderer.on`
 * registrations are not garbage-collected per generator, and the orchestrator
 * can start several NVIDIA requests over a session.
 */
const pending = new Map<number, PendingMainStream>();
let listenerInstalled = false;

function ensureListener(): void {
  if (listenerInstalled) return;
  const bridge = window.ghostly as
    | { onNvidiaStream?: (cb: (e: NvidiaMainStreamEvent) => void) => () => void }
    | undefined;
  if (typeof bridge?.onNvidiaStream !== "function") return;

  listenerInstalled = true;
  bridge.onNvidiaStream((event) => {
    const entry = pending.get(event.id);
    if (!entry) return;
    if (event.type === "chunk") {
      if (event.text) entry.push(event.text);
      return;
    }
    if (event.type === "error") {
      pending.delete(event.id);
      entry.fail(new Error(event.message ?? "NVIDIA stream failed"));
      return;
    }
    pending.delete(event.id);
    entry.finish();
  });
}

/** Whether the main-process NVIDIA transport is usable in this runtime. */
export function isNvidiaMainBridgeAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.ghostly as
    | { nvidiaStreamStart?: unknown; nvidiaStreamAbort?: unknown }
    | undefined;
  return (
    typeof bridge?.nvidiaStreamStart === "function" &&
    typeof bridge?.nvidiaStreamAbort === "function"
  );
}

export interface NvidiaMainStreamPayload {
  model: string;
  messages: unknown[];
  maxTokens?: number;
}

/**
 * Stream one answer through the main process.
 *
 * Resolves to `null` when the bridge is unavailable OR the main process refused
 * the request outright (no key, bad payload). `null` is not an error: the
 * caller retries with its own transport. A stream that STARTS and then fails
 * throws, because by then the request really was attempted and the caller must
 * see why.
 */
export async function* streamNvidiaViaMain(
  payload: NvidiaMainStreamPayload,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!isNvidiaMainBridgeAvailable()) return null;

  // Narrowed by the availability check above, which is why the cast is needed
  // at all: `isNvidiaMainBridgeAvailable` cannot be a type guard without
  // repeating the whole `Window` surface in a signature.
  const bridge = window.ghostly as unknown as {
    nvidiaStreamStart: (
      p: NvidiaMainStreamPayload,
    ) => Promise<
      | { ok: true; id: number }
      | { ok: false; code: string; message: string }
    >;
    nvidiaStreamAbort: (p: { id: number }) => Promise<{ ok: boolean }>;
  };

  const started = await bridge.nvidiaStreamStart(payload);
  if (!started?.ok) {
    console.warn(
      `[NVIDIA] main-process bridge refused the request: ${started?.code ?? "unknown"} — falling back to the renderer.`,
    );
    return null;
  }

  ensureListener();
  const { id } = started;

  const queue: string[] = [];
  let resolveNext: (() => void) | null = null;
  let failure: Error | null = null;
  let done = false;

  const wake = () => {
    const r = resolveNext;
    resolveNext = null;
    r?.();
  };

  pending.set(id, {
    push: (text) => {
      queue.push(text);
      wake();
    },
    fail: (err) => {
      failure = err;
      wake();
    },
    finish: () => {
      done = true;
      wake();
    },
  });

  const onAbort = () => {
    void bridge.nvidiaStreamAbort({ id });
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (failure) throw failure;
      if (done) return;
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
  } finally {
    // Runs on normal completion, on a throw, and on an early return, so the map
    // can never leak an entry and a late chunk can never resolve a dead waiter.
    pending.delete(id);
    signal?.removeEventListener("abort", onAbort);
  }
}