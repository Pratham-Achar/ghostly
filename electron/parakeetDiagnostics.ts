import { ParakeetHost } from "../src/lib/parakeetHost";
import { readSystemMemory, formatBytesMb } from "../src/lib/systemMemory";

/**
 * Dev-only Parakeet memory/latency sampler.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 * The open question about Parakeet is not accuracy, it is memory: the model
 * costs several hundred MB of resident memory on a machine that has roughly
 * 8 GB and is already running a video call. Whether that is acceptable cannot
 * be answered by a Phase 1 number taken on an idle-ish box. It needs a live
 * reading from DURING an interview, sampled repeatedly, next to the system
 * figure — because "the model uses 650 MB" and "the system had 395 MB left"
 * together mean something very different from the first number alone.
 *
 * ── Where it samples and why ───────────────────────────────────────────────
 * This runs in the MAIN process, and that is not incidental. The renderer cannot
 * read system memory at all: it is an untrusted web context with no `os` module
 * and no preload bridge to the OS counters. A sampler written in the renderer
 * could only ever report the host's own numbers and would look like it was doing
 * something it structurally cannot.
 *
 * ── What it deliberately never logs ────────────────────────────────────────
 * No transcript text, no audio, no captured samples. Only numbers: memory,
 * process size, latency, throughput. This log is expected to be pasted into
 * issue reports and read while an interview is running, so it must not be able
 * to leak what was said.
 *
 * ── Dev-only ───────────────────────────────────────────────────────────────
 * The caller must gate it on the same dev flag as the rest of Parakeet; see
 * `registerParakeetHandlers`. This module itself holds no timer until
 * `startParakeetDiagnostics` is called.
 */

/** How often a sample line is emitted. */
export const PARAKEET_DIAGNOSTICS_INTERVAL_MS = 10_000;

export interface ParakeetDiagnosticsOptions {
  getHost: () => ParakeetHost;
  /** Emitted line sink. Defaults to `console.log`. */
  log?: (line: string) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface ParakeetDiagnosticsHandle {
  stop: () => void;
}

export function startParakeetDiagnostics(
  options: ParakeetDiagnosticsOptions,
): ParakeetDiagnosticsHandle {
  const log = options.log ?? ((line: string) => console.log(line));
  const setIntervalImpl =
    options.setInterval ?? ((fn, ms) => setInterval(fn, ms) as unknown);
  const clearIntervalImpl =
    options.clearInterval ?? ((handle) => clearInterval(handle as never));

  // A baseline, so every sample reports the DELTA the model is responsible for.
  // An absolute system figure alone cannot distinguish "Parakeet took 650 MB"
  // from "the box was already nearly full".
  const baseline = readSystemMemory();

  log(
    `[Parakeet-DIAG] baseline: total=${formatBytesMb(baseline.totalMb)} ` +
      `available=${formatBytesMb(baseline.availableMb)} ` +
      `used=${formatBytesMb(baseline.usedMb)} (${baseline.usedPercent}%)`,
  );

  const sample = (): void => {
    let diagnostics;
    try {
      diagnostics = options.getHost().getDiagnostics();
    } catch (err) {
      // A diagnostics sampler that can throw would take the app down while
      // someone is mid-interview. Report and keep sampling.
      log(
        `[Parakeet-DIAG] sample failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const memory = readSystemMemory();
    // Negative if memory was freed since the baseline (e.g. the idle unload
    // fired); clamp so a negative figure never reads as a bug.
    const rawDelta = baseline.availableMb - memory.availableMb;
    const deltaMb = Math.max(0, rawDelta);
    // Sub-MB swings are ordinary allocator and background-process noise. A
    // child RSS figure of ~700 MB sits NEXT to this number on the same line, so
    // reporting "the model cost 1 MB" would invite the reader to trust a
    // meaningless figure. Below the threshold, say nothing was attributable.
    const deltaLabel =
      deltaMb < 1 ? "<1 (noise)" : formatBytesMb(deltaMb);

    const parts = [
      `t=${new Date().toLocaleTimeString()}`,
      `status=${diagnostics.status}`,
      `sysAvail=${formatBytesMb(memory.availableMb)}`,
      `sysUsed=${formatBytesMb(memory.usedMb)}/${memory.totalMb}MB`,
      `usedPct=${memory.usedPercent}%`,
      `deltaSinceBaseline=${deltaLabel}`,
      `childRss=${formatBytesMb(diagnostics.rssMb)}`,
      `decodeMs=${diagnostics.decodeMs ?? "-"}`,
      // RTF is rounded here: a full float prints ~17 digits, which is noise in
      // a line a human is meant to scan.
      `rtf=${diagnostics.rtf === null || diagnostics.rtf === undefined ? "-" : diagnostics.rtf.toFixed(3)}`,
      `queued=${diagnostics.queued}`,
      `inFlight=${diagnostics.inFlight}`,
      `fails=${diagnostics.consecutiveFailures}`,
    ];
    log(`[Parakeet-DIAG] ${parts.join(" ")}`);
  };

  const handle = setIntervalImpl(sample, PARAKEET_DIAGNOSTICS_INTERVAL_MS);

  return {
    stop: () => {
      clearIntervalImpl(handle);
      log("[Parakeet-DIAG] stopped");
    },
  };
}