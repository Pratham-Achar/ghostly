/**
 * Regression harness for the Select Region IPC path.
 *
 * Run: `npx tsx scripts/verify-region-picker.ts`
 *
 * The path under test is exactly the one that broke:
 *
 *   renderer button
 *     -> preload invoke("ghostly:live-screen-pick-region")
 *     -> ipcMain.handle(...) -> pickScreenRegion()
 *     -> picker page sends "live-screen:region-picked"
 *     -> promise resolves with a device-pixel rect
 *
 * Two independent breakages are guarded:
 *
 *   1. The picker page referenced `ipcRenderer` as a bare global. Node
 *      integration is on for that window, but modern Electron does not expose
 *      `ipcRenderer` as a global, so every drag threw inside the mouseup
 *      listener and no result (and no cancellation) ever came back — the
 *      promise hung until the window was destroyed.
 *
 *   2. The panel button lived inside a `pointer-events-none` subtree while the
 *      Electron window ignored mouse events, so the click never reached the
 *      handler in the first place.
 *
 * Part A is a real end-to-end run of the ACTUAL picker under Electron and
 * asserts the returned rectangle matches the CSS rect scaled to device pixels.
 * Part B checks the renderer/`webPreferences` wiring Electron cannot exercise
 * from this harness.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";

let pass = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`  ${name}\n    expected: ${b}\n    actual:   ${a}`);
}
function checkTrue(name: string, cond: boolean): void {
  check(name, cond, true);
}

const root = process.cwd();
const read = (p: string): string => readFileSync(path.join(root, p), "utf8");

// ── Part A: real end-to-end run of the picker under Electron ───────────────

const tmpDir = path.join(root, ".verify-region-picker");
const driverTs = path.join(tmpDir, "driver.ts");
const driverCjs = path.join(tmpDir, "driver.cjs");

const DRIVER = `
import { app, BrowserWindow, screen } from "electron";
import { pickScreenRegion } from "../electron/regionPicker";

function emit(payload: unknown, code: number): void {
  console.log("RESULT:" + JSON.stringify(payload));
  app.exit(code);
}

// Reads the picker page's visual state, moves the opacity slider, THEN drags.
// Every visual property is captured before mouseup so the DOM still exists.
// Reads the picker page's visual state, moves the opacity slider, THEN drags.
// EVERY read happens before the mouseup: dispatching it resolves the promise in
// the main process, which destroys the window synchronously, and any read
// after that would race the teardown.
const PROBE = "(function(){" +
  "var shot=document.getElementById('shot');" +
  "var box=document.getElementById('box');" +
  "var slider=document.getElementById('opacity');" +
  "var label=document.getElementById('opacityValue');" +
  "var sMin=slider.min, sMax=slider.max, sDefault=slider.value;" +
  "document.dispatchEvent(new MouseEvent('mousedown',{clientX:120,clientY:90,bubbles:true}));" +
  "document.dispatchEvent(new MouseEvent('mousemove',{clientX:420,clientY:330,bubbles:true}));" +
  // The dim is applied by the first paint of the drag, so it is only
  // observable after the box exists.
  "var shadowBefore=box.style.boxShadow;" +
  "slider.value='70'; slider.dispatchEvent(new Event('input',{bubbles:true}));" +
  "var shadowAfter=box.style.boxShadow; var labelAfter=label.textContent;" +
  "var r=box.getBoundingClientRect();" +
  "var out={cssRect:{x:r.left,y:r.top,width:r.width,height:r.height}," +
  "shotDisplay:getComputedStyle(shot).display, shotLen:(shot.src||'').length," +
  "boxBg:getComputedStyle(box).backgroundColor," +
  "shadowBefore:shadowBefore, shadowAfter:shadowAfter," +
  "sMin:sMin, sMax:sMax, sDefault:sDefault, labelAfter:labelAfter," +
  "sizeLabel:document.getElementById('size').textContent," +
  "hasShade:!!document.getElementById('shade')};" +
  "document.dispatchEvent(new MouseEvent('mouseup',{clientX:420,clientY:330,bubbles:true}));" +
  "return out;})()";

const ESCAPE =
  "(function(){document.dispatchEvent(new KeyboardEvent('keydown'," +
  "{key:'Escape',bubbles:true}));return true;})()";

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const first = pickScreenRegion();

  setTimeout(() => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      emit({ error: "picker window was not created" }, 1);
      return;
    }
    const visible = win.isVisible();
    let page: any = null;
    win.webContents.executeJavaScript(PROBE)
      .then((result: any) => {
        page = result;
        const timeout = new Promise((res) => setTimeout(() => res(null), 8000));
        return Promise.race([first, timeout]);
      })
      .then((rect: any) => {
        // Second round: Escape must cancel cleanly and resolve to null.
        const second = pickScreenRegion();
        setTimeout(() => {
          const w2 = BrowserWindow.getAllWindows()[0];
          if (!w2) {
            emit({ error: "second picker window was not created" }, 1);
            return;
          }
          w2.webContents.executeJavaScript(ESCAPE)
            .then(() => {
              const t2 = new Promise((res) => setTimeout(() => res("TIMEOUT"), 8000));
              return Promise.race([second, t2]);
            })
            .then((cancelRect: any) => {
              emit(
                {
                  visible,
                  displayBounds: display.bounds,
                  scaleFactor: display.scaleFactor,
                  page,
                  rect,
                  cancelRect,
                  windowsAfter: BrowserWindow.getAllWindows().length,
                },
                rect && cancelRect === null ? 0 : 1,
              );
            })
            .catch((e: unknown) => emit({ error: String(e) }, 1));
        }, 3500);
        return rect;
      })
      .catch((e: unknown) => emit({ error: String(e) }, 1));
  }, 2500);
});

app.on("window-all-closed", () => {
  /* keep the probe alive until it has emitted its result */
});
`;

let e2e: Record<string, any> | null = null;
try {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(driverTs, DRIVER, "utf8");
  buildSync({
    entryPoints: [driverTs],
    outfile: driverCjs,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    logLevel: "silent",
  });

  // `require("electron")` in this Node process is the path to the Electron
  // binary, not the Electron API.
  const electronPath = require("electron") as unknown as string;
  let output = "";
  try {
    output = execFileSync(electronPath, [driverCjs], {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
  }
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.includes("RESULT:"));
  checkTrue("A1 the Electron driver returned a result", Boolean(line));
  if (!line) {
    // Surface why: a silent harness that swallows the driver's output is how a
    // real picker failure gets mistaken for a broken test.
    console.log("\n--- electron driver output ---");
    console.log(output.split(/\r?\n/).slice(-40).join("\n"));
    console.log("--- end driver output ---\n");
  }
  if (line) e2e = JSON.parse(line.slice(line.indexOf("RESULT:") + "RESULT:".length));
} catch (err) {
  failures.push(`  A0 the Electron picker run could not start: ${String(err)}`);
} finally {
  if (!process.env.KEEP_DRIVER) rmSync(tmpDir, { recursive: true, force: true });
}

if (e2e) {
  const page = (e2e.page ?? {}) as Record<string, any>;
  checkTrue("A2 the picker window was created", !e2e.error);
  checkTrue("A3 the picker window was shown", e2e.visible === true);
  checkTrue("A4 the drag crossed IPC and resolved a rect", e2e.rect !== null && e2e.rect !== undefined);
  if (e2e.rect) {
    const db = e2e.displayBounds as { x: number; y: number };
    const sf = e2e.scaleFactor as number;
    const css = page.cssRect as { x: number; y: number; width: number; height: number };
    check("A5 x is the display offset plus the scaled CSS x", e2e.rect.x, db.x + Math.round(css.x * sf));
    check("A6 y is the display offset plus the scaled CSS y", e2e.rect.y, db.y + Math.round(css.y * sf));
    check("A7 width is the scaled CSS width", e2e.rect.width, Math.round(css.width * sf));
    check("A8 height is the scaled CSS height", e2e.rect.height, Math.round(css.height * sf));
    checkTrue("A9 the rect is a real region", e2e.rect.width >= 16 && e2e.rect.height >= 16);
  }
  // The picker must destroy itself once the drag settles.
  check("A10 the picker closed after resolving", e2e.windowsAfter, 0);
  // Escape must cancel and resolve null rather than hang or return a rect.
  check("A11 Escape cancels and resolves null", e2e.cancelRect, null);

  // ── The screen is actually shown, not a black window ────────────────────
  check("A12 the frozen screen backdrop is displayed", page.shotDisplay, "block");
  checkTrue(
    "A13 the backdrop carries the captured screen image",
    typeof page.shotLen === "number" && page.shotLen > 1000,
  );
  checkTrue(
    "A14 there is no full-window black shade layer left",
    page.hasShade === false,
  );
  // The dimming must be a HOLE around the selection, not a wash over it.
  check("A15 the selection box itself is not filled", page.boxBg, "rgba(0, 0, 0, 0)");
  checkTrue(
    "A16 the selection is outlined by a visible border",
    /#box[\s\S]{0,200}border:\s*1px solid/.test(read("electron/regionPicker.ts")),
  );
  checkTrue(
    "A17 the dim is a spread shadow around the selection (keeps the hole bright)",
    typeof page.shadowBefore === "string" && /rgba\(0,\s*0,\s*0,\s*0\.4\)/.test(page.shadowBefore),
  );
  checkTrue(
    "A18 moving the opacity slider changes only the dim colour",
    typeof page.shadowAfter === "string" &&
      /rgba\(0,\s*0,\s*0,\s*0\.7\)/.test(page.shadowAfter) &&
      page.shadowAfter !== page.shadowBefore,
  );
  // ── Opacity control ──────────────────────────────────────────────────────
  check("A19 the opacity slider spans 20%-70%", [page.sMin, page.sMax], ["20", "70"]);
  check("A20 the opacity slider defaults to 40%", page.sDefault, "40");
  check("A21 the opacity readout follows the slider", page.labelAfter, "70%");
  // ── Size readout ─────────────────────────────────────────────────────────
  checkTrue(
    "A22 the drag reports a width x height readout",
    typeof page.sizeLabel === "string" && /\d+ \u00d7 \d+ px/.test(page.sizeLabel),
  );
}

// ── Part B: wiring Electron cannot drive from here ─────────────────────────

const panel = read("src/components/LiveScreenPanel.tsx");
checkTrue(
  "B1 the panel opts into pointer events, or the button cannot be hit-tested",
  /pointer-events-auto/.test(panel),
);
checkTrue("B2 the panel enables OS mouse on hover", /window\.ghostly\.enableMouse\(\)/.test(panel));
checkTrue("B3 the panel disables OS mouse on leave", /window\.ghostly\.disableMouse\(\)/.test(panel));

const preload = read("electron/preload.ts");
checkTrue(
  "B4 the preload exposes liveScreenPickRegion on the pick-region channel",
  /liveScreenPickRegion[\s\S]{0,200}?ghostly:live-screen-pick-region/.test(preload),
);

const ipc = read("electron/ipc.ts");
checkTrue(
  "B5 the main process registers the pick-region handler",
  /ipcMain\.handle\(\s*["']ghostly:live-screen-pick-region["']/.test(ipc),
);

const picker = read("electron/regionPicker.ts");
checkTrue(
  "B6 the picker page obtains ipcRenderer from the electron module, not a bare global",
  /const\s*\{\s*ipcRenderer\s*\}\s*=\s*require\(\s*['"]electron['"]\s*\)/.test(picker),
);
checkTrue(
  "B7 the picker reports a picked rect on live-screen:region-picked",
  /ipcRenderer\.send\(\s*['"]live-screen:region-picked['"]/.test(picker),
);
checkTrue(
  "B8 the picker reports cancellation on live-screen:region-cancelled",
  /ipcRenderer\.send\(\s*['"]live-screen:region-cancelled['"]/.test(picker),
);
checkTrue(
  "B9 main listens for the picked channel",
  /ipcMain\.once\(\s*["']live-screen:region-picked["']/.test(picker),
);
checkTrue(
  "B10 main listens for the cancelled channel",
  /ipcMain\.once\(\s*["']live-screen:region-cancelled["']/.test(picker),
);

// ── Part C: the backdrop obeys the existing privacy guarantees ─────────────
// The picker now captures the screen so the user can SEE it. That must stay a
// main-process, in-memory operation: nothing written to disk, nothing logged,
// nothing handed to a provider.

checkTrue(
  "C1 the picker never writes the capture to disk",
  !/writeFile|createWriteStream|appendFile|writeFileSync/.test(picker),
);
checkTrue(
  "C2 the picker never logs the capture",
  !/console\.(log|info|warn|error)\([^)]*(backdrop|shot|dataUrl)/i.test(picker),
);
checkTrue(
  "C3 the picker makes no network request of any kind",
  !/fetch\(|XMLHttpRequest|net\.request|axios/.test(picker),
);
checkTrue(
  "C4 the backdrop is captured before the picker window is created",
  picker.indexOf("capturePickerBackdrop(") < picker.indexOf("new BrowserWindow("),
);
checkTrue(
  "C5 the capture is handed to the page, not round-tripped through the renderer",
  /executeJavaScript\(`window\.__setBackdrop/.test(picker),
);

console.log(`\nSELECT REGION IPC`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
