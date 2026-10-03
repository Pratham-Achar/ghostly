# Ghostly Project — Daily Development Log

> **Purpose:** Context handoff file for AI agents / future sessions.
> **Project:** Ghostly — Stealth AI coding assistant (Electron + React + TypeScript)
> **Location:** `D:\ghostly`
> **Platform:** Windows 11, Node v24.17.0, npm 12.0.1
> **Last updated:** 2026-10-02

---

## 1. Project Overview

Ghostly is an Electron desktop app that runs as an invisible overlay during technical interviews. It captures screen regions, transcribes live audio (Whisper), and streams AI-powered answers from multiple providers (Gemini, OpenAI, Anthropic, Groq).

**Key architecture:**
- `electron/` — main process (hotkeys, capture, stealth, IPC)
- `src/` — React renderer (pages, components, hooks, AI providers)
- `src/lib/asr.worker.ts` — Moonshine streaming ASR in a Web Worker
- State: Zustand (`src/store/useStore.ts`)
- Persistence: electron-store (encrypted, `%APPDATA%\ghostly`)

**How to run:**
```bash
npm install
npm run dev      # development
npm run build    # production build
npm run package  # create .exe
```

**IMPORTANT:** `localhost:5173` in a browser is ALWAYS blank — the app only works inside Electron (needs `window.ghostly` APIs). The real app is the transparent overlay window at top-center of screen (y=0, ~900px wide, small pill-shaped TopBar).

---

## 2. Session 1 — Setup & Environment Fixes

### 2.1 npm install failed with `ERR_SSL_CIPHER_OPERATION_FAILED`
- **Cause:** Node v24 + OpenSSL 3 incompatible with some old packages; network issues
- **Fix:**
  ```powershell
  npm cache clean --force
  npm config set registry https://registry.npmmirror.com   # Chinese mirror
  npm install
  ```
- Also approved blocked install scripts:
  ```powershell
  npm install-scripts approve electron esbuild koffi protobufjs sharp
  npm rebuild electron
  ```

### 2.2 Electron binary missing ("Error: Electron uninstall")
- **Cause:** Electron postinstall script was blocked → binary never downloaded
- **Fix:** Manually downloaded via `@electron/get` + extracted with `adm-zip`:
  ```powershell
  npm install adm-zip
  node -e "const AdmZip=require('adm-zip'); const z=new AdmZip('C:/Users/FORTUNE SYSTEMS/AppData/Local/electron/Cache/<hash>/electron-v33.4.11-win32-x64.zip'); z.extractAllTo('D:/ghostly/node_modules/electron/dist', true);"
  # Then write path.txt ('electron.exe') and dist/version ('33.4.11')
  ```
- **Result:** `npm run dev` works, all hotkeys register, stealth mode applies.

---

## 3. Session 2 — Bug Fixes Round 1 (User-Reported Issues)

User reported: (1) transcript not working, (2) no AI answers, (3) shortcuts not working, (4) settings panel vanishes, (5) hand cursor visible on invisible panel, (6) need shortcuts for interview type + quick recapture.

### 3.1 Settings Panel vanishes on click
- **Files:** `src/components/SettingsPanel.tsx`, `src/pages/Home.tsx`
- Added `pointer-events-auto` to the motion.div wrapper in Home.tsx
- Added `WebkitAppRegion: "no-drag"` to settings panel
- Consolidated duplicate mouse-enable useEffects

### 3.2 Hand cursor visible (recruiter could see it)
- **File:** `src/pages/Home.tsx`
- Added `cursor: "default"` to screenshot strip + chat container style objects

### 3.3 Interview type shortcuts (NEW)
- **Files:** `electron/hotkeys.ts`, `electron/preload.ts`, `src/pages/Home.tsx`, `src/env.d.ts`
- `Ctrl+Shift+1` → DSA, `+2` → System Design, `+3` → Frontend, `+4` → SQL, `+5` → Behavioral, `+6` → General
- hotkeys.ts sends `ghostly:interview-type-${type}` channel
- preload.ts exposes `onInterviewType(type, cb)` listener
- Home.tsx useEffect registers listeners → `updateSettings({ interviewType: type })`

### 3.4 Quick capture shortcut (NEW)
- **File:** `electron/hotkeys.ts`
- `Ctrl+Shift+C` → captures full screen WITHOUT hiding window (for when interviewer changes question)

### 3.5 Hotkey race conditions
- **File:** `electron/hotkeys.ts` (rewritten)
- Added `isBusy` mutex to prevent overlapping captures
- Helper functions `showWindow()` / `hideWindow()`
- Always restores window visibility on errors (try/catch/finally)

### 3.6 Transcription improvements (VAD)
- **File:** `src/hooks/useInterviewAudio.ts`
- Silence threshold: 0.005 → 0.01 (filters noise)
- Max silence frames: 5 → 10 (~2.5s before concluding speech ended)
- Added `MIN_SPEECH_FRAMES = 4` (discards tiny noise bursts)
- Better Windows screen source detection + detailed logging

### 3.7 Bug: IPC channel mismatch (interview shortcuts broken)
- hotkeys.ts sent `"ghostly:interview-type"` but preload listened on `ghostly:interview-type-${type}`
- **Fix:** hotkeys.ts now sends `ghostly:interview-type-${type}` (Option A — separate channels)

### 3.8 Bug: Missing TypeScript declaration
- **Fix:** Added `onInterviewType: (type: string, cb: () => void) => () => void;` to `src/env.d.ts`

---

## 4. Session 3 — Window Invisible / React Crash Debugging

### 4.1 Problem: Electron window not visible on screen
- Console showed "Window shown" + stealth applied, but user couldn't find window
- `localhost:5173` in browser was blank white (expected — no `window.ghostly`)

### 4.2 Added diagnostics
- **File:** `electron/main.ts`
  - `win.webContents.on("console-message")` → forwards renderer logs to terminal as `[Renderer:level]`
  - `did-fail-load`, `render-process-gone` handlers
  - Logs window bounds + opacity at startup
- **Result:** Window confirmed at `x:317, y:0, width:904, height:816, opacity:1, visible:true`

### 4.3 Added React ErrorBoundary (NEW file)
- **File:** `src/components/ErrorBoundary.tsx` (created)
- Wraps app in `src/main.tsx`
- Shows full-screen red error UI with stack trace + "Reload App" button instead of invisible blank window
- Logs crash via `console.error("[Ghostly] React crashed: ...")`

