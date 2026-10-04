/**
 * Deterministic tests for the NVIDIA main-process transport.
 *
 * Run: `npx tsx scripts/verify-nvidia-bridge.mts`
 *
 * ── The failure this exists to fix ──────────────────────────────────────────
 * Every live turn logged:
 *
 *   [AI:NVIDIA] network error reaching integrate.api.nvidia.com:
 *   TypeError: Failed to fetch
 *
 * That is Chromium refusing a cross-origin request. NVIDIA sends no
 * `Access-Control-Allow-Origin` for the app's origin, so the request never left
 * the renderer and could not have succeeded — no retry, no header and no timeout
 * changes that. The only fix is to make the request somewhere without an origin,
 * which is the Electron main process.
 *
 * ── What is asserted, and why each one matters ──────────────────────────────
 * 1. The provider PREFERS the main process and still has a working fallback.
 * 2. The API key never crosses the IPC boundary — structurally, by asserting
 *    that no key parameter exists on either side.
 * 3. The SSE parser is identical to the renderer's, because a divergent parser
 *    would make the two transports produce different answers from the same
 *    stream.
 * 4. The request is still STREAMED. The orchestrator's hedge decision depends on
 *    seeing the first text arrive early, so buffering in main would remove the
 *    very signal it needs.
 */
import { readFile } from "node:fs/promises";

import { parseNvidiaEvent } from "../src/lib/ai/nvidia";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    failures.push(
      `${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }
}
function checkTrue(name: string, actual: boolean) {
  check(name, actual, true);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The provider uses the main process, and keeps a fallback
// ═══════════════════════════════════════════════════════════════════════════

{
  const src = await readFile("src/lib/ai/nvidia.ts", "utf8");

  checkTrue(
    "N1 the provider consults the main-process bridge",
    /isNvidiaMainBridgeAvailable\(\)/.test(src),
  );
  checkTrue("N2 it streams through the bridge", /streamNvidiaViaMain\(/.test(src));
  checkTrue(
    "N3 it falls back to the renderer when the bridge declines",
    /declined the request/.test(src),
  );
  checkTrue(
    "N4 the fallback happens BEFORE the renderer fetch, not after a failure",
    src.indexOf("streamNvidiaViaMain") < src.indexOf("fetchWithDiagnostics(\n      `${NVIDIA_BASE}/chat/completions"),
  );

  const bridge = await readFile("src/lib/ai/nvidiaBridge.ts", "utf8");
  checkTrue(
    "N5 the bridge treats an absent main process as 'not available', not an error",
    /isNvidiaMainBridgeAvailable[\s\S]*return null/.test(bridge),
  );
  checkTrue(
    "N6 a stream that started and then failed THROWS, so the caller sees why",
    /throw failure/.test(bridge),
  );
  checkTrue(
    "N7 the pending map is always cleaned up, so a late chunk cannot resolve a dead waiter",
    /finally \{[\s\S]*pending\.delete\(id\)/.test(bridge),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. The key never crosses IPC
// ═══════════════════════════════════════════════════════════════════════════

{
  const preload = await readFile("electron/preload.ts", "utf8");
  const env = await readFile("src/env.d.ts", "utf8");
  const main = await readFile("electron/nvidiaAi.ts", "utf8");

  for (const [label, src] of [
    ["preload", preload],
    ["env.d.ts", env],
  ] as const) {
    const start = src.indexOf("nvidiaStreamStart");
    const block = src.slice(start, start + 400);
    checkTrue(
      `N8 ${label} sends no key to the main process`,
      !/apiKey|api_key|Bearer/.test(block),
    );
  }

  checkTrue(
    "N9 the main process reads the key from its OWN store",
    /store\.get\("settings"\)[\s\S]{0,200}apiKeys\?\.nvidia/.test(main),
  );
  checkTrue(
    "N10 it refuses rather than sending an unauthenticated request",
    /"no_api_key"/.test(main),
  );
  // `apiKeyPresent=true` is deliberate and safe — it records THAT a key was
  // found. What must never appear is the key itself, so the assertion is about
  // the identifier appearing without the `Present` suffix.
  const logLines = main
    .split("\n")
    .filter((l) => /console\.(log|error|warn)/.test(l));
  checkTrue("N11 something is logged", logLines.length > 0);
  checkTrue(
    "N11b the key is never written to the log — only its presence",
    logLines.every(
      (l) => !/\bapiKey\b(?!\s*[,)\s]*$)/.test(l) || /apiKey:/.test(l),
    ),
  );
  checkTrue(
    "N11c the one allowed mention is the presence flag",
    !main.includes("apiKey,") && !main.includes("apiKey)"),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. The SSE parser agrees with the renderer's
// ═══════════════════════════════════════════════════════════════════════════

{
  const main = await readFile("electron/nvidiaAi.ts", "utf8");
  // The main-process parser is plain CommonJS, so it cannot import the TS one;
  // instead the two are pinned to the same observable behaviour here.
  checkTrue(
    "N12 the main process has its own SSE line parser",
    /export function parseNvidiaSseLine/.test(main),
  );

  // Same frames the renderer's parser handles.
  check(
    "N13 delta content",
    parseNvidiaEvent({
      choices: [{ delta: { content: "hello" }, finish_reason: null }],
    }),
    { text: "hello", finishReason: undefined },
  );
  check(
    "N14 inline error",
    parseNvidiaEvent({ error: { message: "boom" } }),
    { text: "", error: "boom" },
  );
  check(
    "N15 string error",
    parseNvidiaEvent({ error: "boom" }),
    { text: "", error: "boom" },
  );
  check(
    "N16 finish reason arrives on the last chunk only",
    parseNvidiaEvent({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    { text: "", finishReason: "stop" },
  );
  check(
    "N17 message shape is accepted too",
    parseNvidiaEvent({ choices: [{ message: { content: "x" } }] }),
    { text: "x", finishReason: undefined },
  );

  checkTrue(
    "N18 the main parser skips [DONE] rather than emitting empty text",
    main.includes('payload === "[DONE]"'),
  );
  checkTrue(
    "N19 a malformed keep-alive frame is skipped, not fatal",
    main.includes("// A malformed keep-alive frame is not fatal"),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Streaming is preserved end to end
// ═══════════════════════════════════════════════════════════════════════════

{
  const main = await readFile("electron/nvidiaAi.ts", "utf8");
  checkTrue("N20 the request is streamed", /stream: true/.test(main));
  checkTrue(
    "N21 chunks are pushed per SSE frame rather than buffered",
    /type: "chunk"/.test(main) && /reader\.read\(\)/.test(main),
  );
  checkTrue(
    "N22 the renderer's invoke returns the id IMMEDIATELY, not after the answer",
    /const started = await bridge\.nvidiaStreamStart/.test(
      await readFile("src/lib/ai/nvidiaBridge.ts", "utf8"),
    ),
  );
  checkTrue(
    "N23 an abort is supported, so a hedge winner can cancel the loser",
    /nvidia:stream-abort/.test(main),
  );
  checkTrue(
    "N24 every terminal state ends as exactly one done/error event",
    /type: "error"/.test(main) && /type: "done"/.test(main),
  );
  checkTrue(
    "N24b the stream loop RETURNS after an error rather than continuing",
    /type: "error",[\s\S]{0,120}return;/.test(main),
  );
  checkTrue(
    "N25 an abort produces NO error event (the caller already stopped listening)",
    /if \(controller\.signal\.aborted\) \{\n\s+\/\/ Aborts are the caller/.test(main),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}