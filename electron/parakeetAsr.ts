import { ipcMain, utilityProcess } from "electron";
import path from "node:path";
import {
  ParakeetHost,
  PARAKEET_SAMPLE_RATE,
  PARAKEET_MAX_SECONDS,
  type ParakeetHostDeps,
  type ParakeetHostResult,
  type ParakeetChildLike,
  type ParakeetHostReply,
  type ParakeetHostRequest,
  type ParakeetModelStatus,
} from "../src/lib/parakeetHost";

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

/** Default model location. Overridable for a relocated model directory. */
export const DEFAULT_PARAKEET_MODEL_DIR = path.join(
  process.cwd(),
  "models",
  "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
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

/** Create the host with real Electron wiring. Exported so tests can inspect it. */
export function createParakeetHost(options: {
  modelDir?: string;
  isEnabled: () => boolean;
  log?: (line: string) => void;
} ): ParakeetHost {
  const modelDir = options.modelDir ?? DEFAULT_PARAKEET_MODEL_DIR;
  const workerPath = path.join(__dirname, "parakeetWorker.cjs");

  const deps: ParakeetHostDeps = {
    modelDir,
    isEnabled: options.isEnabled,
    log: options.log ?? ((line) => console.log(line)),
    spawnChild: () =>
      adaptUtilityProcess(utilityProcess.fork(workerPath, [], { stdio: "pipe" })),
  };
  return new ParakeetHost(deps);
}

let host: ParakeetHost | null = null;

/**
 * Register the dev-only Parakeet IPC surface.
 *
 * Every handler is wrapped so a failure becomes a value. Nothing in here may
 * throw into the main app: a comparison engine that breaks the editor is worse
 * than no comparison at all.
 */
export function registerParakeetHandlers(options: {
  isEnabled: () => boolean;
  modelDir?: string;
}): { getHost: () => ParakeetHost } {
  const getHost = (): ParakeetHost => {
    if (!host) {
      host = createParakeetHost({
        modelDir: options.modelDir,
        isEnabled: options.isEnabled,
      });
    }
    return host;
  };

  // Cheap, safe status probe for the settings UI. Never loads anything.
  ipcMain.handle("parakeet:status", (): { status: ParakeetModelStatus } => {
    if (!options.isEnabled()) return { status: "disabled" };
    try {
      return { status: getHost().getStatus() };
    } catch {
      return { status: "error" };
    }
  });

  // Explicit model load, called on Start Interview rather than at launch.
  ipcMain.handle("parakeet:load", async (): Promise<ParakeetIpcOutcome> => {
    try {
      if (!options.isEnabled()) {
        return { ok: false, code: "disabled", message: "Parakeet comparison is off" };
      }
      const result = await getHost().load();
      return { ...result, status: getHost().getStatus() };
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

  // Transcription. This is the comparison path — the result is a transcript for
  // the dev diagnostics table, nothing more.
  ipcMain.handle(
    "parakeet:transcribe",
    async (_event, payload: ParakeetTranscribePayload): Promise<ParakeetIpcOutcome> => {
      try {
        if (!options.isEnabled()) {
          return { ok: false, code: "disabled", message: "Parakeet comparison is off" };
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
      return getHost().getDiagnostics();
    } catch {
      return { status: "error" as ParakeetModelStatus };
    }
  });

  return { getHost };
}

/** Test seam: drop the host without leaving a utility process running. */
export function __resetParakeetHostForTests(): void {
  try {
    host?.dispose();
  } catch {
    /* already gone */
  }
  host = null;
}