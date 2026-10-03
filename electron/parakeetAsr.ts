import { ipcMain, utilityProcess } from "electron";
import path from "node:path";
import fs from "node:fs";
import {
  ParakeetHost,
  PARAKEET_SAMPLE_RATE,
  PARAKEET_MAX_SECONDS,
  type ParakeetHostDeps,
  type ParakeetHostResult,
  type ParakeetChildLike,
  type ParakeetHostReply,
  type ParakeetHostRequest,
  type ParakeetHostMode,
  type ParakeetModelStatus,
} from "../src/lib/parakeetHost";
import {
  startParakeetDiagnostics,
  type ParakeetDiagnosticsHandle,
} from "./parakeetDiagnostics";

/**
 * Parakeet comparison host — MAIN PROCESS ONLY.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Parakeet is a DEVELOPMENT COMPARISON ENGINE. It is off by default, it is
 * never the production default, it is never a fallback for Moonshine, and its
 * transcript is written ONLY to the isolated `asrComparisons` slice. It must
 * never reach the question gate, the prompt, or the answer path.
 *
 * This module owns the `utilityProcess` that holds the model. All the decision
 * logic — queueing, timeouts, restarts, validation, idle unload — lives in
 * `src/lib/parakeetHost.ts` and is unit-tested against a fake child. This file
 * is only the Electron adapter.
 *
 * Follows the same shape as `electron/groqAsr.ts`: the renderer gets a boolean
 * and a normalised result, never a handle into the engine.
 */

/**
 * Dev location of the model, relative to the repo root.
 *
 * A packaged app never resolves this: {@link resolveModelDir} prefers the
 * userData copy that the in-app downloader writes, and only falls back here
 * when running from source.
 */
export const PARAKEET_MODEL_DIR_NAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";

/** Dev fallback: `models/<name>` next to the repo root. */
export const DEFAULT_PARAKEET_MODEL_DIR = path.join(
  process.cwd(),
  "models",
  PARAKEET_MODEL_DIR_NAME,
);

export interface ParakeetIpcOutcome {
  ok: boolean;
  text?: string;
  decodeMs?: number;
  loadMs?: number;
  rssMb?: number;
  rtf?: number;
  code?: string;
  message?: string;
  status?: ParakeetModelStatus;
  /** Whether this call was Parakeet-as-primary or Parakeet-as-comparison. */
  mode?: ParakeetHostMode;
}

export interface ParakeetTranscribePayload {
  samples?: unknown;
  sampleRate?: unknown;
}

/**
 * Adapt an Electron `utilityProcess` to the small interface the host expects.
 *
 * Electron's child uses `post`/`on("message")`/`on("exit")`; the host is
 * written against that shape so its tests can substitute a fake in one line.
 */
function adaptUtilityProcess(child: Electron.UtilityProcess): ParakeetChildLike {
  return {
    post(message: ParakeetHostRequest) {
      child.postMessage(message);
    },
    kill() {
      child.kill();
    },
    onMessage(cb: (reply: ParakeetHostReply) => void) {
      child.on("message", (message: ParakeetHostReply) => cb(message));
    },
    onExit(cb: (code: number | null) => void) {
      child.on("exit", (code: number) => cb(code));
    },
  };
}

/** Create the host with real Electron wiring. Exported so tests can inspect it. */export function createParakeetHost(options: {
  modelDir: string;
  isEnabled: () => boolean;
  isPrimary?: () => boolean;
  paddingMs?: () => number | undefined;
  log?: (line: string) => void;
}): ParakeetHost {
  const modelDir = options.modelDir;
  const workerPath = resolveWorkerPath();

  const deps: ParakeetHostDeps = {
    modelDir,
    isEnabled: options.isEnabled,
    mode: () => (options.isPrimary?.() ? "primary" : "comparison"),
    paddingMs: options.paddingMs,
    log: options.log ?? ((line) => console.log(line)),
    spawnChild: () =>
      adaptUtilityProcess(utilityProcess.fork(workerPath, [], { stdio: "pipe" })),
  };
  return new ParakeetHost(deps);
}

/**
 * Locate `parakeetWorker.cjs` in dev and in a packaged app.
 *
 * electron-vite copies the worker next to `index.js` in `out/main`, so
 * `__dirname` is right in development. It is WRONG inside an asar archive in one
 * specific way that matters here: `utilityProcess.fork` executes the script with
 * a real Node runtime, which cannot load a JavaScript file from inside the
 * archive. The unpacked copy lives beside it under `app.asar.unpacked`, so the
 * packaged path is rewritten to that.
 *
 * Both candidates are checked rather than assumed, because guessing wrong here
 * fails as an unhelpful ENOENT inside the fork, long after the useful error
 * message has scrolled away.
 */
