import { globalShortcut, BrowserWindow } from "electron";
import { captureFullScreen } from "./capture";

const MOVE_STEP = 25;

// Simple mutex to prevent race conditions between hotkeys
let isBusy = false;

export function registerHotkeys(win: BrowserWindow): void {
  // Helper: show window
  const showWindow = () => {
    win.setOpacity(1);
    win.setIgnoreMouseEvents(true, { forward: true });
    win.focus();
  };

  // Helper: hide window
  const hideWindow = () => {
    win.setOpacity(0);
    win.blur();
    win.setIgnoreMouseEvents(true, { forward: false });
  };

  // Screenshot — Ctrl+H (hides window briefly, captures, restores)
  globalShortcut.register("CommandOrControl+H", async () => {
    if (isBusy) return;
    isBusy = true;
    try {
      const wasVisible = win.getOpacity() > 0;
      if (wasVisible) {
        hideWindow();
      }

      await new Promise((r) => setTimeout(r, 150));

      const base64 = await captureFullScreen();

      if (wasVisible) {
        showWindow();
      }
      win.webContents.send("ghostly:screenshot", base64);
      console.log("[Ghostly] Screenshot captured and sent to renderer");
    } catch (err) {
      console.error("[Ghostly] Failed to capture screen:", err);
      // Always restore window visibility on error
      if (win.getOpacity() === 0) {
        showWindow();
      }
    } finally {
      isBusy = false;
    }
  });

  // Quick Capture — Ctrl+Shift+C (captures without hiding window)
  globalShortcut.register("CommandOrControl+Shift+C", async () => {
    if (isBusy) return;
    isBusy = true;
    try {
      const base64 = await captureFullScreen();
      win.webContents.send("ghostly:screenshot", base64);
      console.log("[Ghostly] Quick capture sent to renderer");
    } catch (err) {
      console.error("[Ghostly] Quick capture failed:", err);
    } finally {
      isBusy = false;
    }
  });

  // Solve / Ask AI — Ctrl+Enter (shows window if hidden, then solves)
  globalShortcut.register("CommandOrControl+Return", () => {
    if (win.getOpacity() === 0) {
      showWindow();
    }
    win.focus();
    win.webContents.send("ghostly:solve");
  });

  // Show / Hide — Ctrl+B
  globalShortcut.register("CommandOrControl+B", () => {
    if (win.getOpacity() > 0) {
      hideWindow();
    } else {
      showWindow();
    }
  });

  // Start Over — Ctrl+G
  globalShortcut.register("CommandOrControl+G", () => {
    win.webContents.send("ghostly:start-over");
  });

  // Start / Stop Interview — Ctrl+I
  // Toggles the existing capture lifecycle. When the interview panel is closed
  // the renderer opens it and starts as soon as the ASR model is ready; it
  // never opens a second capture stream. Deliberately NOT Ctrl+Enter (Ask AI).
  globalShortcut.register("CommandOrControl+I", () => {
    win.webContents.send("ghostly:toggle-interview");
  });

  // Next Question — Ctrl+N
  // Resets the current interview question state only. It never starts/stops
  // capture and never submits the question to the AI.
  globalShortcut.register("CommandOrControl+N", () => {
    win.webContents.send("ghostly:next-question");
  });

  // Interview Type Shortcuts — Ctrl+Shift+1/2/3/4/5/6
  const interviewTypes: Record<string, string> = {
    "1": "dsa",
    "2": "system_design",
    "3": "frontend",
    "4": "sql",
    "5": "behavioral",
    "6": "general",
  };

  for (const [key, type] of Object.entries(interviewTypes)) {
    const reg = globalShortcut.register(`CommandOrControl+Shift+${key}`, () => {
      win.webContents.send(`ghostly:interview-type-${type}`);
      console.log(`[Ghostly] Interview type set to: ${type}`);
    });
    console.log(`[Ghostly] Ctrl+Shift+${key} registered for ${type}:`, reg);
  }

  // Move Up/Down/Left/Right (Ctrl + arrow keys)
  globalShortcut.register("CommandOrControl+Up", () => {
    const [x, y] = win.getPosition();
    win.setPosition(x, y - MOVE_STEP);
  });
  globalShortcut.register("CommandOrControl+Down", () => {
    const [x, y] = win.getPosition();
    win.setPosition(x, y + MOVE_STEP);
  });
  globalShortcut.register("CommandOrControl+Left", () => {
    const [x, y] = win.getPosition();
    win.setPosition(x - MOVE_STEP, y);
  });
  globalShortcut.register("CommandOrControl+Right", () => {
    const [x, y] = win.getPosition();
    win.setPosition(x + MOVE_STEP, y);
  });

  console.log("[Ghostly] All hotkeys registered");
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
}
