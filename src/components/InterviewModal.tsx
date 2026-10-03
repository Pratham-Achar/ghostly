import React, { useState, useEffect, useRef } from "react";
import { useInterviewAudio } from "../hooks/useInterviewAudio";
import { useStore } from "../store/useStore";
import { getParakeetStatus, type ParakeetStatus } from "../lib/parakeetClient";
import type { InterviewTurn } from "../lib/interviewAgent";

interface InterviewModalProps {
  onClose: () => void;
  /**
   * Hands the *structured* turn to the answering agent: committed utterances
   * (what the interviewer finished saying) plus the in-progress line. The agent
   * decides which of those is a complete question.
   *
   * Optional candidate-signal and transcript-clear flags are forwarded to the
   * host so the same handler drives voice, manual text and candidate correction.
   */
  onSubmit: (
    turn: InterviewTurn,
    candidateSignal?: { text: string; timestamp?: number },
    clearTranscript?: boolean,
  ) => void;
  /** Collapsed = one bar. Capture keeps running, the answer gets the space. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export const InterviewModal: React.FC<InterviewModalProps> = ({
  onClose,
  onSubmit,
  collapsed = false,
  onToggleCollapse,
}) => {
  const {
    messages,
    interim,
    isRecording,
    logs,
    debugAudios,
    debugWavOn,
    setDebugWav,
    isModelReady,
    downloadProgress,
    startInterview,
    stopInterview,
  } = useInterviewAudio();
  const [showLogs, setShowLogs] = useState(false);
  // Developer-only engine comparison, read straight from the store.
  const asrComparisons = useStore((s) => s.asrComparisons);
  const asrCompareParakeet = useStore((s) => s.settings.asrCompareParakeet);
  const updateSettings = useStore((s) => s.updateSettings);
  // Model status for the dev panel. Polled only while the dev comparison is on:
  // the model loads on Start and unloads on Stop, so a slow poll is enough to
  // show "loading" rather than a stale "ready".
  const [parakeetStatus, setParakeetStatus] = useState<ParakeetStatus>("disabled");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!import.meta.env.DEV || !asrCompareParakeet) {
      setParakeetStatus("disabled");
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const status = await getParakeetStatus();
      if (!cancelled) setParakeetStatus(status);
    };
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [asrCompareParakeet]);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, interim]);

  // Manual typed question input (compact text field, Send on Enter).
  //
  // This is a MANUAL OVERRIDE / FALLBACK: it does NOT start audio capture,
  // does NOT stop capture, and does NOT touch Moonshine / Deepgram / Groq
  // Whisper. It is fed straight through the existing downstream AI pipeline
  // (`onSubmit` → `runAIStream`) as a manual question.
  const [manualText, setManualText] = useState("");
  // Prevents duplicate submissions from key auto-repeat without any timer.
  const manualSubmittedRef = useRef(false);

  // Handle manual submit
  const handleSubmit = () => {
    // Capture the turn BEFORE stopInterview() clears the interim line.
    const turn: InterviewTurn = {
      finals: messages.map((m) => ({ source: m.source, text: m.text })),
      interim: interim ? { source: interim.source, text: interim.text } : null,
    };
    stopInterview();
    onSubmit(turn);
  };

  /** Submit a manually typed question as an explicit override. */
  const handleManualSubmit = () => {
    const question = manualText.trim();
    // Empty / whitespace input is ignored.
    if (!question || manualSubmittedRef.current) return;
    manualSubmittedRef.current = true;

    // Preserve the submitted question in history (same store used by the voice
    // path), tagged as a MANUAL question so it renders like a detected question
    // without any audio capture involved.
    const addInterviewMessage = useStore((s) => s.addInterviewMessage);
    addInterviewMessage({
      id: crypto.randomUUID(),
      source: "system",
      text: question,
      timestamp: Date.now(),
    });

    // Build a turn containing ONLY this manual question. Because it is a fresh
    // turn, the old voice text is NOT automatically combined with it.
    // `clearTranscript` is false here: the manual message was already added to
    // the store, and this is an explicit override not a fresh voice session.
    const turn: InterviewTurn = {
      finals: [{ source: "system", text: question }],
      interim: null,
    };
    onSubmit(turn, undefined, false);

    setManualText("");
    manualSubmittedRef.current = false;
  };

  const handleClose = () => {
    stopInterview();
    onClose();
  };

  const lastLine = messages[messages.length - 1]?.text;

