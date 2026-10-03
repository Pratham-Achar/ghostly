/**
 * Facts about the Parakeet model release — URL, archive size, file sizes.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 * Both the main process (which downloads and verifies) and the renderer (which
 * shows "631 MB installed" and the progress total) need these numbers. They
 * cannot import from each other: `electron/parakeetModel.ts` imports `node:fs`,
 * `node:path` and `node:crypto`, and pulling that into the renderer bundle would
 * break the web build outright. Duplicating the numbers would be worse — the two
 * copies would drift, and a drifted size constant turns a real integrity check
 * into a permanently failing one.
 *
 * So the numbers live here, with no imports at all, and both sides read them.
 *
 * ── On the absence of a checksum ────────────────────────────────────────────
 * The release publishes no `.sha256`, `.md5` or `.sha256sum` asset (all 404).
 * There is therefore no hash to verify against, and the integrity guarantee is
 * size-based only. That limitation is stated in the UI and in the report rather
 * than hidden behind the word "verified" — a size check cannot detect a
 * correctly-sized corrupted file, and pretending otherwise would be the most
 * misleading thing this feature could do.
 */

/** The archive GitHub actually publishes. The non-int8 asset 404s. */
export const PARAKEET_ARCHIVE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2";

/**
 * Byte length of the archive, as reported by the release host.
 *
 * Used to detect a short download BEFORE spending a minute on extraction: 460 MB
 * received out of 460 MB expected is the one integrity check available.
 */
export const PARAKEET_ARCHIVE_BYTES = 482_468_385;

/** The model directory name, inside `<userData>/models`. */
export const PARAKEET_MODEL_DIR_NAME =
  "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";

/**
 * Required files and their exact sizes, in bytes.
 *
 * EXACT, not a minimum. These are the sizes of the published int8 model, and a
 * file of a different length is a different file. Accepting it "because it is
 * big enough" would defeat the only integrity check available here.
 *
 * Measured from the release archive itself, not estimated.
 */
export const PARAKEET_REQUIRED_FILES: ReadonlyArray<{
  readonly name: string;
  readonly bytes: number;
}> = [
  { name: "encoder.int8.onnx", bytes: 652_184_296 },
  { name: "decoder.int8.onnx", bytes: 7_257_753 },
  { name: "joiner.int8.onnx", bytes: 1_739_080 },
  { name: "tokens.txt", bytes: 9_384 },
];

/** Total unpacked size, for the "631 MB" figure the UI shows. */
export const PARAKEET_UNPACKED_BYTES = PARAKEET_REQUIRED_FILES.reduce(
  (n, f) => n + f.bytes,
  0,
);