### 4.4 Bug: Missing `updateSettings` in Home.tsx
- Interview-type listeners called `updateSettings(...)` but it wasn't destructured from `useStore()`
- **Fix:** Added `updateSettings` to destructuring in `src/pages/Home.tsx`

### 4.5 Safety guards
- `Home.tsx` useEffect: early return if `!window.ghostly`
- `App.tsx`: guard + sanitize settings on load (merge with defaults instead of blind overwrite)

### 4.6 Bug: SettingsPanel crashes with "Cannot read properties of undefined (reading 'listModels')"
- **Cause:** Saved settings had invalid `activeProvider` → `getProvider()` returned `undefined`
- **Fixes:**
  - `src/lib/ai/index.ts`: `getProvider()` falls back to `providers.gemini` (`?? providers.gemini`)
  - `src/components/SettingsPanel.tsx`: Safe fallback for `activeModels`
  - `src/App.tsx`: Sanitize saved settings — merge `{...defaults, ...savedSettings, apiKeys: {...}}`

---

## 5. Current Outstanding Issues (NOT YET FIXED)

### ✅ Issue A: "Failed to fetch" error on AI call — FIXED (Session 4)
- **Symptom:** Red banner "Failed to fetch" when submitting (screenshot or interview)
- **Cause:** Network-level failure — `fetch()` couldn't reach AI server at all
  - NOT an API rejection (that would show "Gemini API error: ...")
  - Possible: transient network, system proxy interference, invalid/missing API key, or provider blocked in user's region
  - User had SSL/network issues earlier (needed npmmirror registry) → restricted network likely
- **Fix applied:**
  - New file `src/lib/ai/fetchWithDiagnostics.ts` — shared wrapper around `fetch()`
  - Wired into all 4 providers (`gemini.ts`, `openai.ts`, `anthropic.ts`, `groq.ts`)
  - Validates API key presence before the request → `"{provider} API key is missing. Add it in Settings → API Keys."`
  - Logs context to terminal: `[AI:gemini] → POST host model=... apiKeyPresent=true` and `← HTTP <status>`
  - Catches network-level failures (TypeError from `fetch`) and rethrows a classified message:
    `Cannot reach {host} ({provider} / {model}). Network error: {detail}. Check your internet/VPN, or switch provider in Settings.`
  - Preserves `AbortError` untouched
  - `npm run build` passes (all 3 bundles)
- **Still open:** verify with a real request; user config default model is `gemini-2.0-flash` but `listModels()[0]` = `gemini-3.1-flash-lite-preview` (may not exist!)

### ✅ Issue B: Own mic audio is transcribed — FIXED (Session 4)
- **Fix applied:**
  - `useInterviewAudio.ts` `startInterview()` now captures **system/desktop audio only** — mic capture removed entirely
  - If no screen source or system capture fails → recording stops with a clear log (no mic fallback)
  - `stopInterview()` updated to close the single stream + AudioContext
  - `InterviewModal.tsx` header now reads `| System audio (Interviewer only)`
  - `settings.micDeviceId` is now unused by capture (setting still present in UI — harmless)

### ✅ Issue C: Ctrl+Enter submits interview transcript — FIXED (Session 4)
- **Fix applied:**
  - Interview messages lifted to Zustand store: `interviewMessages`, `addInterviewMessage`, `clearInterviewMessages`, `getInterviewTranscript()`
  - `useInterviewAudio` now reads/writes the store (was local `useState`) — transcript is reachable from Home
  - `Home.tsx` `onSolve` (Ctrl+Enter): if interview panel is open, builds transcript via `getInterviewTranscript()` and calls `runAIStream(shots, transcript)`; otherwise `runAIStream(shots)`
  - New `interviewOpenRef` avoids stale-closure issues in the global hotkey listener
  - Transcript is cleared on interview open/close/toggle (`Ctrl+G` also clears via `clearSolution`)
  - Transcript alone passes the runAIStream validation (no screenshot required)
  - **Flow now:** interviewer speaks → question appears in panel → user presses `Ctrl+Enter` → AI answer streams into main chat

### 🟡 Issue D: Question pending — which provider?
- Asked user to confirm intended AI provider (Gemini/Groq/OpenAI/Anthropic) + valid API key
- Awaiting response; diagnostics (Issue A fix) will reveal cause on next test

### ✅ Issue E: "model does not exist or you do not have access to it" — FIXED (Session 4)
- **Symptom:** `Groq API error: The model 'meta-llama/llama-4-scout-17b-16e-instruct' does not exist or you do not have access to it.`
- **Cause:** each provider hard-coded `listModels()` with fixed ids. Groq **deprecated Llama 4 Scout**, so the saved `activeModel` pointed at a retired id. This is an HTTP 400 (correctly surfaced by the provider code, not the network path).
- **Fix (3 layers):**
  1. **Live model discovery** — new optional `AIProvider.fetchModels(apiKey)` hitting each provider's `/models` endpoint (Groq/OpenAI `openai/v1/models`, Anthropic `v1/models`, Gemini `v1beta/models`). `SettingsPanel` now populates the Model dropdown from the live list, falling back to curated ids when there is no key / offline / CORS-blocked.
  2. **Auto-heal stale selection** — when the live list loads and `settings.activeModel` isn't in it, it is replaced with the first valid model.
  3. **Transparent retry** — if a stream fails with a model-unavailable error, `Home.runAIStream` retries once with `provider.listModels()[0]`, persists it, and re-streams. Also added `withModelHint()` so the error text tells the user to open Settings and pick another model.
  - Updated curated Groq list → `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`; removed bogus Gemini `gemini-3.1-flash-lite-preview`.
- **Note:** `src/pages/Settings.tsx` (separate route page) still uses curated lists only — benefits from the corrected ids but has no live discovery.

### ✅ Issue F: Live transcription not working after Start — FIXED (Session 4)
- **Symptom:** interviewer (Google Meet) asks a question, nothing appears in the transcript after pressing Start. (This surfaced right after Issue B removed mic capture — the mic had been doing all the work.)
- **Root causes:**
  1. The code **stopped the desktop video track** (`sysStream.getVideoTracks().forEach(t => t.stop())`) before building the audio graph. On Windows, tearing down desktop capture's video track can silence/kill the loopback **audio** track.
  2. It used the legacy `chromeMediaSource: "desktop"` constraint instead of Electron's supported loopback route.
  3. `AudioContext` was never resumed, and the worklet was routed to `audioCtx.destination` (would echo the captured audio).
