/**
 * Region picker — a full-screen overlay the user drags a rectangle in.
 *
 * ── Why a separate window ───────────────────────────────────────────────────
 * The thing being watched is another application: the coding problem the
 * interviewer is looking at. Ghostly's own window cannot reliably sit on top of
 * an unrelated full-screen app and be interacted with, so the picker is its own
 * frameless window that exists only for the duration of the drag.
 *
 * ── Why the screen is captured as a frozen backdrop ─────────────────────────
 * The picker used to rely on `transparent: true` alone: the window was left
 * unpainted so the desktop showed through, and a 28% black wash was laid over
 * it. That design has three problems, all reported during manual testing.
 *
 *   1. It depends on the OS honouring window transparency. When it does not,
 *      the user gets a solid black rectangle and cannot select anything.
 *   2. The wash covered the WHOLE window, so the rectangle being drawn was
 *      dimmed exactly as much as everything outside it. There was no way to
 *      keep the selection bright while dimming its surroundings.
 *   3. There was no control over how strongly the surroundings were dimmed.
 *
 * So the primary display is captured ONCE, in memory, before the picker window
 * exists, and that frozen image becomes the picker's backdrop. The selection is
 * then a hole in the dim layer drawn over that image, so the selected area is
 * always at full brightness and everything else can be dimmed by any amount the
 * user chooses.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 * The capture is an in-memory data URL handed straight to a window that is
 * destroyed when the drag ends. It is never written to disk, never logged, and
 * never sent to any provider — the same guarantee the Live Screen watcher
 * gives. The only thing that survives this function is four numbers.
 */

import { BrowserWindow, desktopCapturer, ipcMain, screen } from "electron";
import type { ScreenRegionRect } from "./capture";

/**
 * Smallest drag treated as a region rather than a stray click. Below this the
 * picker cancels instead of watching a 0x0 rectangle forever.
 */
export const MIN_SELECTION_CSS_PX = 16;

/** Default dimming of everything OUTSIDE the selection. */
export const DEFAULT_OVERLAY_ALPHA = 0.4;
export const MIN_OVERLAY_ALPHA = 0.2;
export const MAX_OVERLAY_ALPHA = 0.7;

/**
 * Capture the primary display once, as a data URL, for use as the picker's
 * frozen backdrop.
 *
 * Returns null when the capture is unavailable for any reason — a platform that
 * refuses the source, an empty thumbnail, an exception. The picker still works
 * in that case; it simply falls back to a transparent window, which is the
 * behaviour this file had before.
 *
 * The caller must invoke this BEFORE creating the picker window, so the picker
 * can never appear in its own backdrop.
 */
export async function capturePickerBackdrop(
  displayId: number,
  deviceWidth: number,
  deviceHeight: number,
): Promise<string | null> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: deviceWidth, height: deviceHeight },
    });
    if (sources.length === 0) return null;
    // Prefer the display the picker is actually going to cover. Falling back to
    // the first screen source is what the existing full-screen capture does.
    const match =
      sources.find((s) => s.display_id === String(displayId)) ?? sources[0];
    if (!match.thumbnail || match.thumbnail.isEmpty()) return null;
    return match.thumbnail.toDataURL();
  } catch {
    return null;
  }
}