  // Collapsed: keep the panel mounted (so audio capture keeps running) but
  // reduce it to a single bar, because the transcript is not what you are
  // reading during an answer.
  if (collapsed) {
    return (
      <div
        className="pointer-events-auto rounded-2xl px-4 py-2 flex items-center justify-between gap-3 w-full"
        style={{
          background: "rgba(20, 20, 23, 0.75)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
        onMouseEnter={() => window.ghostly.enableMouse()}
        onMouseLeave={() => window.ghostly.disableMouse()}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative flex h-2.5 w-2.5 flex-none">
            {isRecording && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isRecording ? "bg-red-500" : "bg-white/20"}`}
            />
          </span>
          <span className="text-white/70 font-semibold text-[11px] font-mono flex-none">
            Live Interview
          </span>
          <span className="text-[10px] text-white/30 font-mono truncate">
            {interim?.text
              ? `${interim.text}▍`
              : (lastLine ?? "listening…")}
          </span>
        </div>
        <button
          onClick={onToggleCollapse}
          className="flex-none px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[10px] font-mono transition-colors"
        >
          Expand ⤢
        </button>
      </div>
    );
  }

  return (
    <div
      className="pointer-events-auto rounded-2xl overflow-hidden flex flex-col transition-all duration-300 w-full"
      style={{
        background: "rgba(20, 20, 23, 0.75)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 10px 40px -10px rgba(0,0,0,0.5)",
      }}
      onMouseEnter={() => window.ghostly.enableMouse()}
      onMouseLeave={() => window.ghostly.disableMouse()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.05] bg-white/[0.02]">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              {isRecording && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              )}
              <span
                className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isRecording ? "bg-red-500" : "bg-white/20"}`}
              ></span>
            </span>
            <h2 className="text-white/90 font-semibold text-xs font-mono">
              Live Interview
            </h2>
          </div>
          <span className="text-white/30 text-[10px] font-mono hidden sm:inline">
            | System audio (Interviewer only)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleCollapse}
            title="Collapse — keeps listening, gives the answer more room"
            className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[10px] transition-colors"
          >
            Collapse ⤡
          </button>
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[10px] transition-colors"
          >
            {showLogs ? "Hide Debug" : "Debug"}
          </button>
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-500/20 hover:text-red-400 text-white/60 transition-colors text-xs"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Download Progress Bar */}
      {!isModelReady && (
        <div className="px-4 py-2.5 border-b border-white/[0.05] bg-black/20">
          {downloadProgress !== null ? (
            <>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-white/50 font-mono">
                  Downloading model...
                </span>
                <span className="text-[10px] text-white/70 font-mono tabular-nums">
                  {downloadProgress}%
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${downloadProgress}%`,
                    background:
                      "linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa)",
                    boxShadow: "0 0 8px rgba(139, 92, 246, 0.6)",
                  }}
                />
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex gap-0.5">
                <span
                  className="w-1 h-1 rounded-full bg-white/30 animate-bounce"
                  style={{ animationDelay: "0ms" }}
                />
                <span
                  className="w-1 h-1 rounded-full bg-white/30 animate-bounce"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="w-1 h-1 rounded-full bg-white/30 animate-bounce"
                  style={{ animationDelay: "300ms" }}
                />
              </div>
              <span className="text-[10px] text-white/40 font-mono">
                Initializing AI engine...
              </span>
            </div>
          )}
        </div>
      )}

      {/* Main Content Area */}
      {/* Capped height (its own scroll) so the transcript can never squeeze the
          answer area out of the window. */}
      <div className="flex w-full" style={{ height: "min(320px, 35vh)" }}>
        {/* Chat Interface */}
        <div
          className={`flex flex-col h-full transition-all duration-300 ${showLogs ? "w-[60%] border-r border-white/[0.05]" : "w-full"}`}
        >
          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && !interim && (
              <div className="h-full flex flex-col items-center justify-center text-white/30 text-xs space-y-1 font-mono">
                <p>No audio captured yet.</p>
                <p className="text-[10px] text-white/20">
                  Click Start below to begin.
                </p>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex w-full ${msg.source === "mic" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 flex flex-col ${
                    msg.source === "mic"
                      ? "bg-blue-500/10 text-blue-100 border border-blue-500/20 rounded-br-sm"
                      : "bg-white/[0.03] text-white/80 border border-white/[0.05] rounded-bl-sm"
                  }`}
                >
                  <div className="text-[9px] opacity-50 mb-0.5 font-sans uppercase tracking-wider">
                    {msg.source === "mic" ? "You" : "Interviewer"}
                  </div>
                  <div className="text-xs leading-relaxed">{msg.text}</div>
                </div>
              </div>
            ))}
            {/* Live interim line — appears while the interviewer is still
                speaking and is replaced by the final message. */}
            {interim && (
              <div className="flex w-full justify-start">
                <div className="max-w-[85%] rounded-xl rounded-bl-sm px-3 py-2 flex flex-col bg-white/[0.02] border border-dashed border-white/[0.12]">
                  <div className="text-[9px] opacity-50 mb-0.5 font-sans uppercase tracking-wider flex items-center gap-1.5">
                    {interim.source === "mic" ? "You" : "Interviewer"}
                    <span className="text-[8px] text-accent/70 normal-case tracking-normal">
                      transcribing…
                    </span>
                  </div>
                  <div className="text-xs leading-relaxed text-white/55 italic">
                    {interim.text}
                    <span className="animate-pulse text-white/60">▍</span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Manual typed question (compact input + Send on Enter) — a manual
              override / fallback. Does not start or stop capture; goes through the
              same downstream AI pipeline as voice. */}
          <div className="px-3 pb-1">
            <form
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                handleManualSubmit();
              }}
              className="flex items-center gap-2"
            >
              <input
                autoFocus={false}
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                onKeyDown={(e) => {
                  // Enter submits; Shift+Enter is a no-op (single-line input).
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleManualSubmit();
                  }
                }}
                placeholder="Type interviewer question..."
                className="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-[11px] text-white placeholder-white/30 font-mono focus:border-accent/40 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!manualText.trim() || manualSubmittedRef.current}
                className="flex-none px-3 py-1.5 rounded-lg bg-accent/15 hover:bg-accent/25 disabled:opacity-30 text-accent font-medium text-[11px] transition-colors"
              >
                Send
              </button>
            </form>
          </div>

