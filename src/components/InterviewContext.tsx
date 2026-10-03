import React, { useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { extractTextFromFile, MAX_RESUME_CHARS } from "../lib/fileText";

const FIELD_CLASS =
  "w-full bg-black/40 border border-white/[0.1] rounded-xl px-3 py-2 text-[11px] text-white/85 placeholder:text-white/25 font-mono focus:outline-none focus:border-white/25 resize-none transition-colors";

/** File types that need a real parser (and so take a moment to read). */
function isParsedDocument(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".pdf") || lower.endsWith(".docx") || lower.endsWith(".doc")
  );
}

/**
 * InterviewContext — pre-interview setup shown above the "Start Interview" pill.
 * Collects the resume, company, job description and answer-style instructions
 * that shape every answer Ghostly produces during the session.
 */
export const InterviewContext: React.FC = () => {
  const { settings, updateSettings } = useStore();
  const [open, setOpen] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasContext = Boolean(
    settings.resumeText?.trim() ||
      settings.companyName?.trim() ||
      settings.jobDescription?.trim() ||
      settings.answerInstructions?.trim(),
  );

  const enableMouse = () => window.ghostly.enableMouse();
  const disableMouse = () => window.ghostly.disableMouse();

  const handleResumeFile = async (file: File) => {
    setUploadNote(
      isParsedDocument(file.name) ? `Reading ${file.name}…` : null,
    );
    setExtracting(true);
    try {
      const text = (await extractTextFromFile(file)).trim();
      if (!text) {
        setUploadNote(`No text found in ${file.name} (is it a scanned image?).`);
        return;
      }
      updateSettings({ resumeText: text.slice(0, MAX_RESUME_CHARS) });
      setUploadNote(
        text.length > MAX_RESUME_CHARS
          ? `Loaded ${file.name} (trimmed to ${MAX_RESUME_CHARS} characters).`
          : `Loaded ${file.name}.`,
      );
    } catch (err) {
      setUploadNote(
        err instanceof Error ? err.message : `Could not read ${file.name}.`,
      );
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div
      className="w-full max-w-[640px] flex flex-col items-center gap-2 pointer-events-none"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {/* Toggle */}
      <button
        onClick={() => {
          enableMouse();
          setOpen((v) => !v);
        }}
        onMouseEnter={enableMouse}
        onMouseLeave={() => {
          if (!open) disableMouse();
        }}
        className="pointer-events-auto flex items-center gap-2 bg-[rgba(30,30,30,0.85)] hover:bg-[rgba(42,42,42,0.92)] backdrop-blur-2xl border border-white/[0.08] rounded-full px-3 py-1 text-[10px] font-mono text-white/70 hover:text-white/90 transition-colors shadow-lg shadow-black/40"
      >
        <span className="opacity-70">📋</span>
        <span>Interview Context</span>
        {hasContext && (
          <span className="w-1.5 h-1.5 rounded-full bg-[#ff9f43]" />
        )}
        <span className="text-[8px] opacity-60">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div
          className="pointer-events-auto w-full bg-[rgba(25,25,28,0.95)] backdrop-blur-2xl border border-white/[0.08] rounded-2xl p-3 shadow-2xl shadow-black/60 flex flex-col gap-2.5"
          onMouseEnter={enableMouse}
          onMouseLeave={disableMouse}
        >
          {/* Resume */}
          <Field label="Resume">
            <div className="flex items-center gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={extracting}
                className="flex-none rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] px-2.5 py-1 text-[10px] text-white/70 hover:text-white/90 disabled:opacity-40 transition-colors"
              >
                {extracting ? "Reading…" : "⬆ Upload"}
              </button>
              <span className="text-[9px] text-white/25 truncate">
                PDF, DOCX, .txt, .md — or paste below
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.markdown,.rst,.json,.csv,.rtf,.tex,.yml,.yaml,.html,.pdf,.doc,.docx"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleResumeFile(file);
                  // Reset so re-selecting the same file fires onChange again.
                  e.target.value = "";
                }}
              />
            </div>
            <textarea
              value={settings.resumeText ?? ""}
              onChange={(e) => updateSettings({ resumeText: e.target.value })}
              placeholder="Paste your resume here…"
              rows={3}
              className={FIELD_CLASS}
            />
            {uploadNote && (
              <p className="text-[9px] text-white/35">{uploadNote}</p>
            )}
          </Field>

          {/* Company */}
          <Field label="Company Name">
            <input
              type="text"
              value={settings.companyName ?? ""}
              onChange={(e) => updateSettings({ companyName: e.target.value })}
              placeholder="e.g. Google, Stripe…"
              className={FIELD_CLASS}
            />
          </Field>

          {/* Job description */}
          <Field label="Job Description">
            <textarea
              value={settings.jobDescription ?? ""}
              onChange={(e) =>
                updateSettings({ jobDescription: e.target.value })
              }
              placeholder="Paste the job description or key requirements…"
              rows={3}
              className={FIELD_CLASS}
            />
          </Field>

          {/* Answer style */}
          <Field label="How should answers appear on screen?">
            <textarea
              value={settings.answerInstructions ?? ""}
              onChange={(e) =>
                updateSettings({ answerInstructions: e.target.value })
              }
              placeholder="e.g. Short bullet points, no long paragraphs. Lead with the final answer, then the reasoning. Skip code comments."
              rows={3}
              className={FIELD_CLASS}
            />
          </Field>
        </div>
      )}
    </div>
  );
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[9px] text-white/40 uppercase tracking-wider">
        {label}
      </label>
      {children}
    </div>
  );
}