const PICKER_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0; height: 100%; overflow: hidden;
        background: transparent; cursor: crosshair;
        user-select: none; -webkit-user-select: none;
      }
      /* The frozen screen. Hidden until the main process hands it over, so a
         failed capture degrades to a plain transparent overlay rather than a
         broken image. */
      #shot {
        position: fixed; inset: 0; width: 100%; height: 100%;
        display: none; object-fit: fill; pointer-events: none;
      }
      /*
        The selection is a HOLE in the dim layer: a spread box-shadow paints the
        whole window EXCEPT the box itself. That is what keeps the selected area
        at full brightness while everything around it is dimmed, which the
        previous full-window wash could not do.
      */
      #box {
        position: fixed; display: none;
        border: 1px solid #7dd3fc;
        box-sizing: border-box;
        pointer-events: none;
      }
      #size {
        position: fixed; display: none; pointer-events: none;
        font: 11px ui-monospace, monospace; color: #e2e8f0;
        background: rgba(2,6,23,0.85); padding: 2px 6px; border-radius: 4px;
        white-space: nowrap;
      }
      #hint {
        position: fixed; left: 50%; top: 24px; transform: translateX(-50%);
        font: 12px ui-monospace, monospace; color: #e2e8f0;
        background: rgba(2,6,23,0.85); padding: 6px 12px; border-radius: 6px;
        pointer-events: none;
      }
      /* Small and out of the way. It changes ONLY how dark the area outside the
         selection looks — nothing about the rectangle that is returned. */
      #controls {
        position: fixed; right: 16px; bottom: 16px;
        display: flex; align-items: center; gap: 8px;
        font: 11px ui-monospace, monospace; color: #cbd5e1;
        background: rgba(2,6,23,0.85); padding: 6px 10px; border-radius: 6px;
        border: 1px solid rgba(148,163,184,0.25);
      }
      #opacity { width: 110px; accent-color: #7dd3fc; cursor: pointer; }
      #opacityValue { width: 34px; text-align: right; color: #e2e8f0; }
    </style>
  </head>
  <body>
    <img id="shot" alt="" />
    <div id="box"></div>
    <div id="size"></div>
    <div id="hint">Drag to select the problem area &middot; Esc to cancel</div>
    <div id="controls">
      <label for="opacity">Overlay opacity</label>
      <input id="opacity" type="range" min="${Math.round(
        MIN_OVERLAY_ALPHA * 100,
      )}" max="${Math.round(MAX_OVERLAY_ALPHA * 100)}" value="${Math.round(
        DEFAULT_OVERLAY_ALPHA * 100,
      )}" />
      <span id="opacityValue">${Math.round(
        DEFAULT_OVERLAY_ALPHA * 100,
      )}%</span>
    </div>
    <script>
      // Node integration is on for this window, so require() is available, but
      // ipcRenderer is NOT exposed as a bare global in modern Electron. The
      // script below used to reference the bare global, which threw a
      // ReferenceError inside the mouseup/Escape listeners: the rectangle was
      // never sent, no cancellation was sent either, and the promise never
      // settled. Pulling it off the electron module is what makes the drag
      // report its result.
      const { ipcRenderer } = require('electron');

      const MIN_SIZE = ${MIN_SELECTION_CSS_PX};
      const DEFAULT_ALPHA = ${DEFAULT_OVERLAY_ALPHA};
      const MIN_ALPHA = ${MIN_OVERLAY_ALPHA};
      const MAX_ALPHA = ${MAX_OVERLAY_ALPHA};

      const shot = document.getElementById('shot');
      const box = document.getElementById('box');
      const size = document.getElementById('size');
      const controls = document.getElementById('controls');
      const slider = document.getElementById('opacity');
      const sliderValue = document.getElementById('opacityValue');

      // Everything except the selection is dimmed by spreading the box's shadow
      // out past the edges of the display. The shadow colour is the ONLY thing
      // the opacity control touches — it can never move the rectangle.
      function spread() {
        return Math.max(window.innerWidth, window.innerHeight) + 400;
      }
      let alpha = DEFAULT_ALPHA;
      function applyAlpha() {
        box.style.boxShadow =
          '0 0 0 ' + spread() + 'px rgba(0,0,0,' + alpha + ')';
      }

      slider.addEventListener('input', function () {
        var pct = parseFloat(slider.value);
        if (isNaN(pct)) return;
        alpha = Math.min(MAX_ALPHA, Math.max(MIN_ALPHA, pct / 100));
        sliderValue.textContent = Math.round(alpha * 100) + '%';
        applyAlpha();
      });
      // Dragging the slider must never start (or finish) a rectangle.
      controls.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      controls.addEventListener('click', function (e) { e.stopPropagation(); });

      // The main process sets this after the page loads. Absent -> transparent
      // window, exactly the previous behaviour.
      window.__setBackdrop = function (dataUrl) {
        if (!dataUrl) return false;
        shot.src = dataUrl;
        shot.style.display = 'block';
        return true;
      };

      let start = null;
      function clamp(v, max) { return Math.max(0, Math.min(v, max)); }
      function rectFrom(a, b) {
        var x = clamp(Math.min(a.x, b.x), window.innerWidth);
        var y = clamp(Math.min(a.y, b.y), window.innerHeight);
        var w = clamp(Math.abs(b.x - a.x), window.innerWidth - x);
        var h = clamp(Math.abs(b.y - a.y), window.innerHeight - y);
        return { x: x, y: y, width: w, height: h };
      }
      function paint(r) {
        box.style.display = 'block';
        box.style.left = r.x + 'px';
        box.style.top = r.y + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
        applyAlpha();
        // Report the size the caller will actually receive: DEVICE pixels.
        var scale = window.devicePixelRatio || 1;
        size.style.display = 'block';
        size.style.left = r.x + 'px';
        size.style.top = Math.max(0, r.y - 20) + 'px';
        size.textContent =
          Math.round(r.width * scale) + ' \\u00d7 ' +
          Math.round(r.height * scale) + ' px';
      }

      document.addEventListener('mousedown', (e) => {
        if (e.target && e.target.closest && e.target.closest('#controls')) return;
        start = { x: e.clientX, y: e.clientY };
        paint({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
      });
      document.addEventListener('mousemove', (e) => {
        if (!start) return;
        paint(rectFrom(start, { x: e.clientX, y: e.clientY }));
      });
      document.addEventListener('mouseup', (e) => {
        if (!start) return;
        var r = rectFrom(start, { x: e.clientX, y: e.clientY });
        start = null;
        // A stray click is not a region; treat it as a cancel rather than
        // watching a 0x0 rectangle forever.
        if (r.width < MIN_SIZE || r.height < MIN_SIZE) {
          ipcRenderer.send('live-screen:region-cancelled');
          return;
        }
        ipcRenderer.send('live-screen:region-picked', r);
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

    // Captured BEFORE the window exists, so the picker can never be part of its
    // own backdrop. A failure here is not fatal: the picker falls back to a
    // transparent window.
    void capturePickerBackdrop(
      display.id,
      Math.round(width * scaleFactor),
      Math.round(height * scaleFactor),
    ).then((backdrop) => {
      const win = new BrowserWindow({
        x,
        y,
        width,
        height,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        show: false,
        webPreferences: {
          // This window loads ONLY the inline document above — no remote
          // content, no user data, and it is destroyed immediately after the
          // drag. Node integration is what lets the inline script report the
          // rectangle without shipping a second preload bundle for a window
          // that exists for one second.
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

      // Shown only once the page has loaded AND the backdrop has been handed
      // over, so the picker can never appear as a black flash.
      const reveal = () => {
        if (!win.isDestroyed() && !win.isVisible()) {
          win.show();
          win.focus();
        }
      };
      win.webContents.on("did-finish-load", () => {
        if (backdrop) {
          win.webContents
            .executeJavaScript(`window.__setBackdrop(${JSON.stringify(backdrop)})`)
            .then(reveal)
            .catch(reveal);
        } else {
          reveal();
        }
      });
      // A page that never loads must still show the picker: the promise below
      // is only ever settled by a result or by the window closing, so an
      // invisible window would leave the caller waiting forever.
      win.webContents.on("did-fail-load", reveal);
      win.on("closed", () => finish(null));

      win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PICKER_HTML)}`);
    });
  });
}