export function resolveWorkerPath(
  dir: string = __dirname,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string {
  const packaged = path.join(dir, "..", "app.asar.unpacked", "out", "main", "parakeetWorker.cjs");
  if (exists(packaged)) return packaged;
  return path.join(dir, "parakeetWorker.cjs");
}

/**
 * Where the model actually lives.
 *
 * Preference order is deliberate: an explicit override first (developer), then
 * the userData copy the in-app downloader manages, then the dev `models/`
 * folder. A packaged app has no `models/` directory and must never be pointed
 * at one, so the packaged caller is expected to pass its userData path.
 */
export function resolveModelDir(options: {
  override?: string;
  userDataDir?: string;
  devDir?: string;
}): string {
  if (options.override) return options.override;
  if (options.userDataDir) {
    return path.join(options.userDataDir, "models", PARAKEET_MODEL_DIR_NAME);
  }
  return options.devDir ?? DEFAULT_PARAKEET_MODEL_DIR;
}

let host: ParakeetHost | null = null;

/**
 * The live memory/latency sampler, started on load and stopped on unload.
 *
 * Scoped to the model's lifetime on purpose: a sampler that ran for the whole
 * app session would keep reporting after the model was gone, which is exactly
 * when those numbers stop being interpretable.
 */
let diagnostics: ParakeetDiagnosticsHandle | null = null;

/**
 * Register the dev-only Parakeet IPC surface.
 *
 * Every handler is wrapped so a failure becomes a value. Nothing in here may
 * throw into the main app: a comparison engine that breaks the editor is worse
 * than no comparison at all.
 */
export function registerParakeetHandlers(options: {
  isEnabled: () => boolean;
  isPrimary?: () => boolean;
  modelDir: string;
  paddingMs?: () => number | undefined;
}): { getHost: () => ParakeetHost } {
  const getHost = (): ParakeetHost => {
    if (!host) {
      host = createParakeetHost({
        modelDir: options.modelDir,
        isEnabled: options.isEnabled,
        isPrimary: options.isPrimary,
        paddingMs: options.paddingMs,
      });
    }
    return host;
  };
  const mode = (): ParakeetHostMode =>
    options.isPrimary?.() ? "primary" : "comparison";

  // Cheap, safe status probe for the settings UI. Never loads anything.
  ipcMain.handle(
    "parakeet:status",
    (): { status: ParakeetModelStatus; mode?: ParakeetHostMode } => {
      if (!options.isEnabled()) return { status: "disabled" };
      try {
        return { status: getHost().getStatus(), mode: mode() };
      } catch {
        return { status: "error" };
      }
    },
  );

  // Explicit model load, called on Start Interview rather than at launch.
  ipcMain.handle("parakeet:load", async (): Promise<ParakeetIpcOutcome> => {
    try {
      if (!options.isEnabled()) {
        return { ok: false, code: "disabled", message: "Parakeet is not enabled" };
      }
      const result = await getHost().load();
      if (result.ok && !diagnostics) {
        // Sampled every 10 s for the lifetime of the model: system memory
        // (available, plus the delta since the model loaded), the child's own
        // RSS, and the latest decode ms / RTF. Numbers only — never a
        // transcript, never audio.
        diagnostics = startParakeetDiagnostics({ getHost, mode: mode() });
      }
      return { ...result, status: getHost().getStatus(), mode: mode() };
    } catch (err) {
      return {
        ok: false,
        code: "crashed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Release the model, called on Stop Interview.
  ipcMain.handle("parakeet:unload", (): ParakeetIpcOutcome => {
    try {
      // Stop sampling BEFORE releasing the model, so the final line still
      // reflects a loaded model rather than a just-freed one.
      diagnostics?.stop();
      diagnostics = null;
      host?.unload();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        code: "crashed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Transcription. The same handler serves both roles: as a comparison column it
  // feeds the dev diagnostics table, and as the primary engine it feeds the
  // normal transcript pipeline. What the result is USED for is decided in the
  // renderer; this side only decodes.
  ipcMain.handle(
    "parakeet:transcribe",
    async (_event, payload: ParakeetTranscribePayload): Promise<ParakeetIpcOutcome> => {
      try {
        if (!options.isEnabled()) {
          return { ok: false, code: "disabled", message: "Parakeet is not enabled" };
        }
        // The host validates the samples (Float32Array, 16 kHz, length cap);
        // this pre-check exists so an obviously wrong payload never even reaches
        // the queue.
        if (!(payload?.samples instanceof Float32Array)) {
          return {
            ok: false,
            code: "invalid_audio",
            message: "samples must be a Float32Array",
          };
        }
        if (payload.sampleRate !== PARAKEET_SAMPLE_RATE) {
          return {
            ok: false,
            code: "invalid_audio",
            message: `sampleRate must be ${PARAKEET_SAMPLE_RATE}`,
          };
        }
        const seconds = payload.samples.length / PARAKEET_SAMPLE_RATE;
        if (seconds > PARAKEET_MAX_SECONDS) {
          return {
            ok: false,
            code: "too_long",
            message: `${seconds.toFixed(1)}s exceeds the ${PARAKEET_MAX_SECONDS}s cap`,
          };
        }
        const result: ParakeetHostResult = await getHost().transcribe(
          payload.samples,
          payload.sampleRate,
        );
        return result;
      } catch (err) {
        return {
          ok: false,
          code: "crashed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // Dev diagnostics for the log / settings panel. Counts and timings only —
  // never audio, never model contents.
  ipcMain.handle("parakeet:diagnostics", () => {
    try {
      if (!options.isEnabled()) {
        return { status: "disabled" as ParakeetModelStatus };
      }
      // The mode is recomputed per call, not captured at load: the user can flip
      // the primary engine in Settings while the model is loaded, and a stale
      // label on a memory figure is exactly the false claim this avoids.
      return { ...getHost().getDiagnostics(), mode: mode() };
    } catch {
      return { status: "error" as ParakeetModelStatus };
    }
  });

  return { getHost };
}

/** Test seam: drop the host without leaving a utility process running. */
export function __resetParakeetHostForTests(): void {
  try {
    diagnostics?.stop();
  } catch {
    /* already gone */
  }
  diagnostics = null;
  try {
    host?.dispose();
  } catch {
    /* already gone */
  }
  host = null;
}