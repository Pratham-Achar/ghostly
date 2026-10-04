import React, { useCallback, useEffect, useState } from "react";

/**
 * Live Screen — the one visible control for the live-screen feature.
 *
 * ── Why this is a small panel and not a settings page ──────────────────────
 * The whole point is that the candidate can tell at a glance whether Ghostly
 * attached the right context. A panel buried in Settings cannot do that job.
 *
 * ── It never shows screen content ──────────────────────────────────────────
 * The status line reports counts and reasons. The only screen-derived text that
 * reaches the UI is a problem statement the user can explicitly accept, and
 * even that waits for a click — the same rule the rest of the context chip
 * follows.
 *
 * ── Why nothing is automatic ───────────────────────────────────────────────
 * The feature can propose a problem read off the screen. It cannot install one.
 * An auto-applied screen read would be able to replace a correct problem with a
 * misread one, and the candidate would have no way to tell it had happened.
 */

export interface LiveScreenStatus {
  enabled: boolean;
  region: { x: number; y: number; width: number; height: number } | null;
  on: string;
  regionLabel: string;
  ocrLabel: string;
  contextLabel: string;
  ocrAvailable: boolean;
  ocrUnavailableReason: string | null;
  polls: number;
  reads: number;
  framesSkipped: number;
  lastError: string | null;
}

const OFF: LiveScreenStatus = {
  enabled: false,
  region: null,
  on: "LIVE SCREEN: OFF",
  regionLabel: "Region: None",
  ocrLabel: "OCR: Local",
  contextLabel: "Context: None",
  ocrAvailable: true,
  ocrUnavailableReason: null,
  polls: 0,
  reads: 0,
  framesSkipped: 0,
  lastError: null,
};

export interface LiveScreenPanelProps {
  /** Apply a problem statement the user accepted. Called on click only. */
  onUseProblem: (text: string) => void;
  /** True while transcription is live, so the UI can say why reads are paused. */
  asrBusy: boolean;
  /** Reset Interview must also clear the watched region. */
  resetSignal?: number;
}

export const LiveScreenPanel: React.FC<LiveScreenPanelProps> = ({
  onUseProblem,
  asrBusy,
  resetSignal,
}) => {
  const [status, setStatus] = useState<LiveScreenStatus>(OFF);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void window.ghostly
      .liveScreenStatus()
      .then((next) => setStatus(next as LiveScreenStatus))
      .catch(() => setStatus(OFF));
  }, []);

  useEffect(() => {
    refresh();
    const offProblem = window.ghostly.onLiveScreenProblem((update) => {
      // A read that decides the problem is UNCHANGED clears any pending offer,
      // so a stale suggestion cannot sit there waiting to be accepted later.
      setPending(update.problemText);
    });
    const offStatus = window.ghostly.onLiveScreenStatusChanged(() => refresh());
    return () => {
      offProblem();
      offStatus();
    };
  }, [refresh]);

  // Transcription wins over context freshness; the main process is told so it
  // can skip reads entirely rather than merely pausing them.
  useEffect(() => {
    void window.ghostly.liveScreenAsrBusy(asrBusy).catch(() => undefined);
  }, [asrBusy]);

  // Reset Interview forgets the region too.
  useEffect(() => {
    if (resetSignal === undefined) return;
    void window.ghostly.liveScreenReset().catch(() => undefined);
    setPending(null);
    refresh();
  }, [resetSignal, refresh]);

  const toggle = async () => {
    setBusy(true);
    try {
      await window.ghostly.liveScreenConfigure({ enabled: !status.enabled });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const pickRegion = async () => {
    setBusy(true);
    try {
      const region = await window.ghostly.liveScreenPickRegion();
      if (region) {
        await window.ghostly.liveScreenConfigure({ region });
        setPending(null);
        refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || !status.ocrAvailable;

  return (
    <div
      className="px-2 py-1.5 rounded-lg space-y-1"
      style={{
        background: "rgba(120, 140, 200, 0.08)",
        border: "1px solid rgba(140, 160, 220, 0.18)",
      }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        {/* The ON/OFF state is spelled out in words, not implied by a colour,
            so it is readable at a glance and to a screen reader. */}
        <span
          className="text-[9px] uppercase tracking-wider flex-none font-semibold"
          style={{ color: status.enabled ? "#86efac" : "rgba(255,255,255,0.35)" }}
        >
          {status.on}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={pickRegion}
          disabled={disabled}
          className="flex-none px-1.5 py-0.5 rounded bg-white/[0.06] hover:bg-white/[0.12] text-[9px] font-mono text-white/50 disabled:opacity-40"
          title="Drag out the area of the screen holding the problem."
        >
          {status.region ? "Re-select" : "Select region"}
        </button>
        <button
          type="button"
          onClick={toggle}
          disabled={busy || !status.ocrAvailable || !status.region}
          className="flex-none px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[9px] font-mono text-white/80 disabled:opacity-40"
          title={
            status.region
              ? "Watch the selected region."
              : "Choose a region first."
          }
        >
          {status.enabled ? "Off" : "On"}
        </button>
      </div>

      <div className="flex items-center gap-2 text-[8px] font-mono text-white/35">
        <span>{status.regionLabel}</span>
        <span>{status.ocrLabel}</span>
        <span>{status.contextLabel}</span>
      </div>

      {!status.ocrAvailable && (
        <div className="text-[8px] font-mono text-amber-300/70">
          Local OCR is unavailable on this machine. Windows OCR needs an OCR
          language pack (Settings → Language → Optional features).
        </div>
      )}

      {asrBusy && status.enabled && (
        <div className="text-[8px] font-mono text-white/30">
          Paused while transcription is running.
        </div>
      )}

      {status.lastError && (
        <div className="text-[8px] font-mono text-white/30 truncate">
          Last error: {status.lastError}
        </div>
      )}

      {/* Never applied without a click — see the component doc comment. */}
      {pending && (
        <div className="space-y-1 pt-0.5">
          <div className="text-[9px] font-mono text-white/55 line-clamp-3">
            {pending}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onUseProblem(pending);
                setPending(null);
              }}
              className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[9px] font-mono text-white/80"
              title="Replaces the active problem with the text read from the screen."
            >
              Use as context
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="px-2 py-0.5 rounded bg-white/[0.06] hover:bg-white/[0.12] text-[9px] font-mono text-white/50"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
};