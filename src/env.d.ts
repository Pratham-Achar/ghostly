/// <reference types="vite/client" />

interface Window {
  ghostly: {
    getDesktopSources: () => Promise<{ id: string; name: string }[]>;
    enableMouse: () => void;
    disableMouse: () => void;
    hide: () => void;
    show: () => void;
    captureFullscreen: () => Promise<string>;

    // Settings
    getSettings: () => Promise<any>;
    saveSettings: (settings: any) => Promise<void>;

    // History
    getHistory: () => Promise<any[]>;
    saveHistory: (history: any[]) => Promise<void>;

    // Events
    onScreenshot: (cb: (b64: string) => void) => () => void;
    onSolve: (cb: () => void) => () => void;
    onStartOver: (cb: () => void) => () => void;
    onInterviewType: (type: string, cb: () => void) => () => void;

    // Start / Stop Interview (Ctrl+I) and Next Question (Ctrl+N).
    onToggleInterview: (cb: () => void) => () => void;
    onNextQuestion: (cb: () => void) => () => void;

    // Deepgram (optional second ASR engine).
    //
    // Note what is ABSENT: there is no `getDeepgramKey`. The renderer can
    // only learn whether a key exists, and can request a short-lived token.
    deepgramHasKey: () => Promise<boolean>;
    deepgramToken: () => Promise<
      | { ok: true; token: string; expiresIn: number }
      | { ok: false; code: string; message: string }
    >;

    // ── Groq Whisper (optional THIRD ASR engine, comparison only) ──────
    //
    // As with Deepgram, there is NO method that returns the long-lived key.
    // The renderer can learn whether a key is configured and can SET one, but
    // the request itself is performed in the main process.
    groqAsrHasKey: () => Promise<boolean>;
    groqSetKey: (value: string) => Promise<{ ok: boolean; configured: boolean }>;
    groqTranscribe: (payload: {
      wav: ArrayBuffer;
      model?: string;
      language?: string;
      prompt?: string;
    }) => Promise<
      | {
          ok: true;
          result: {
            provider: "groq";
            model: string;
            text: string;
            audioSeconds: number;
            latencyMs: number;
            firstResultMs: number | null;
            segments: Array<{
              id: number;
              start: number;
              end: number;
              text: string;
            }>;
          };
          telemetry: {
            provider: "groq";
            model: string;
            audioSeconds: number;
            requestStartMs: number;
            firstResultMs: number | null;
            totalMs: number;
            httpStatus: number | null;
            success: boolean;
            failureReason: string | null;
            chars: number;
            segmentCount: number;
          };
          httpStatus: number;
        }
      | {
          ok: false;
          code: string;
          httpStatus: number | null;
          telemetry: {
            provider: "groq";
            model: string;
            audioSeconds: number;
            requestStartMs: number;
            firstResultMs: number | null;
            totalMs: number;
            httpStatus: number | null;
            success: boolean;
            failureReason: string | null;
            chars: number;
            segmentCount: number;
          };
          message: string;
        }
    >;

    // ── Dev-only ASR comparison export ────────────────────────────────
    // Writes engine text + numbers to a JSON file at a path chosen by the MAIN
    // process. There is no audio in this path.
    writeAsrComparisonExport: (json: string) => Promise<{
      ok: boolean;
      path?: string;
      bytes?: number;
      message?: string;
    }>;

    // ── Parakeet (DEVELOPMENT COMPARISON ENGINE ONLY) ────────────────
    //
    // Mirrors the ASR-engine pattern: the renderer hands over audio it has
    // already captured and receives a transcript. There is no handle to the
    // model, no path to it, and no way to make it part of the live pipeline.
    // The main process refuses all of this unless the dev setting is on and
    // the app is not packaged.
    parakeetStatus: () => Promise<{
      status: "disabled" | "missing" | "loading" | "ready" | "error";
    }>;
    parakeetLoad: () => Promise<{
      ok: boolean;
      loadMs?: number;
      rssMb?: number;
      code?: string;
      message?: string;
      status?: string;
    }>;
    parakeetUnload: () => Promise<{ ok: boolean }>;
    parakeetTranscribe: (payload: {
      samples: Float32Array;
      sampleRate: number;
    }) => Promise<{
      ok: boolean;
      text?: string;
      decodeMs?: number;
      loadMs?: number;
      rssMb?: number;
      rtf?: number;
      code?: string;
      message?: string;
    }>;
    parakeetDiagnostics: () => Promise<{
      status: string;
      loadMs: number | null;
      rssMb: number | null;
      queued: number;
      inFlight: number;
      consecutiveFailures: number;
    }>;

    // ── Dev-only screen visibility ────────────────────────────────────
    // Runtime-only (not persisted) and refused by the main process in a
    // packaged build.
    setVisibility: (
      mode: "visible" | "hidden",
    ) => Promise<{ ok: boolean; mode: "visible" | "hidden" }>;
    getVisibility: () => Promise<"visible" | "hidden">;
  };
}