          {/* Controls */}
          <div className="p-3 bg-black/20 border-t border-white/[0.05] flex items-center justify-between">
            <div className="flex items-center gap-2">
              {!isRecording ? (
                <button
                  onClick={startInterview}
                  disabled={!isModelReady}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/90 hover:bg-green-400 disabled:bg-white/10 disabled:text-white/30 text-black font-semibold rounded text-xs transition-all"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-black/50" />
                  {isModelReady
                    ? "Start"
                    : downloadProgress !== null
                      ? `${downloadProgress}%`
                      : "Loading..."}
                </button>
              ) : (
                <button
                  onClick={stopInterview}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 font-semibold rounded text-xs transition-all"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                  Stop
                </button>
              )}
            </div>

            <button
              onClick={handleSubmit}
              disabled={messages.length === 0 && !interim?.text.trim()}
              className="px-4 py-1.5 bg-white/10 hover:bg-white/20 disabled:opacity-30 text-white font-medium rounded text-xs transition-colors flex items-center gap-1.5"
            >
              Ask Copilot 🚀
            </button>
          </div>
        </div>

        {/* Dev Logs Panel */}
        {showLogs && (
          <div className="w-[40%] bg-black/40 flex flex-col">
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              {/* ── ASR comparison (dev only) ─────────────────────────── */}
              {/* Both engines transcribe the SAME captured buffer, so the
                  difference is the engine, not the audio. */}
              {import.meta.env.DEV && asrComparisons.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[9px] text-white/40 uppercase tracking-wider font-semibold">
                    ASR comparison (same audio):
                  </div>
                  {asrComparisons.map((c) => {
                    // The Parakeet column is only rendered while the dev
                    // comparison is on, so a shipped build never shows a cell
                    // for an engine that was never run.
                    const showParakeet = !!asrCompareParakeet;
                    const t = c.deepgramTelemetry;
                    const g = c.groqTelemetry;
                    const ms = (v: number | null | undefined) =>
                      v === null || v === undefined ? "-" : `${Math.round(v)}ms`;
                    const groqCorrected =
                      c.groqCorrectedText && c.groqCorrectedText !== c.groqText
                        ? c.groqCorrectedText
                        : null;
                    return (
                      <div
                        key={c.id}
                        className="bg-white/[0.02] p-1.5 rounded border border-white/[0.05] space-y-1"
                      >
                        <div className="text-[9px] text-white/40">
                          {c.audioSeconds.toFixed(1)}s audio
                        </div>
                        <div
                          className={`grid gap-1.5 text-[9px] ${showParakeet ? "grid-cols-4" : "grid-cols-3"}`}
                        >
                          <div>
                            <div className="text-white/40 mb-0.5">Moonshine</div>
                            <div className="text-white/70">
                              {c.moonshineText || "(pending)"}
                            </div>
                          </div>
                          <div>
                            <div className="text-white/40 mb-0.5">
                              Deepgram{` ${ms(t?.firstInterimMs)}`}
                            </div>
                            <div className="text-white/70">
                              {c.deepgramText || "(not run)"}
                            </div>
                          </div>
                          <div>
                            <div className="text-white/40 mb-0.5">
                              Groq Whisper{` ${ms(g?.firstResultMs)}`}
                            </div>
                            <div className="text-white/70">
                              {c.groqText || "(not run)"}
                            </div>
                            {groqCorrected && (
                              <div className="text-emerald-300/70 mt-0.5">
                                corrected: {groqCorrected}
                              </div>
                            )}
                          </div>
                          {showParakeet && (
                            <div>
                              <div className="text-white/40 mb-0.5">
                                Parakeet{` ${ms(c.parakeetMs)}`}
                              </div>
                              <div className="text-white/70">
                                {c.parakeetText ||
                                  (c.parakeetStatus && c.parakeetStatus !== "ok"
                                    ? `(${c.parakeetStatus})`
                                    : "(pending)")}
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="text-[8px] text-white/30">
                          {`dg final ${ms(t?.firstFinalMs)} · speech_final ${ms(t?.speechFinalMs)} · total ${ms(t?.totalMs)}`}
                          {`  ·  groq http ${g?.httpStatus ?? "-"} · ${g?.success ? "ok" : g?.failureReason ?? "-"} · ${ms(g?.totalMs)}`}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Parakeet comparison (dev only) ───────────────────── */}
              {/* A DEVELOPMENT COMPARISON ENGINE, off by default. The model is
                  ~631 MB and costs several hundred MB of resident memory, so
                  it is loaded on Start and released on Stop. Moonshine remains
                  the production engine: this column never feeds the transcript,
                  the question gate or the AI. */}
              {import.meta.env.DEV && (
                <label className="flex items-start gap-2 text-[9px] text-white/50 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={!!asrCompareParakeet}
                    onChange={(e) =>
                      updateSettings({ asrCompareParakeet: e.target.checked })
                    }
                    className="accent-white/60 mt-0.5"
                  />
                  <span>
                    Compare with local Parakeet (dev only — Moonshine stays the
                    engine that reaches the AI)
                    <span className="block text-white/30 mt-0.5">
                      status: {parakeetStatus}
                    </span>
                  </span>
                </label>
              )}

              {/* Audio Debugger */}
              {/* Recording interview audio is opt-in and dev-only. The toggle
                  is here, behind the Debug panel, because that is where
                  someone would go looking for it. */}
              <label className="flex items-center gap-2 text-[9px] text-white/50 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={debugWavOn}
                  onChange={(e) => setDebugWav(e.target.checked)}
                  className="accent-white/60"
                />
                <span>
                  Record debug WAV (local only — never uploaded or written to
                  disk)
                </span>
              </label>

              {debugAudios.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[9px] text-white/40 uppercase tracking-wider font-semibold">
                    Raw Audio:
                  </div>
                  {debugAudios.map((da, i) => (
                    <div
                      key={i}
                      className="bg-white/[0.02] p-1.5 rounded border border-white/[0.05]"
                    >
                      <div className="text-[9px] text-white/60 mb-1">
                        {da.name}
                      </div>
                      <audio
                        controls
                        src={da.url}
                        className="h-5 w-full"
                        style={{ filter: "invert(100%)" }}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Text Logs */}
              <div className="space-y-0.5 font-mono text-[9px] text-white/50">
                <div className="text-[9px] text-white/40 uppercase tracking-wider font-semibold mb-1.5 mt-3">
                  Logs:
                </div>
                {logs.map((log, i) => (
                  <div
                    key={i}
                    className={`break-words ${log.includes("WARNING") ? "text-yellow-400" : ""}`}
                  >
                    {log}
                  </div>
                ))}
                {logs.length === 0 && (
                  <div className="italic opacity-30">Waiting for logs...</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
