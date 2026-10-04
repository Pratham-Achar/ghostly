import { desktopCapturer, screen } from "electron";
import { Buffer } from "node:buffer";

export async function captureFullScreen(): Promise<string> {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const scaleFactor = primaryDisplay.scaleFactor;

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(width * scaleFactor),
      height: Math.round(height * scaleFactor),
    },
  });

  if (sources.length === 0) {
    throw new Error("No screen source found");
  }

  return sources[0].thumbnail.toDataURL();
}

// ── Region capture (Live Screen) ────────────────────────────────────────────

/** A rectangle in DEVICE pixels, matching what GDI expects. */
export interface ScreenRegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CapturedRegion {
  /** Tightly packed BGRA, top row first — exactly what the OCR engine takes. */
  bgra: Buffer;
  width: number;
  height: number;
}

/**
 * Refuse absurd regions before allocating. A region this large would be a bug
 * or a malicious renderer, and 400 MB of pixel buffer is not something to
 * discover by trying.
 */
const MAX_REGION_PIXELS = 4_000_000;

/** GDI raster-op constants. */
const SRCCOPY = 0x00cc0020;
/**
 * CAPTUREBLT includes layered windows in the copy.
 *
 * Without it a window with transparency — a browser, a terminal, most editors —
 * is captured as if it were not there, which is precisely the region a coding
 * interviewer is reading from.
 */
const CAPTUREBLT = 0x40000000;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let gdi: any = null;

/** Bind the GDI entry points once. Returns null when unavailable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureGdi(): any {
  if (gdi) return gdi;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require("koffi");
  const user32 = koffi.load("user32.dll");
  const gdi32 = koffi.load("gdi32.dll");

  gdi = {
    GetDC: user32.func("void *GetDC(void *hwnd)"),
    ReleaseDC: user32.func("int32 ReleaseDC(void *hwnd, void *hdc)"),
    CreateCompatibleDC: gdi32.func("void *CreateCompatibleDC(void *hdc)"),
    CreateCompatibleBitmap: gdi32.func(
      "void *CreateCompatibleBitmap(void *hdc, int32 width, int32 height)",
    ),
    SelectObject: gdi32.func("void *SelectObject(void *hdc, void *obj)"),
    BitBlt: gdi32.func(
      "int32 BitBlt(void *hdcDest, int32 xDest, int32 yDest, int32 width, int32 height, void *hdcSrc, int32 xSrc, int32 ySrc, uint32 rop)",
    ),
    GetDIBits: gdi32.func(
      "int32 GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, void *bits, void *info, uint32 usage)",
    ),
    DeleteDC: gdi32.func("int32 DeleteDC(void *hdc)"),
    DeleteObject: gdi32.func("int32 DeleteObject(void *obj)"),
  };
  return gdi;
}

/**
 * Copy ONE region of the screen straight into memory.
 *
 * ── Why GDI rather than cropping a screenshot ──────────────────────────────
 * `desktopCapturer` can only hand back a whole-display image. Cropping one
 * means the entire screen is already resident in memory — including every other
 * window on it — before a single pixel of the selected region is used. Live
 * Screen says it watches a region, and this is the only way that is literally
 * true: GDI's BitBlt transfers `width × height` pixels and nothing else.
 *
 * ── Privacy ────────────────────────────────────────────────────────────────
 * The result is a Buffer in main-process memory. It is never written to disk,
 * never logged, and never handed to the renderer. The only thing derived from it
 * that leaves this function is either a 256-byte signature or recognised text.
 *
 * ── Top-down rows ──────────────────────────────────────────────────────────
 * `biHeight` is negative so row 0 is the TOP of the region. OCR expects reading
 * order, and a bottom-up buffer would read the problem backwards.
 */
export function captureRegionBgra(region: ScreenRegionRect): CapturedRegion {
  const width = Math.round(region.width);
  const height = Math.round(region.height);
  const x = Math.round(region.x);
  const y = Math.round(region.y);

  if (width <= 0 || height <= 0) {
    throw new Error("capture region must have a positive size");
  }
  if (width * height > MAX_REGION_PIXELS) {
    throw new Error(
      `capture region ${width}x${height} exceeds the ${MAX_REGION_PIXELS} pixel limit`,
    );
  }

  const api = ensureGdi();

  const screenDc = api.GetDC(null);
  if (!screenDc) throw new Error("could not obtain a screen device context");

  let memDc: unknown = null;
  let bitmap: unknown = null;
  let previous: unknown = null;

  try {
    memDc = api.CreateCompatibleDC(screenDc);
    if (!memDc) throw new Error("could not create a memory device context");

    bitmap = api.CreateCompatibleBitmap(screenDc, width, height);
    if (!bitmap) throw new Error("could not create a bitmap for the region");

    previous = api.SelectObject(memDc, bitmap);

    const copied = api.BitBlt(
      memDc,
      0,
      0,
      width,
      height,
      screenDc,
      x,
      y,
      SRCCOPY | CAPTUREBLT,
    );
    if (!copied) throw new Error("the region could not be copied from the screen");

    // BITMAPINFOHEADER, 40 bytes. Negative height requests a top-down DIB.
    const info = Buffer.alloc(40);
    info.writeUInt32LE(40, 0); // biSize
    info.writeInt32LE(width, 4); // biWidth
    info.writeInt32LE(-height, 8); // biHeight (negative = top-down)
    info.writeUInt16LE(1, 12); // biPlanes
    info.writeUInt16LE(32, 14); // biBitCount
    info.writeUInt32LE(BI_RGB, 16); // biCompression
    info.writeUInt32LE(width * height * 4, 20); // biSizeImage
    // biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant stay 0.

    const pixels = Buffer.alloc(width * height * 4);
    const ok = api.GetDIBits(
      screenDc,
      bitmap,
      0,
      height,
      pixels,
      info,
      DIB_RGB_COLORS,
    );
    if (!ok) throw new Error("the region could not be read back");

    return { bgra: pixels, width, height };
  } finally {
    // Restore, then destroy — in that order, or the memory DC keeps pointing at
    // a deleted bitmap.
    if (memDc && previous) {
      try {
        api.SelectObject(memDc, previous);
      } catch {
        /* best-effort */
      }
    }
    if (bitmap) {
      try {
        api.DeleteObject(bitmap);
      } catch {
        /* best-effort */
      }
    }
    if (memDc) {
      try {
        api.DeleteDC(memDc);
      } catch {
        /* best-effort */
      }
    }
    try {
      api.ReleaseDC(null, screenDc);
    } catch {
      /* best-effort */
    }
  }
}