- **Fix applied:**
  - `electron/ipc.ts`: added `session.defaultSession.setDisplayMediaRequestHandler(...)` granting `{ video: screenSource, audio: "loopback" }` (no system picker → stays stealthy).
  - `useInterviewAudio.ts` `startInterview()`: now uses `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })` as the primary path, with the legacy desktop constraint kept as a fallback. Video track is **never stopped**; only the audio track feeds the graph while the full stream is retained.
  - `AudioContext.resume()` is awaited; worklet now routes through a **0-gain sink** instead of `destination` (no echo).
  - VAD worklet now reports a peak `level` ~2×/sec; the hook logs transitions → "System audio detected (level …)" / "System audio is silent … — no sound is reaching Ghostly." Visible in the Debug panel.
  - Diagnostics log video/audio track counts, audio track label/enabled/muted, and AudioContext state/sample rate.
- **Testing:** if Debug shows "System audio is silent", the interviewer's voice isn't reaching the default output device (or Meet outputs to a device Ghostly isn't capturing).

### ✅ Issue G: Transcription slow + inaccurate — FIXED (Session 4)
- **Symptom:** long delay before text appears; transcript is wrong/fragmented.
- **Root causes (4):**
  1. **VAD timing off by ~94×** — an AudioWorklet `process()` gets a fixed 128-sample render quantum (~2.67 ms @48 kHz), but the worklet counted frames as if each were ~0.25 s. `MAX_SILENCE_FRAMES=10` ended a phrase after **~27 ms** of silence (comment claimed 2.5 s), and `MIN_SPEECH_FRAMES=4` meant ~11 ms. VAD chopped speech at word boundaries; the hook then discarded everything under 0.5 s → missing text + context-free fragments → Whisper hallucinations.
  2. **No worker queue** — the worker's `message` listener was `async`, so every chunk started its own transcription concurrently on the same pipeline (CPU contention + out-of-order results).
  3. **CPU/WASM Whisper** — `Xenova/whisper-base.en` with no `device` option → ONNX WASM on CPU, often slower than real time.
  4. **Lossy resampling + high threshold** — naive N-sample decimation (no anti-alias filter) plus `SILENCE_THRESHOLD=0.01` dropping quiet loopback audio.
- **Fixes applied:**
  - VAD is now **time-based** (uses the worklet's `sampleRate` global): `MAX_SILENCE_SECONDS=1.0`, `MIN_SPEECH_SECONDS=0.35`, threshold `0.008`. Silence is buffered too, so word tails aren't clipped.
  - `AudioContext` is requested at **16 kHz** (with fallback) so Whisper gets its native rate directly; `resampleTo16k()` (OfflineAudioContext, anti-aliased) covers the fallback case.
  - Handlers use the worklet-reported speech duration instead of the padded buffer length.
  - `whisper.worker.ts`: transcriptions are **serialized through a promise queue**; clips under 0.1 s are skipped; `chunk_length_s: 30` / `stride_length_s: 5` for long speech; removed the noisy raw-output log.
- **Still open (optional upgrades for Parakeet-like speed):**
  - WebGPU: `@huggingface/transformers` v3 with `device: 'webgpu'` (10–50× faster than WASM).
  - Streaming/local: **Moonshine** via transformers.js for interim text (real-time, free).
  - Cloud/free tier: **Groq `whisper-large-v3-turbo`** (~$0.04/hr, near-instant) — user already has a Groq key.
  - Consider defaulting Whisper to `Xenova/whisper-small.en` for accuracy once the pipeline is correct.

### ✅ Issue H: Pre-interview context inputs (resume / company / JD / answer style) — ADDED (Session 4)
- **Request:** before the "Start Interview" button, collect resume upload, company name, job description, and an instruction box that controls how the answer appears on screen.
- **Implementation:**
  - New component `src/components/InterviewContext.tsx` — a collapsible "📋 Interview Context" pill rendered directly **above** the Start Interview pill in `TopBar.tsx`. Shows an orange dot when any field is populated.
  - Fields: **Resume** (⬆ Upload for `.txt`/`.md`/`.json`/`.csv`/`.rtf`/`.tex`/`.yml` + paste textarea, capped at 20 000 chars), **Company Name**, **Job Description**, **How should answers appear on screen?**.
  - PDF/DOCX cannot be parsed without a dependency, so the upload button tells the user to open the file and paste the text (the textarea accepts a straight paste).
  - New `Settings` fields (auto-persisted, defaults merged on load by `App.tsx`): `resumeText`, `companyName`, `jobDescription`, `answerInstructions`.
  - New `buildInterviewContext(settings, { includeResume })` in `src/lib/prompts.ts` renders a `# Interview Context` block (Company / Job Description / Candidate Resume / Answer Style).
  - `Home.runAIStream` appends the block to **every** prompt (screenshot, live-transcript and follow-up paths). The resume is omitted on follow-ups (already in the first user message) to save tokens; company/JD/style always apply so formatting stays consistent.
- **Note:** `settings.customInstructions` is unchanged and still serves as the General-mode prompt; `answerInstructions` is the new cross-mode style directive.
- **Verified:** `tsc` (both projects) + `npm run build` pass.

### ✅ Issue I: Parakeet-style live transcription via Moonshine — DONE (Session 4)
- **Goal:** transcript appears *while the interviewer is speaking* instead of only after a full second of silence.
- **Engine swap (Whisper → Moonshine):**
  - `@xenova/transformers` **v2 removed**; `@huggingface/transformers` **v3.8.1** added (Moonshine was added in v3.2; v2 has no Moonshine support at all).
  - `src/lib/whisper.worker.ts` → **`src/lib/asr.worker.ts`** (deleted + recreated).
  - Models: `onnx-community/moonshine-base-ONNX` (default) and `onnx-community/moonshine-tiny-ONNX`. Both verified to contain `encoder_model_fp16.onnx`, `decoder_model_merged_fp16.onnx`, `encoder_model_quantized.onnx`, `decoder_model_merged_quantized.onnx`.
  - **WebGPU first, WASM fallback:** tries `{ device: "webgpu", dtype: "fp16" }`, catches, then falls back to `{ dtype: "q8" }` (WASM). Model size in fp32 would be ~240 MB; fp16/q8 cuts the first-run download roughly in half/quarter.
- **Streaming architecture:**
  - The VAD worklet now emits a **partial snapshot every 0.7 s while speech is ongoing** (`STREAM_INTERVAL_SECONDS`), in addition to the full clip when a phrase ends. Snapshots stop past `MAX_PARTIAL_SECONDS = 20`; a monologue is force-flushed at `MAX_PHRASE_SECONDS = 30`.
  - Each phrase carries an incrementing `phraseId`; partials arriving after their phrase was finalized are ignored.
  - The worker scheduler runs **finals with priority** and keeps only the newest partial (`pendingPartial`), so a slow machine never builds a backlog of stale interim transcriptions.
  - Worker now posts `partial` / `final` (instead of `result`); a final is always posted so the interim line can be cleared even when nothing was recognised.
- **UI:** new store state `interviewInterim` + `setInterviewInterim`; `useInterviewAudio` returns `interim`; `InterviewModal` renders a dashed “transcribing…” line with a blinking cursor that is replaced by the final message. `getInterviewTranscript()` and the “Ask Copilot 🚀” button both include the in-progress line, so submitting mid-sentence is not lossy.
- **Migration:** `App.tsx` rewrites any saved `Xenova/whisper-*` model id to the Moonshine default on load (the old ids are no longer offered in Settings). Settings section renamed **Whisper Model → Transcription Model**.
- **Verified end-to-end (Session 4, measured on the dev machine):**
  - Network probe: `huggingface.co` reachable at **~1 MB/s**, `hf-mirror.com` also works (~1.2 MB/s) — the HF CDN does *not* need a local mirror.
  - `npm run dev` with a temporary self-test proved the whole chain: `Model ready in 22.1s` → `WASM (q8)` → inference **0.23s** for a 1 s buffer → a real captured utterance `Transcribed system in 0.59s`.
  - **Important gotcha found:** a WebGPU adapter *is* present on this machine but reports *“The device (webgpu) does not support fp16.”* The first probe only checked for an adapter and therefore attempted the (doomed) fp16 path. `webgpuSupportsFp16()` now asks for the **`shader-f16` feature** specifically, so the app goes straight to WASM/q8. (q8 is already ~1.7× faster than real-time here, so GPU is not needed for the streaming cadence.)
  - Because q8/WASM is proven and fast, **WASM q8 is the effective default**; the WebGPU fp16 path only engages where `shader-f16` exists.
  - Temp scaffolding (self-test block + auto-open interview panel) was removed afterwards; no `TEMP-` markers remain.
- **Still unverified:** transcript *accuracy* on real interview speech (needs a live session).

### ✅ Issue J: PDF & DOCX resume extraction — ADDED (Session 4)
- New `src/lib/fileText.ts` with `extractTextFromFile()`: plain text read directly; **`.pdf` via `pdfjs-dist`**, **`.docx` via `mammoth`**, both loaded with dynamic `import()` so they stay out of the initial bundle. Legacy `.doc` returns a clear “save as .docx/PDF” message.
- `InterviewContext.tsx` now accepts PDF/DOCX (button shows “Reading…”), reports a friendly error for scans with no text layer, and keeps the 20 000-char cap.
- **Note:** scanned/image-only PDFs have no text layer — the message tells the user to paste instead. OCR is not implemented.
- **⚠️ BUG FIXED — resume upload failed with `n.toHex is not a function`.**
  - **Cause:** `pdfjs-dist` was installed at **v6.3.x**, which requires `Uint8Array.prototype.toHex` / `.toBase64` (Chrome 140+). **Electron 33 is Chromium 130**, so the call blew up at runtime. The v6 code calls `arr.toHex()` **without a guard**.
  - **Fix:** pin `pdfjs-dist` to the **v4 line (`^4.10.38`)**, which guards both: `if (Uint8Array.prototype.toHex) return arr.toHex(); return Array.from(arr, num => hexNumbers[num]).join("");`. Do **not** upgrade pdfjs-dist past v4 while the app is on Electron 33.
  - **Also:** `extractTextFromFile()` now wraps parser failures so the panel shows *“Couldn't read <file>: <reason>. Try pasting the resume text instead.”* instead of a minified internal error.
  - **Verified end-to-end:** a temporary self-test built a minimal PDF in the renderer and ran it through the real extraction path — `[PDFTEST] OK -> "HELLO GHOSTLY RESUME"`. Self-test removed afterwards.
  - **Still untested:** DOCX extraction (mammoth has no `toHex` usage, so it was not the failing path).

### ✅ Issue K: Interview agent invented unanswered questions / rambled — FIXED (Session 5)
- **Symptom:** the overlay sometimes answered a question nobody asked, or echoed its own instructions, e.g. *“With regards to the fastest language wars, let's compare Java and Python. Here's why Java would be faster: Interview Preparation In a real-world scenario…”*.
- **Root causes (all in code):**
  1. `Home.runAIStream()` built the live prompt as *“Here is a live interview transcript. Please provide a brief, excellent answer to the interviewer's **most recent question**…”* — with **no check that a question existed**. Any empty/incomplete transcript still asked for “the most recent question”, so the model produced one.
  2. With an empty transcript the transcript branch collapsed to `undefined` and execution **fell through to the screenshot prompt** (`buildPrompt(interviewType, language)` = “Analyze the problem in the screenshot…”) with **no screenshot** — a literal question generator. The same happened on Ctrl+Enter with no screenshot whenever session history existed.
  3. The candidate context (Company / JD / Resume / Answer Style) was appended to the **user** message on every call, so the model could quote its own instruction text back as content.
  4. `sessionMessages.slice(-6)` were replayed as real chat turns, letting an old assistant answer act as a continuation prompt.
  5. There was no system-instruction layer at all — every rule lived in a user message.
  6. `abortControllerRef.abort()` was called before a new stream, but an already in-flight older response could still append to the screen and overwrite the newer answer.
- **Fix — new `src/lib/interviewAgent.ts` implements the required pipeline:**
  - `evaluateInterviewTurn(turn)` = deterministic **end-of-utterance + question-detection gate** that runs *before any network call*. It refuses when: no interviewer speech yet; a non-empty interim (interviewer **still speaking**); the last utterance was the candidate's; the text is filler-only (“Okay… yes… right…”, “thanks”); it ends mid-thought (“I have worked with Node.js and recently”); it is the interviewer narrating (“Let me explain the problem”); or it simply contains no question shape. Abbreviations/ASR quirks are handled (`whats`, `hows`, `dont`).
  - `INTERVIEW_SYSTEM_PROMPT` holds the 8 absolute rules (never invent/assume/generate a question, never answer an earlier question, never fabricate resume facts, no labels, no AI mentions, spoken-style brevity) and is sent through each provider's **native system slot** (new `AIRequestOptions.system` → Gemini `systemInstruction`, Anthropic top-level `system`, OpenAI/Groq leading `system` message). The model is additionally told to reply with exactly `WAIT` for anything unclear.
  - `buildInterviewUserPrompt()` structures the user message as **`# Latest interviewer utterance — the ONLY question you may answer`** + `# Earlier conversation (background only)` + `# Your earlier answers (background only)` + an explicit “…otherwise reply with exactly: WAIT”.
  - Candidate context (resume/company/JD/answer style) now travels in the **system** prompt, so the user message contains nothing the model could mistake for a question. `answerInstructions` *and* `customInstructions` are both honoured (previously `customInstructions` was ignored on the interview path).
- **`Home.tsx`:** the transcript path never reaches `buildPrompt()` any more (the screenshot prompt is only used when a screenshot exists); **`WAIT` replies are discarded** — never shown, never added to `sessionMessages`, never written to history — and surface as a small amber `WAIT · <reason>` pill instead. The first ~8 characters of every stream are held back so a `WAIT` reply can't flash on screen.
- **Stale/concurrent responses:** every run takes `++requestIdRef.current` and an `isStale()` check gates *every* append, the history save, and the `finally` cleanup — a superseded run can no longer overwrite a newer answer or clear its UI. Ctrl+G also bumps the id.
- **Partial transcripts:** the agent only ever reads **finalized** utterances (`getInterviewTurn()` = `finals` + `interim`; the old lossy `getInterviewTranscript()` string helper was removed). A non-empty interim blocks answering. `useInterviewAudio` now ignores partials whose `phraseId` was already finalized and only clears the live line for its own phrase, so a late partial can no longer leave the gate stuck on “still speaking”.
- **Escape hatch:** pressing the hotkey twice in a row on the *exact same* transcript (within 30 s) counts as an explicit override and forwards it to the model, which still applies the WAIT rules.
- **Verified:** 32/32 detection assertions pass (positive: “Can you explain what REST API is?”, “walk me through your resume”, “whats the time complexity of this”, … / negative: “I have worked with Node.js and recently”, “Okay… yes… right…”, “Let me explain the problem”, “thanks”, …), plus turn-level and `isWaitResponse` cases, driven through esbuild + node. `tsc` (both configs), `npm run build` and `npm run dev` are clean.
- **UI unchanged** otherwise: Ctrl+Enter and “Ask Copilot 🚀” still trigger an answer exactly as before.

### ✅ Issue L: Auto-answer mode (settings toggle) — ADDED (Session 5)
- **Settings → “Live Answering”** has a new switch: *“Auto-answer when a question ends”* (new persisted `Settings.autoAnswer`, default `false`; the whole settings blob is already saved, so no IPC change was needed).
- **How it fires (`Home.tsx`):** an effect watches the **last finalized transcript message**. When it comes from the interviewer (`source: "system"`), it waits `AUTO_ANSWER_SETTLE_MS = 600ms`, then runs the **same gate** as the manual path (`normalizeTurn` → `evaluateInterviewTurn`). Only `action === "answer"` triggers the stream — incomplete/conversational speech is silently ignored and it keeps listening. Already-handled finals are tracked by message id, so a re-render can never double-answer.
- **Partial transcripts are still impossible to answer:** an in-progress (`interim`) line is not a finalized message, and the gate treats a non-empty interim as “the interviewer is still speaking”. Auto mode adds no new LLM trigger — it reuses `runAIStream`, so the system prompt, `WAIT` discard and request-id/stale-response guards all apply unchanged.
- **Split questions are re-joined first** (`normalizeTurn()` in `interviewAgent.ts`). The VAD cuts on ~1s pauses, so a question can arrive as two finals. Two finals are merged when either:
  - the new one is a *fragment* (starts with `and / also / so / but / …` **and** is not itself a question) — e.g. `"Can you explain"` + `"and then compare it"`;
  - the previous one is visibly unfinished (`HARD_TAIL`/`SOFT_TAIL`, or ends on a request verb with no object: `"Can you explain"`, `"How would you design"`, `"…and recently"`).
  **and** the new utterance is *not* a complete standalone question — so a real follow-up like `"and why is that?"` or a new question `"What is a REST API"` is never glued onto the previous one (which would make the model re-answer an old question). Never merges across the candidate speaking.
- **Toggle off ⇒ behaviour is exactly the previous manual flow** (Ctrl+Enter / “Ask Copilot 🚀”).
- **Verified:** the detection suite was extended to 47 assertions — positives (including merged turns like `"How would you design a URL shortener"`), negatives, turn-level gate cases, merge cases (`"Explain the design" + "What is a REST API"` must stay separate) and `isWaitResponse` — all passing. `tsc` (both configs), `npm run build`, `npm run dev` clean. **Still to verify live:** real interviewer audio with the toggle on.

---

## 6. Key Files Reference

| File | Purpose | Status |
|------|---------|--------|
| `electron/main.ts` | Window creation, tray, IPC, diagnostics | Modified — added renderer logging |
| `electron/hotkeys.ts` | Global shortcuts (rewritten with mutex) | Modified |
| `electron/preload.ts` | contextBridge API + `onInterviewType` | Modified |
| `electron/stealth.ts` | Win32 `SetWindowDisplayAffinity` (WDA_EXCLUDEFROMCAPTURE) | Unchanged |
| `electron/capture.ts` | Full-screen capture | Unchanged |
| `src/main.tsx` | React entry + ErrorBoundary wrapper | Modified |
| `src/App.tsx` | Loads persisted settings (sanitized) | Modified |
| `src/pages/Home.tsx` | Main UI, hotkey listeners, AI streaming, Ctrl+Enter transcript path, question gate + request-id/stale-response guards + `WAIT` notice | Modified |
| `src/components/SettingsPanel.tsx` | Settings UI (provider, keys, mic, transcription model, **Live Answering / auto-answer switch**) | Modified |
| `src/components/InterviewModal.tsx` | Live interview UI — submits a structured turn (`finals` + `interim`), not a joined string | Modified (header: interviewer-only) |
| `src/components/InterviewContext.tsx` | Collapsible pre-interview context (resume upload/paste, company, JD, answer style) above Start Interview | Created |
| `src/components/TopBar.tsx` | Overlay pill — hosts `InterviewContext` above the Start Interview button | Modified |
| `src/lib/prompts.ts` | Prompt builders + `buildInterviewContext()` | Modified |
| `src/components/ErrorBoundary.tsx` | React crash UI | Created |
| `src/hooks/useInterviewAudio.ts` | System-audio-only capture + VAD + Moonshine streaming; transcript from store; per-phrase (`phraseId`) ordering guard for partials/finals | Modified |
| `src/hooks/useAIStream.ts` | AI streaming hook (partially unused) | Unchanged |
| `src/lib/ai/*.ts` | Provider implementations + `AIRequestOptions.system` mapped to each provider's native system slot | Modified (`getProvider` fallback + diagnostics wrapper + system instruction) |
| `src/lib/interviewAgent.ts` | The answering agent: question/end-of-utterance detection gate, `normalizeTurn()` continuation merge, system prompt, prompt builders, `WAIT` helpers | Created |
| `src/lib/ai/fetchWithDiagnostics.ts` | Shared fetch wrapper: key check, context logging, network-error + model-error classification | Created |
| `src/components/SettingsPanel.tsx` | Settings UI + live model discovery / auto-heal | Modified |
| `src/lib/asr.worker.ts` | Moonshine ASR worker — finals-priority queue + latest-partial coalescing, WebGPU→WASM fallback | Created (replaced `whisper.worker.ts`) |
| `src/lib/fileText.ts` | Resume text extraction: plain text, PDF (`pdfjs-dist`), DOCX (`mammoth`) | Created |
| `src/store/useStore.ts` | Zustand state + shared interview transcript + `getInterviewTurn()` / `agentNotice` / `Settings.autoAnswer` | Modified |
| `src/env.d.ts` | Window.ghostly type declarations | Modified |

---

## 7. Keyboard Shortcuts (Current)

| Shortcut | Action |
|----------|--------|
| `Ctrl+H` | Capture screenshot (briefly hides window) |
| `Ctrl+Shift+C` | Quick capture (no window hide) |
| `Ctrl+Enter` | Ask AI / Solve |
| `Ctrl+B` | Show / Hide overlay |
| `Ctrl+G` | Start over / clear session |
| `Ctrl+Shift+1..6` | Interview type: DSA / SysDesign / Frontend / SQL / Behavioral / General |
| `Ctrl+Arrows` | Move window 25px |
| Tray click | Show/Hide toggle |

---

## 8. Testing Status

### ✅ Passed
- `npm run build` — all 3 bundles compile (main, preload, renderer)
- `npm run dev` — app launches, all hotkeys register `true`
- Window diagnostics: visible, opacity 1, correct bounds
- Stealth: `WDA_EXCLUDEFROMCAPTURE applied`
- Renderer logs forwarded to terminal
- ErrorBoundary catches crashes (verified with SettingsPanel crash)

### ⏳ Not yet tested / pending fixes
- Interview type shortcuts end-to-end (topbar dropdown update)
- Settings panel opens without crash
- Cursor shows arrow (not hand) on overlay
- AI answer streaming (blocked by Issue A — "Failed to fetch")
- Interview transcription (B + C fixed — pending live end-to-end test)
- **Issue K agent behaviour in a real interview**: the gate + system prompt were verified offline (47 detection assertions, prompts inspected); the *live* path still needs a real interviewer voice + a valid API key
- **Issue L auto-answer mode with real speech** — including that it does *not* fire on mid-sentence pauses

---

## 9. Testing Guide (Quick Reference)

```powershell
cd D:\ghostly
npm run dev
# DO NOT use localhost:5173 in browser — always blank
# Real app = transparent overlay at TOP-CENTER of screen
# If not visible: press Ctrl+B or click tray ghost icon
```

**Bug report template:**
```
Test: [description]
Expected: [what should happen]
Actual: [what happened]
Console: [copy terminal lines, esp. [Renderer:*] lines]
```

**Reset app data (clean slate):**
```powershell
# Quit app first
Remove-Item -Recurse -Force "$env:APPDATA\ghostly"
Remove-Item -Recurse -Force out -ErrorAction SilentlyContinue
```

---

## 10. Next Steps (Priority Order)

1. ~~**Fix Issue A** — Add network error diagnostics to 4 AI providers~~ ✅ DONE (Session 4)
2. ~~**Fix Issue B** — Remove mic capture; interviewer (system) audio only~~ ✅ DONE (Session 4)
3. ~~**Fix Issue C** — Lift interview messages to store; Ctrl+Enter submits transcript~~ ✅ DONE (Session 4)
4. **Test end-to-end** — interview flow: interviewer speaks → Ctrl+Enter → answer streams
5. **Verify the answering agent live** — incomplete/mid-sentence speech must show `WAIT · <reason>` instead of an answer, and the answer must match only the last interviewer question
6. **Verify all shortcuts** — especially `Ctrl+Shift+1-6` topbar updates
7. **Confirm provider** — user to confirm which AI provider + valid API key

---

## 11. Environment Notes

- **Node:** v24.17.0 (OpenSSL 3 — caused initial SSL errors)
- **npm registry:** set to `https://registry.npmmirror.com` (may need to restore: `npm config delete registry`)
- **Electron:** v33.4.11 (binary manually extracted to `node_modules/electron/dist`)
- **adm-zip + koffi:** installed (electron extraction + Win32 FFI)
- **User location/network:** likely restricted (SSL issues, npmmirror) — some AI providers may be blocked
- **App data:** `%APPDATA%\ghostly\ghostly-data.json` (encrypted electron-store)

---

## Session: ASR + provider-architecture fixes (audio brief + AI pipeline brief)

### Root causes found (not assumed — traced from the runtime path)

1. **Provider chain ran on Groq, not OpenRouter.** TWO causes, both real:
   - `electron/ipc.ts` electron-store **defaults** still said
     `providerOrder: ["groq","gemini"]` with no `openrouter` key at all. A store
     that had never been overwritten therefore handed the renderer a Groq-first
     chain.
   - `src/App.tsx` had a hardcoded `PROVIDER_NAMES = ["gemini","openai","anthropic","groq"]`
     that omitted `"openrouter"`, so the migration filter could never keep it.
   - Confirmed empirically at boot: the new migration logged
     `Previous order: [groq, gemini]`. This is what produced
     `providerChain=groq → gemini` / `model=allam-2-7b` (a model id only ever
     written by a live `fetchModels()` into persisted settings).
   - Fixed: registry-derived `PROVIDER_NAMES` exported from `src/lib/ai/index.ts`,
     store defaults updated, and a one-time migration that prepends `openrouter`
     when a key exists — logged, never silent.

2. **Answer card contained a prompt heading.** `Previously mentioned interview
   questions or requests` exists nowhere in the repo. The user prompt used
   Markdown `#` headings (`# Latest interviewer utterance`, …) which a
   structure-following open-weight model imitated. Fixed with neutral `<<<>>>`
   delimiters **and** a deterministic output validator.

3. **VAD read only `input[0]`** — the right channel of a stereo loopback stream
   was silently discarded. With Bluetooth profiles that carry voice in the right
   channel, left-only RMS fell below `SILENCE_THRESHOLD` and the phrase was never
   detected ("no speech recognised").

4. **Discarded phrases never cleared their interim line.** `endPhrase()` advanced
   `phraseId` but posted no message when the phrase was too short, so the renderer
   kept the stale interim text, which satisfied the gate's "interviewer is still
   speaking" check — a permanent WAIT behind every later question.

5. **No RMS gate before ASR.** Near-silent buffers were sent to Moonshine, which
   reliably hallucinates on them.

6. **No output-device resilience.** Windows loopback follows the default render
   device; nothing listened for `track.onended` / `devicechange`, so plugging
   earbuds in or out killed capture silently for the rest of the interview.

7. **Gate over-corrected and rejected real questions** (found by the new harness):
   - `Why should we hire you?` → WAIT (5 words + soft tail "you")
   - `What is your trade on?` → WAIT (ended on hard-tail preposition "on")
   - `And why?` / `And why not?` → WAIT (`words.length < 3`)
   All three fixed with narrow, shape-based exemptions.

### Files changed
- `electron/ipc.ts` — store defaults include `openrouter`
- `src/lib/ai/index.ts` — `PROVIDER_NAMES` + `isProviderName` from the registry
- `src/App.tsx` — registry-derived allow-list, preserved `models.openrouter`, order migration
- `src/lib/outputValidation.ts` — NEW: deterministic output validator
- `src/lib/transcriptQuality.ts` — NEW: structure-only ASR artefact detection
- `src/lib/interviewAgent.ts` — `<<<>>>` delimiters, quality gate, gate fixes
- `src/pages/Home.tsx` — resolved-chain diagnostic, output validator call
- `src/hooks/useInterviewAudio.ts` — mono downmix, `phraseClosed`, RMS gate, `[ASR]` logs, device resilience
- `src/lib/asr.worker.ts` — per-segment `[ASR]` diagnostics
- `src/lib/normalization.ts` — `use eh-fekt` repair
- `scripts/verify-pipeline.ts` — NEW: 117-check regression harness (kept)

### Verification
- `npx tsc --noEmit -p tsconfig.json` ✅
- `npx tsc --noEmit -p tsconfig.node.json` ✅
- `npm run build` ✅
- `npx tsx scripts/verify-pipeline.ts` → **117 passed, 0 failed**
- Dev boot clean; migration confirmed against the real on-disk store.

### NOT verified (needs a real Windows interview run)
- Actual audio capture with earbuds and with laptop speakers.
- Device-change reacquisition in practice.
- Any real end-to-end ASR quality improvement.

---

## Session: audio observability + provider routing (two briefs)
### 1. AudioContext double-close — exact cause
`InvalidStateError: Cannot close a closed AudioContext` came from **four** independent
paths able to `close()` the same context, none state-checked:
1. session `teardown` (device change / stop / unmount),
2. `startInterview`'s `catch` block (`await audioCtx?.close()`),
3. `stopInterview`'s legacy `(window as any)._interviewStreams[1].close()`,
4. the unmount effect.
`close()` is async and `state` only becomes `"closing"` after the promise settles, so two
paths in the same tick both saw `"running"`.
**Fix = ownership, not a swallowed error:** one `createIdempotentContextCloser(ctx)` per
context, `done` set synchronously, `state` checked, and every other path routed through it.

### 2. Live audio status bar
- New `src/lib/audioStatus.ts` — external store. Discrete state via
  `useSyncExternalStore`; level written to a module variable and read in a
  `requestAnimationFrame` loop that sets `style.width` directly → **zero React renders**
  for the meter (the worklet emits ~20 samples/s).
- New `src/components/AudioStatusBar.tsx`, mounted in `TopBar`.
- States: LISTENING / SPEECH / TRANSCRIBING / NO AUDIO / DISCONNECTED / ERROR.
- Level is the RMS of the **system-loopback stream the ASR actually consumes**, never the
  mic. dB mapping (-60 dBFS → 0, 0 dBFS → 100), fast attack / slow release.
- Worklet level cadence 0.5 s → **0.05 s**, now carrying `rms` + `speaking`.
- `resolveAudioState()` is a pure function so the time-based silence branch is testable.

### 3. Gate — short imperative requests
`"Explain Docker"` → `wait: too short`. Fix in `analyseUtterance`: the `< 3 words` rule now
also exempts `STRONG_REQUESTS` (structural request verbs). **No topic whitelist** — any
domain word behaves identically.
Also found by the harness: `"What is this tape being?"` was WAITed (5 words + soft tail
"being"). Added `WH_AUX_OPENER` (wh-word + auxiliary) which rescues it without rescuing
`"what i was saying is"`.

### 4. Provider routing
- **`openrouter/free`** is a real router (verified in OpenRouter docs). Now the OpenRouter
  default; the response's top-level `model` field is parsed into `AIStreamMeta.model` and
  surfaced as `resolvedModel` in the UI + logs.
- Free mode gets **no** catalog-wide `fallbackModels` — if the free router is down the run
  goes to the next provider, which is the configured policy, not a hidden substitution.
- **New direct NVIDIA provider** (`src/lib/ai/nvidia.ts`). Contract verified against
  NVIDIA docs, not invented: `POST https://integrate.api.nvidia.com/v1/chat/completions`,
  `Bearer` auth, OpenAI-compatible SSE. Distinct from "an NVIDIA model via OpenRouter".
- Chain default `["openrouter","nvidia"]`, filtered to providers that actually have keys.
- `FIRST_BYTE_TIMEOUT_MS` **unchanged at 4500**. Added real measurements instead:
  `http`, `firstChunk`, `total`, `outcome` per attempt → `[AI:{turnId}] timings: …`.

### 5. Verification
- harness **169 passed, 0 failed**
- `tsc --noEmit` (web + node) ✅ · `npm run build` ✅ · dev boot clean ✅
- Migration confirmed against the real store:
  `OpenRouter model "openai/gpt-oss-120b" → "openrouter/free"`

### Still unverified (needs real hardware/keys)
- Earbuds vs speakers, device swap, `AudioContext` error absent in a real device cycle.
- Whether 4500 ms is right — needs the new `timings` line from a live run.
- `openrouter/free` availability, rate limits and answer quality.

---

## Review follow-up: full 4-provider chain + AudioContext wording correction

### Gap found in review: chain was incomplete
`providerOrder` defaulted to `["openrouter","nvidia"]` — Groq and Gemini were absent
from the architecture entirely, so the intended
`OpenRouter → Groq → NVIDIA → Gemini` chain was not expressed.

**Fixed:**
- `INTERVIEW_PROVIDER_ORDER = ["openrouter","groq","nvidia","gemini"]` is now the
  canonical order in `src/lib/providerDiagnostics.ts`.
- `providerOrder` defaults updated in **both** `useStore.ts` and `electron/ipc.ts`
  (they must stay in sync).
- `normalizeProviderOrder()` now always emits the canonical order. `providerOrder` is
  the user's *enabled* chain, not "what works today" — so all four providers stay
  visible in Settings and the order is stable when a key is added later.
  Whether a provider is attempted is still decided per run by the key filter.
- Settings gained an **Interview Answer Chain** control: all four providers, ordered,
  individually toggleable, each showing `ready` / `no key · skipped` / `off · skipped`.

### New startup diagnostic (reviewer's requested shape, produced)
```
[AI] configured provider chain: openrouter(openrouter/free) → groq(allam-2-7b) → nvidia(meta/llama-3.3-70b-instruct) → gemini(gemini-2.5-flash)
[AI] resolved interview provider chain: ...
[AI] provider status:
  OPENROUTER [openrouter/free] — ready (free router — model chosen per request)
  GROQ [allam-2-7b] — SKIPPED: no API key
  NVIDIA [meta/llama-3.3-70b-instruct] — ready
  GEMINI [gemini-2.5-flash] — SKIPPED: no API key
```
Emitted on settings load AND before every interview run. Three states are
distinguished: `ready`, `missing-api-key`, `not-in-chain`.

Verified live against the real on-disk store — all four providers now appear.

### Wording correction (reviewer was right)
`AudioContextState` is `"suspended" | "running" | "closed"` (+ `"interrupted"` in newer
specs). There is **no** `"closing"` state — my earlier report and one code comparison
were wrong. `close()` is async and `state` does not change until the promise settles,
so the real race is two paths both observing `"running"`.

Removed the invalid `=== "closing"` comparison and corrected the comment. The
implementation was already correct: the **synchronous `done` flag** is what prevents the
second close, because it flips before any await point. The `state === "closed"` check
remains only as a cheap fast-path.

### Verification
- harness **186 passed, 0 failed** (17 new chain/diagnostics checks)
- `tsc --noEmit` web + node ✅ · `npm run build` ✅ · dev boot clean, 0 errors ✅

---

## Session: manual-hotkey answer orchestration (hedge + fallback)

### What changed
Replaced the "wait FIRST_BYTE_TIMEOUT_MS (4500ms) then fail over" model with a
**soft hedge**:

```
0ms    OpenRouter Free starts
       └─ produces ≥12 non-ws chars of useful text  → HEDGE DISARMED, wait for completion
       └─ hard failure (http/network/stream/abort) → next provider IMMEDIATELY
~1800ms still no useful text, not complete, not failed → start Groq alongside (max 2 concurrent)
       first provider to COMPLETE with an answer that PASSES the validator wins
       every loser is aborted via its own AbortController
       never more than 2 providers in flight (hedgeFired guard — the timer fires once)
```

### The rule that matters
**FIRST USEFUL TEXT, NOT TOTAL TIME.** A healthy stream that takes 3.4s in total but
produced its first useful text at 1.5s is never hedged. `disarmHedge()` fires on the
first meaningful chunk.

### Completed-answer-only UX
The orchestrator buffers internally; nothing is streamed to the screen. This is what
makes "first VALID COMPLETE answer wins" meaningful and makes a cross-provider overwrite
structurally impossible — the old "partial kept, never replaced" rule becomes vacuous
because no partial is ever visible. The streaming SolutionCard was replaced by an
"ANSWERING… · <provider>" line in the detected-question banner.

### Files
- **NEW** `src/lib/ai/orchestrator.ts` — hedge, concurrency cap, winner selection,
  cancellation, telemetry. `OPENROUTER_HEDGE_MS = 1800`, `MAX_CONCURRENT_PROVIDERS = 2`,
  `MEANINGFUL_CHARS = 12`.
- **REMOVED** `src/lib/ai/answerRunner.ts` (superseded; `FIRST_BYTE_TIMEOUT_MS` gone).
- `src/pages/Home.tsx` — uses `orchestrateAnswer`, validator passed in as the win
  condition, `onStatus` → banner, no `appendToSolution` streaming.
- **NEW** `scripts/verify-orchestration.mts` — 74 deterministic checks with scripted
  fake providers (no network).
- `src/lib/ai/openrouter.ts` / `nvidia.ts` / `groq.ts` — expose `meta.httpMs`.

### Deliberately dropped
The per-provider "retry this gateway on a different model id" list (`fallbackModels` +
`onModelHealed`). With hedging, starting the next provider is a faster answer than
retrying the same gateway on another model. Reverting a retired model now happens via
Settings.

### Verification
- orchestration harness **74 passed, 0 failed**
- pipeline harness **186 passed, 0 failed**
- `tsc --noEmit` web + node ✅ · `npm run build` ✅ · dev boot clean, 0 errors ✅

Two test failures during development were caused by the fake answers being correctly
rejected by `validateAnswerOutput` (label-shaped text with no terminal punctuation) —
a useful confirmation that the validator is doing its job.

### NOT verified
No live latency numbers. `OPENROUTER_HEDGE_MS = 1800` is a starting constant, not a
tuned value — it must be adjusted from real `firstTextMs` telemetry over ~10 real
questions before it should be trusted.
