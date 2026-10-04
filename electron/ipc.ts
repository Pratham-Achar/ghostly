import { ipcMain, desktopCapturer, session, app } from "electron";
import { captureFullScreen } from "./capture";
import { registerDeepgramHandlers } from "./deepgram";
import { registerGroqAsrHandlers } from "./groqAsr";
import { registerParakeetHandlers, resolveModelDir } from "./parakeetAsr";
import { registerAsrExportHandlers } from "./asrExport";
import { registerNvidiaAiHandlers } from "./nvidiaAi";
import { registerDebugClipHandlers } from "./debugClipWriter";
import {
  configureLiveScreen,
  getLiveScreenSnapshot,
  resetLiveScreen,
  setLiveScreenAsrBusy,
} from "./liveScreen";
import { pickScreenRegion } from "./regionPicker";
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
  // ── Live Screen ─────────────────────────────────────────────────────────
  // Deliberately narrow: the renderer can point the watcher at a region, switch
  // it on and off, and read a status snapshot. There is no channel that returns
  // pixels, because the frames are captured, compared and read inside the main
  // process and are never meant to exist anywhere else. See electron/liveScreen.ts.
  ipcMain.handle(
    "ghostly:live-screen-configure",
    (_event, config: { region?: { x: number; y: number; width: number; height: number } | null; enabled?: boolean }) => {
      configureLiveScreen(config ?? {});
    },
  );

  ipcMain.handle("ghostly:live-screen-status", () => getLiveScreenSnapshot());

  ipcMain.handle("ghostly:live-screen-asr-busy", (_event, busy: boolean) => {
    setLiveScreenAsrBusy(Boolean(busy));
  });

  ipcMain.handle("ghostly:live-screen-reset", () => {
    resetLiveScreen();
  });

  ipcMain.handle("ghostly:live-screen-pick-region", () => pickScreenRegion());
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

  // NVIDIA NIM, for the same reason as Groq ASR: the renderer's fetch is
  // blocked by CORS on every turn, so the request runs here, and the key is
  // read from this store rather than being passed in by the renderer.
  registerNvidiaAiHandlers(store);

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

  // ── Parakeet ─────────────────────────────────────────────────────────────
  //
  // Two INDEPENDENT ways in, read from the same persisted `settings` blob the
  // renderer writes — not from zustand, which lives in the renderer and never
  // crosses the process boundary. That was the original bug: the toggle updated
  // a renderer-side store and the main process, which is what actually decides,
  // never saw it.
  //
  //   1. `primaryAsr === "parakeet"` — the user chose Parakeet in Settings.
  //      Allowed in a packaged build, because the model is downloaded into
  //      userData at the user's own request rather than shipped in the installer.
  //
  //   2. `asrCompareParakeet === true` — the dev-only comparison column. Still
  //      hard-disabled when packaged, so a shipped app never resolves a model
  //      directory it has no business touching.
  //
  // Note (1) is deliberately allowed in production. It is NOT an implicit
  // default: it only takes effect after an explicit user selection, and the code
  // default written into the store is `"moonshine"`.
  registerParakeetHandlers({
    isEnabled: () => {
      const settings = store.get("settings") as
        | { asrCompareParakeet?: boolean; primaryAsr?: string }
        | undefined;
      if (!settings) return false;
      if (settings.primaryAsr === "parakeet") return true;
      return (
        !app.isPackaged &&
        process.env.NODE_ENV !== "production" &&
        settings.asrCompareParakeet === true
      );
    },
    isPrimary: () =>
      (store.get("settings") as { primaryAsr?: string } | undefined)
        ?.primaryAsr === "parakeet",
    modelDir: resolveModelDir({
      override: store.get("parakeetModelDir") as string | undefined,
      userDataDir: app.getPath("userData"),
    }),
    paddingMs: () =>
      (store.get("settings") as { parakeetPaddingMs?: number } | undefined)
        ?.parakeetPaddingMs,
  });
}
