import { ipcMain, desktopCapturer, session, app } from "electron";
import { captureFullScreen } from "./capture";
import { registerDeepgramHandlers } from "./deepgram";
import { registerGroqAsrHandlers } from "./groqAsr";
import { registerParakeetHandlers } from "./parakeetAsr";
import { registerAsrExportHandlers } from "./asrExport";
import { registerDebugClipHandlers } from "./debugClipWriter";
import Store from "electron-store";

const store = new Store({
  name: "ghostly-data",
  encryptionKey: "ghostly-secure-key-v1",
  defaults: {
    // NOTE: these defaults must stay in sync with `useStore`'s defaults.
    // They used to say `providerOrder: ["groq", "gemini"]` with no OpenRouter
    // entry at all, which meant a store that had never been written to handed
    // the renderer a Groq-first chain — the live interview path then ran on
    // Groq while the UI claimed OpenRouter was configured.
    settings: {
      activeProvider: "openrouter",
      models: {
        gemini: "gemini-2.5-flash",
        openai: "gpt-4o",
        anthropic: "claude-3-5-sonnet-20241022",
        groq: "openai/gpt-oss-120b",
        // Free ROUTER — OpenRouter picks the concrete model per request.
        openrouter: "openrouter/free",
        nvidia: "meta/llama-3.3-70b-instruct",
      },
      // OpenRouter first; Groq / NVIDIA / Gemini as independent secondaries.
      providerOrder: ["openrouter", "groq", "nvidia", "gemini"],
      interviewType: "dsa",
      language: "python",
      apiKeys: {
        gemini: "",
        openai: "",
        anthropic: "",
        groq: "",
        openrouter: "",
        nvidia: "",
      },
      // Optional second ASR engine. Ghostly runs fully on local Moonshine
      // without this. Read ONLY in the main process (see electron/deepgram.ts).
      deepgramKey: "",
    },
    history: [],
    // Groq Whisper ASR key — TOP-LEVEL, deliberately outside `settings`.
    // The renderer persists the whole settings object, so nesting a secret in
    // it would round-trip the key through the renderer. See electron/groqAsr.ts.
    groqAsrKey: "",
  },
});

export function registerIpcHandlers(): void {
  // Grants navigator.mediaDevices.getDisplayMedia() a screen with system-audio
  // loopback, so the renderer can transcribe the interviewer's voice. Using
  // this handler avoids the flaky legacy `chromeMediaSource: 'desktop'` path.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"], fetchWindowIcons: false })
        .then((sources) => {
          const screenSource =
            sources.find((s) => s.name.includes("Screen")) ?? sources[0];
          if (!screenSource) {
            console.error("No screen source available for display capture");
            callback({});
            return;
          }
          callback({ video: screenSource, audio: "loopback" });
        })
        .catch((error) => {
          console.error("Failed to resolve display media source:", error);
          callback({});
        });
    },
  );

  // Desktop sources for audio capture
  ipcMain.handle("ghostly:get-desktop-sources", async () => {
    try {
      const sources = await desktopCapturer.getSources({ 
        types: ["screen", "window"],
        fetchWindowIcons: false 
      });
      return sources.map((s) => ({ id: s.id, name: s.name }));
    } catch (error) {
      console.error("Failed to get desktop sources:", error);
      throw error;
    }
  });

  // Full-screen capture
  ipcMain.handle("ghostly:capture-fullscreen", async () => {
    try {
      return await captureFullScreen();
    } catch (error) {
      console.error("Failed to capture fullscreen:", error);
      throw error;
    }
  });

  // Legacy capture handlers (kept for compatibility)
  ipcMain.handle("capture-screen", async () => {
    try {
      return await captureFullScreen();
    } catch (error) {
      console.error("Failed to capture screen:", error);
      throw error;
    }
  });

  // Settings
  ipcMain.handle("get-settings", () => {
    return store.get("settings");
  });

  ipcMain.handle("save-settings", (_event, settings: any) => {
    store.set("settings", settings);
  });

  // History
  ipcMain.handle("get-history", () => {
    return store.get("history") || [];
  });

  ipcMain.handle("save-history", (_event, history: any[]) => {
    store.set("history", history);
  });

  // Deepgram short-lived token minting. The long-lived API key is read from the
  // store HERE and only a 30s JWT crosses the IPC boundary. See electron/deepgram.ts.
  registerDeepgramHandlers(store);

  // Groq Whisper ASR (comparison only). The long-lived key never crosses the
  // IPC boundary — the main process performs the request. See electron/groqAsr.ts.
  registerGroqAsrHandlers(store);

  // Dev-only: write captured debug clips + the comparison JSON into a
  // timestamped `debug-audio/<session>/` folder (gitignored). Only ever called
  // by the explicit "Save all debug clips" button — nothing is written
  // automatically, and nothing is uploaded.
  registerDebugClipHandlers();

  // Dev-only: write the `asrComparisons` export to JSON for offline
  // benchmarking. Moonshine runs in a Web Worker and cannot be driven from the
  // Node harness, so its results have to come out of a live session — this is
  // the only path that gets them out. Engine text and numbers, never audio.
  registerAsrExportHandlers({
    resolveDir: () => app.getPath("userData"),
  });

  // Parakeet (DEVELOPMENT COMPARISON ENGINE ONLY). Off unless the dev setting is
  // on, and hard-disabled in a packaged build — so a shipped app never even
  // resolves the model directory, let alone loads several hundred MB of it.
  //
  // The flag is read from the same persisted `settings` blob the renderer
  // writes, rather than duplicated here, so there is exactly one switch.
  registerParakeetHandlers({
    isEnabled: () =>
      !app.isPackaged &&
      process.env.NODE_ENV !== "production" &&
      (store.get("settings") as { asrCompareParakeet?: boolean } | undefined)
        ?.asrCompareParakeet === true,
    modelDir: store.get("parakeetModelDir") as string | undefined,
  });
}
