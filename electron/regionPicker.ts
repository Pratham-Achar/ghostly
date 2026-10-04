/**
 * Region picker — a full-screen overlay the user drags a rectangle in.
 *
 * ── Why a separate window ─────────────────────────────────────────────────
 * The thing being watched is another application: the coding problem the
 * interviewer is looking at. Ghostly's own window cannot reliably sit on top of
 * an unrelated full-screen app and be interacted with, so the picker is its own
 * frameless transparent window that exists only for the duration of the drag.
 *
 * ── It captures nothing ────────────────────────────────────────────────────
 * There is no screenshot behind the overlay and no canvas. The user sees a
 * dimmed version of whatever is on screen because the window is transparent,
 * not because the screen was read. Once the rectangle is chosen the window is
 * destroyed, and the only thing that survives is four numbers.
 */

import { BrowserWindow, ipcMain, screen } from "electron";
import type { ScreenRegionRect } from "./capture";

const PICKER_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
      /* A faint wash so the selection is legible over any wallpaper, without
         hiding what the user is selecting. */
      #shade { position: fixed; inset: 0; background: rgba(0,0,0,0.28); }
      #box {
        position: fixed; display: none;
        border: 1px solid #7dd3fc; background: rgba(125,211,252,0.12);
        box-shadow: 0 0 0 9999px rgba(0,0,0,0.0);
      }
      #hint {
        position: fixed; left: 50%; top: 24px; transform: translateX(-50%);
        font: 12px ui-monospace, monospace; color: #e2e8f0;
        background: rgba(2,6,23,0.85); padding: 6px 12px; border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <div id="shade"></div>
    <div id="box"></div>
    <div id="hint">Drag to select the problem area &middot; Esc to cancel</div>
    <script>
      const box = document.getElementById('box');
      let start = null;
      function clamp(v, max) { return Math.max(0, Math.min(v, max)); }
      document.addEventListener('mousedown', (e) => {
        start = { x: e.clientX, y: e.clientY };
        box.style.display = 'block';
      });
      document.addEventListener('mousemove', (e) => {
        if (!start) return;
        const x = clamp(Math.min(start.x, e.clientX), window.innerWidth);
        const y = clamp(Math.min(start.y, e.clientY), window.innerHeight);
        const w = clamp(Math.abs(e.clientX - start.x), window.innerWidth - x);
        const h = clamp(Math.abs(e.clientY - start.y), window.innerHeight - y);
        box.style.left = x + 'px'; box.style.top = y + 'px';
        box.style.width = w + 'px'; box.style.height = h + 'px';
      });
      document.addEventListener('mouseup', (e) => {
        if (!start) return;
        const rect = box.getBoundingClientRect();
        start = null;
        // A stray click is not a region; treat it as a cancel rather than
        // watching a 0x0 rectangle forever.
        if (rect.width < 16 || rect.height < 16) {
          ipcRenderer.send('live-screen:region-cancelled');
          return;
        }
        ipcRenderer.send('live-screen:region-picked', {
          x: rect.left, y: rect.top, width: rect.width, height: rect.height,
        });
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') ipcRenderer.send('live-screen:region-cancelled');
      });
    </script>
  </body>
</html>`;

/**
 * Ask the user to drag out a rectangle.
 *
 * @returns the rectangle in DEVICE pixels (GDI's coordinate space), or null if
 * the user cancelled or the drag was too small to be meaningful.
 */
export function pickScreenRegion(): Promise<ScreenRegionRect | null> {
  return new Promise((resolve) => {
    const display = screen.getPrimaryDisplay();
    const { x, y, width, height } = display.bounds;
    const { scaleFactor } = display;

    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        // This window loads ONLY the inline document above — no remote content,
        // no user data, and it is destroyed immediately after the drag. Node
        // integration is what lets the inline script report the rectangle
        // without shipping a second preload bundle for a window that exists for
        // one second.
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    let settled = false;
    const finish = (rect: ScreenRegionRect | null) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("live-screen:region-picked", onPicked);
      ipcMain.removeListener("live-screen:region-cancelled", onCancelled);
      if (!win.isDestroyed()) win.destroy();
      resolve(rect);
    };
    const onPicked = (_event: unknown, cssRect: ScreenRegionRect) =>
      finish({
        x: x + Math.round(cssRect.x * scaleFactor),
        y: y + Math.round(cssRect.y * scaleFactor),
        width: Math.round(cssRect.width * scaleFactor),
        height: Math.round(cssRect.height * scaleFactor),
      });
    const onCancelled = () => finish(null);

    ipcMain.once("live-screen:region-picked", onPicked);
    ipcMain.once("live-screen:region-cancelled", onCancelled);

    win.once("ready-to-show", () => {
      win.show();
      win.focus();
    });
    win.on("closed", () => finish(null));

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PICKER_HTML)}`);
  });
}