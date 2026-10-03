import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ghostly", {
  // System Audio source fetcher
  getDesktopSources: (): Promise<{id: string, name: string}[]> =>
    ipcRenderer.invoke("ghostly:get-desktop-sources"),

  // Mouse click-through control
  enableMouse: (): void => ipcRenderer.send("ghostly:enable-mouse"),
  disableMouse: (): void => ipcRenderer.send("ghostly:disable-mouse"),

  // Window control
  hide: (): void => ipcRenderer.send("ghostly:hide"),
  show: (): void => ipcRenderer.send("ghostly:show"),

  // Capture
  captureFullscreen: (): Promise<string> =>
    ipcRenderer.invoke("ghostly:capture-fullscreen"),

  // Settings persistence
  getSettings: (): Promise<any> => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: any): Promise<void> =>
    ipcRenderer.invoke("save-settings", settings),

  // History persistence
  getHistory: (): Promise<any[]> => ipcRenderer.invoke("get-history"),
  saveHistory: (history: any[]): Promise<void> =>
    ipcRenderer.invoke("save-history", history),

  // ── Deepgram (optional second ASR engine) ──────────────────────────────
  // Deliberately exposes NO way to read the long-lived API key. The renderer
  // can ask whether one exists (boolean) and request a 30-second token minted
  // by the main process. See electron/deepgram.ts for why that indirection is
  // required rather than merely tidy: a browser WebSocket cannot send an
  // Authorization header, so a short-lived token is the only way to
  // authenticate a socket without exposing the secret.
  deepgramHasKey: (): Promise<boolean> =>
    ipcRenderer.invoke("deepgram:has-key"),

  deepgramToken: (): Promise<
    | { ok: true; token: string; expiresIn: number }
    | { ok: false; code: string; message: string }
  > => ipcRenderer.invoke("deepgram:token"),

  // ── Groq Whisper (optional third ASR engine, comparison only) ──────────
  // The long-lived key never crosses this boundary: the renderer can only ask
  // whether one is configured, set/replace one, and submit captured audio.
  groqAsrHasKey: (): Promise<boolean> =>
    ipcRenderer.invoke("groq:has-key"),

  groqSetKey: (value: string): Promise<{ ok: boolean; configured: boolean }> =>
    ipcRenderer.invoke("groq:set-key", value),

  groqTranscribe: (payload: {
    wav: ArrayBuffer;
    model?: string;
    language?: string;
    prompt?: string;
  }): Promise<any> => ipcRenderer.invoke("groq:transcribe", payload),

  // ── Dev-only screen visibility ───────────────────────────────────────
  // Runtime-only and dev-gated in the main process. Returns the mode that
  // actually took effect, which may differ from the request if it was
  // rejected (production build, or malformed input).
  setVisibility: (mode: "visible" | "hidden"): Promise<{
    ok: boolean;
    mode: "visible" | "hidden";
  }> => ipcRenderer.invoke("ghostly:set-visibility", mode),

  getVisibility: (): Promise<"visible" | "hidden"> =>
    ipcRenderer.invoke("ghostly:get-visibility"),

  // Events from main process (hotkeys)
  onScreenshot: (cb: (b64: string) => void): (() => void) => {
    const listener = (_: any, b64: string): void => cb(b64);
    ipcRenderer.on("ghostly:screenshot", listener);
    return () => ipcRenderer.removeListener("ghostly:screenshot", listener);
  },

  onSolve: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("ghostly:solve", listener);
    return () => ipcRenderer.removeListener("ghostly:solve", listener);
  },

  onStartOver: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("ghostly:start-over", listener);
    return () => ipcRenderer.removeListener("ghostly:start-over", listener);
  },

  onInterviewType: (type: string, cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on(`ghostly:interview-type-${type}`, listener);
    return () => ipcRenderer.removeListener(`ghostly:interview-type-${type}`, listener);
  },

  // Start / Stop Interview (Ctrl+I) and Next Question (Ctrl+N).
  onToggleInterview: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("ghostly:toggle-interview", listener);
    return () => ipcRenderer.removeListener("ghostly:toggle-interview", listener);
  },

  onNextQuestion: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("ghostly:next-question", listener);
    return () => ipcRenderer.removeListener("ghostly:next-question", listener);
  },
});
