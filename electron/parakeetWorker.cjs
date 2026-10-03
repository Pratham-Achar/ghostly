/**
 * Parakeet utility-process child — holds the model, nothing else.
 *
 * ── Why a separate process ─────────────────────────────────────────────────
 * The sherpa-onnx addon is a native module. It cannot be loaded in the renderer
 * (a Web Worker, where native addons are unavailable), and loading several
 * hundred megabytes of model into the main process would put a 6-second stall
 * and a large heap spike on the process that owns the UI and the window.
 * A `utilityProcess` gives it its own heap, its own lifecycle, and a clean
 * restart path, and it keeps the renderer and main process free of it.
 *
 * Plain CommonJS on purpose: this file is forked directly by Electron and is
 * NOT part of the electron-vite build, so it must not need bundling.
 *
 * Protocol (see `src/lib/parakeetHost.ts` for the typed contract):
 *   in : { id, type: "load" | "unload" | "transcribe", ... }
 *   out: { id, ok, type, text?, loadMs?, decodeMs?, rssMb?, code?, message? }
 *
 * Every failure is reported as a reply, never as a thrown exception, so a
 * broken model can never take this process — or Ghostly — down.
 */

"use strict";

const REQUIRED_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
];

/** Model is loaded on first use only. Nothing happens at spawn time. */
let recognizer = null;
let sherpa = null;
let loadedModelDir = null;

/** Replies on the parent channel. Named per the utilityProcess contract. */
function reply(message) {
  if (process.parentPort) {
    process.parentPort.postMessage(message);
  }
}

function rssMb() {
  return Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;
}

function fail(id, code, message) {
  reply({ id, ok: false, code, message });
}

function isModelComplete(dir) {
  const fs = require("node:fs");
  const path = require("node:path");
  try {
    return REQUIRED_FILES.every((f) => fs.existsSync(path.join(dir, f)));
  } catch {
    return false;
  }
}

function ensureModel(modelDir) {
  if (recognizer) return true;

  const numThreads = Number(process.env.PARAKEET_NUM_THREADS || 4);

  if (!isModelComplete(modelDir)) {
    throw Object.assign(new Error(`model not found at ${modelDir}`), {
      code: "model_missing",
    });
  }

  const path = require("node:path");
  sherpa = require("sherpa-onnx-node");

  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { samplingRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, "encoder.int8.onnx"),
        decoder: path.join(modelDir, "decoder.int8.onnx"),
        joiner: path.join(modelDir, "joiner.int8.onnx"),
      },
      tokens: path.join(modelDir, "tokens.txt"),
      numThreads,
      // CPU only, int8 only. Deliberately no GPU/CUDA path in this phase.
      provider: "cpu",
      debug: false,
    },
  });

  loadedModelDir = modelDir;
  return true;
}

function handleLoad(msg) {
  const started = Date.now();
  try {
    ensureModel(msg.modelDir);
    const loadMs = Date.now() - started;
    reply({
      id: msg.id,
      ok: true,
      type: "loaded",
      loadMs,
      rssMb: rssMb(),
    });
  } catch (err) {
    recognizer = null;
    fail(msg.id, err && err.code ? err.code : "crashed", err.message);
  }
}

function handleTranscribe(msg) {
  try {
    if (!recognizer) {
      fail(msg.id, "model_missing", "model was not loaded");
      return;
    }
    if (!(msg.samples instanceof Float32Array)) {
      fail(msg.id, "invalid_audio", "samples must be a Float32Array");
      return;
    }

    const sampleRate = msg.sampleRate || 16000;
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: msg.samples, sampleRate });

    const started = Date.now();
    recognizer.decode(stream);
    const decodeMs = Date.now() - started;

    const result = recognizer.getResult(stream);
    reply({
      id: msg.id,
      ok: true,
      type: "result",
      text: typeof result?.text === "string" ? result.text.trim() : "",
      decodeMs,
      rssMb: rssMb(),
    });
  } catch (err) {
    fail(msg.id, "crashed", err && err.message ? err.message : String(err));
  }
}

if (process.parentPort) {
  process.parentPort.on("message", (event) => {
    const msg = event && event.data ? event.data : event;
    if (!msg || typeof msg.id !== "number") return;
    switch (msg.type) {
      case "load":
        handleLoad(msg);
        break;
      case "transcribe":
        handleTranscribe(msg);
        break;
      case "unload":
        recognizer = null;
        loadedModelDir = null;
        reply({ id: msg.id, ok: true, type: "unloaded", rssMb: rssMb() });
        break;
      default:
        fail(msg.id, "malformed", `unknown request type: ${msg.type}`);
    }
  });
}

process.on("uncaughtException", (err) => {
  // Never die silently: the host would otherwise wait for a reply that can
  // never arrive. Report and keep serving.
  console.error("[Parakeet child] uncaught:", err && err.message);
});