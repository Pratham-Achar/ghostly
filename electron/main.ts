import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  screen,
  ipcMain,
} from "electron";
import path from "path";
import { registerHotkeys, unregisterHotkeys, captureAndSendScreenshot } from "./hotkeys";
import { registerIpcHandlers } from "./ipc";
import { initLiveScreen } from "./liveScreen";
import { applyStealthMode, removeStealthMode } from "./stealth";
import {
  createVisibilityController,
  STEALTH_REAPPLY_EVENTS,
  type VisibilityController,
  type VisibilityMode,
} from "./visibilityPolicy";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

/**
 * Re-apply stealth mode. Called on every show event to ensure
 * the window stays invisible to screen capture at all times.
 */
/**
 * Every registered window gets a visibility controller.
 *
 * The controller owns the current mode; the re-apply handlers ask it what to
 * do rather than calling `applyStealthMode` directly. That is what makes
 * show/focus/restore respect the mode — while `visible`, a re-assert clears
 * capture exclusion instead of re-adding it, which is what would otherwise
 * silently un-hide the window the moment it was shown.
 */
const visibilityControllers = new WeakMap<BrowserWindow, VisibilityController>();

function controllerFor(win: BrowserWindow): VisibilityController {
  const existing = visibilityControllers.get(win);
  if (existing) return existing;
  const controller = createVisibilityController({
    apply: () => applyStealthMode(win),
    remove: () => removeStealthMode(win),
    // The single canonical visibility log line. Never any other content.
    log: (line) => console.log(line),
  });
  visibilityControllers.set(win, controller);
  return controller;
}

function enforceStealthOnWindow(win: BrowserWindow): void {
  // Assert the current mode immediately, so the window starts in the mode it
  // is actually in rather than assuming `hidden`.
  controllerFor(win);

  // Re-apply on every event that can drop the window affinity. Iterating the
  // shared list keeps this in step with the tested policy.
  //
  // Electron types `BrowserWindow.on` as a long list of per-event overloads
  // with no generic string fallback, so the literal union from
  // `STEALTH_REAPPLY_EVENTS` matches none of them individually. The cast is
  // safe: every value in that list IS a real BrowserWindow event, and the list
  // is asserted in `verify-stealth.mts`.
  const reapply = () => controllerFor(win).reapply();
  for (const event of STEALTH_REAPPLY_EVENTS) {
    win.on(event as "show", reapply);
  }
}

function createMainWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay().workAreaSize;
  const BAR_WIDTH = 900;
  const BAR_HEIGHT = 900;

  const win = new BrowserWindow({
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    x: Math.floor((primary.width - BAR_WIDTH) / 2),
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Workspace & z-order
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, "screen-saver");

  // Click-through by default — only settings gear + solution panel enable mouse
  win.setIgnoreMouseEvents(true, { forward: true });

  // *** CRITICAL: re-apply stealth on EVERY show/focus/restore ***
  enforceStealthOnWindow(win);

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  // Forward renderer console/errors to terminal for debugging
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[Renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`[Renderer] Load FAILED: ${errorCode} - ${errorDescription}`);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[Renderer] Process GONE: ${details.reason} (exitCode=${details.exitCode})`);
  });

  win.on("ready-to-show", () => {
    const bounds = win.getBounds();
    const opacity = win.getOpacity();
    console.log(`[Ghostly] Window ready — bounds: ${JSON.stringify(bounds)}, opacity: ${opacity}`);
    win.show();
    console.log(`[Ghostly] After show — visible: ${win.isVisible()}, opacity: ${win.getOpacity()}`);
    // Assert the current visibility mode (also re-applied via the show event).
    controllerFor(win).reapply();
  });

  return win;
}

function toggleWindowVisibility() {
  if (mainWindow) {
    const isHidden = mainWindow.getOpacity() === 0;
    if (isHidden) {
      mainWindow.setOpacity(1);
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      mainWindow.focus();
    } else {
      mainWindow.setOpacity(0);
      mainWindow.blur();
      mainWindow.setIgnoreMouseEvents(true, { forward: false });
    }
  }
}

function createTray(): Tray {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAY0lEQVR4nGNgGAXDBTAiC/z//5/h////DIyMjAxMTEwMYPr/fwYGBgYGBkZGRgYmRiADyIYJMDExAeUYGRmgcowgGsgGqWFkZASpYWJiAqthBOrBAKgaGA3igzCQP7xdMwoAAD6OI0GqswYnAAAAAElFTkSuQmCC",
  );

  const t = new Tray(icon);
  t.setToolTip("Ghostly — Stealth AI Assistant");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show/Hide Ghostly",
      click: toggleWindowVisibility,
    },
    {
      label: "Capture Screen",
      // Must go through the SAME capture the Ctrl+H hotkey uses. This used to
      // emit `ghostly:screenshot` with no payload, which appended `undefined`
      // to the renderer's screenshot list: Solve then sent a prompt that asked
      // for "the problem in the screenshot" while attaching no screenshot at
      // all, so no answer ever arrived.
      click: () => {
        if (mainWindow) {
          void captureAndSendScreenshot(mainWindow);
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit Ghostly",
      click: () => app.quit(),
    },
  ]);

  t.setContextMenu(contextMenu);
  t.on("click", toggleWindowVisibility);

  return t;
}

app.whenReady().then(() => {
  registerIpcHandlers();
  // Live Screen reports upward through the window. The controller itself holds
  // no Electron reference, which keeps its capture-and-compare loop testable.
  initLiveScreen({
    onProblem: (update) =>
      mainWindow?.webContents.send("ghostly:live-screen-problem", update),
    onStatus: () =>
      mainWindow?.webContents.send("ghostly:live-screen-status-changed"),
  });
  mainWindow = createMainWindow();
  tray = createTray();
  registerHotkeys(mainWindow);

  // Mouse enable/disable for click-through
  ipcMain.on("ghostly:enable-mouse", () => {
    // Only enable if window is actually "visible"
    if (mainWindow && mainWindow.getOpacity() > 0) {
      mainWindow.setIgnoreMouseEvents(false);
    }
  });

  ipcMain.on("ghostly:disable-mouse", () => {
    // Only forward hover events if window is actually "visible"
    if (mainWindow) {
      const isVisible = mainWindow.getOpacity() > 0;
      mainWindow.setIgnoreMouseEvents(true, { forward: isVisible });
    }
  });

  // Window control
  ipcMain.on("ghostly:hide", () => {
    if (mainWindow) {
      mainWindow.setOpacity(0);
      mainWindow.blur();
      mainWindow.setIgnoreMouseEvents(true, { forward: false });
    }
  });

  ipcMain.on("ghostly:show", () => {
    if (mainWindow) {
      mainWindow.setOpacity(1);
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      mainWindow.focus();
    }
  });

  // ── Dev-only screen-visibility toggle ───────────────────────────────────
  //
  // RUNTIME-ONLY by design (requirement: persistence is only safe if the
  // existing architecture allows it, and it does not). Persisting this would
  // mean a developer could ship a build that is visible in screen capture and
  // only discover it after restarting. Runtime-only also guarantees the app
  // comes back `hidden` on every launch, which is the safe default.
  //
  // Gated on a dev build so it cannot be driven in production at all. The
  // renderer toggle is hidden too, but this is the enforcing half: a
  // tampered renderer cannot flip it in a release build.
  ipcMain.handle("ghostly:set-visibility", (_event, requested: unknown) => {
    if (!app.isPackaged && process.env.NODE_ENV !== "production") {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) {
        return { ok: false as const, mode: "hidden" as VisibilityMode };
      }
      // Unknown input normalizes to `hidden` — see visibilityPolicy.
      const mode = controllerFor(win).set(requested);
      return { ok: true as const, mode };
    }
    // Production: report the current (always hidden) mode, change nothing.
    return { ok: false as const, mode: "hidden" as VisibilityMode };
  });

  ipcMain.handle("ghostly:get-visibility", () => {
    const win = BrowserWindow.getAllWindows()[0];
    return win ? controllerFor(win).current() : "hidden";
  });

  // Move window
  ipcMain.on("ghostly:move", (_event, dx: number, dy: number) => {
    if (mainWindow) {
      const [x, y] = mainWindow.getPosition();
      mainWindow.setPosition(x + dx, y + dy);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  unregisterHotkeys();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
  }
});
