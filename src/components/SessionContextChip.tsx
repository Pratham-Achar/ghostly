import React, { useState } from "react";

import {
  APPROACH_SUMMARY_MAX_CHARS,
  USER_NOTES_MAX_CHARS,
  describeSessionContext,
  type ProblemKind,
  type ProblemSource,
  type SessionContext,
} from "../lib/sessionContext";

/**
 * The session-context chip.
 *
 * ── Why a self-contained component ──────────────────────────────────────────
 * It is used from the overlay today and from the future Session screen
 * tomorrow, so it owns its own state and takes everything it needs as props. A
 * chip that had to be told which store slice to read would be the first thing
 * to break when the second caller arrives.
 *
 * ── Why it is never an auto-attach ──────────────────────────────────────────
 * The chip only ever DISPLAYS and EDITS. It cannot set a problem that the user
 * did not create or approve. The one action that can populate the context from
 * elsewhere ("Use as context", for a Solve result) is behind an explicit click
 * and is rendered by the caller, so the affordance is always visible before it
 * happens.
 */

export interface SessionContextChipProps {
  context: SessionContext;
  now?: number;
  /** Persist a change. Called for every edit; never called on render. */
  onChange: (next: SessionContext) => void;
  /** Drop the problem, the approach summary and the user notes. */
  onClear: () => void;
  /**
   * A solution the user could adopt as the context, offered explicitly.
   * Rendered as a button. Never applied automatically.
   */
  offerSolution?: { label: string; source: ProblemSource } | null;
  /** Builds the context from the offered solution. */
  onUseSolution?: (source: ProblemSource) => void;
  /** Compact form for a narrow column. */
  compact?: boolean;
}

const KIND_LABEL: Record<ProblemKind, string> = {
  coding: "Coding",
  system_design: "System design",
  other: "Problem",
};

export const SessionContextChip: React.FC<SessionContextChipProps> = ({
  context,
  now = Date.now(),
  onChange,
  onClear,
  offerSolution,
  onUseSolution,
  compact = false,
}) => {
  const [editing, setEditing] = useState<"problem" | "notes" | null>(null);
  const [draftProblem, setDraftProblem] = useState("");
  const [draftNotes, setDraftNotes] = useState("");

  const problem = context.activeProblem;

  if (!problem) {
    return offerSolution && onUseSolution ? (
      <div
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg"
        style={{
          background: "rgba(120, 140, 200, 0.08)",
          border: "1px solid rgba(140, 160, 220, 0.18)",
        }}
      >
        <span className="text-[10px] text-white/45 font-mono flex-1 truncate">
          No problem context
        </span>
        <button
          type="button"
          onClick={() => onUseSolution(offerSolution.source)}
          className="flex-none px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[9px] font-mono text-white/80"
          title="Nothing is attached until you click this."
        >
          {offerSolution.label}
        </button>
      </div>
    ) : null;
  }

  const openEditor = (which: "problem" | "notes") => {
    if (which === "problem") setDraftProblem(problem.text);
    else setDraftNotes(context.userNotes ?? "");
    setEditing(which);
  };

  const commitProblem = () => {
    const text = draftProblem.trim();
    if (!text) return;
    onChange({
      ...context,
      activeProblem: { ...problem, text },
    });
    setEditing(null);
  };

  const commitNotes = () => {
    onChange({
      ...context,
      userNotes: draftNotes.trim() ? draftNotes : null,
    });
    setEditing(null);
  };

  const notesRemaining = USER_NOTES_MAX_CHARS - (context.userNotes?.length ?? 0);

  return (
    <div
      className="px-2 py-1.5 rounded-lg space-y-1"
      style={{
        background: "rgba(120, 140, 200, 0.08)",
        border: "1px solid rgba(140, 160, 220, 0.18)",
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[9px] uppercase tracking-wider text-white/35 flex-none">
          {KIND_LABEL[problem.kind]}
        </span>
        <span className="text-[10px] text-white/70 font-mono flex-1 truncate">
          {problem.text}
        </span>
        <button
          type="button"
          onClick={() => openEditor("problem")}
          className="flex-none px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[9px] font-mono text-white/70"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onClear}
          className="flex-none px-1.5 py-0.5 rounded bg-white/[0.06] hover:bg-white/[0.12] text-[9px] font-mono text-white/50"
        >
          Clear
        </button>
      </div>

      {editing === "problem" && (
        <div className="space-y-1">
          <textarea
            autoFocus
            value={draftProblem}
            onChange={(e) => setDraftProblem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commitProblem();
              }
              if (e.key === "Escape") setEditing(null);
            }}
            rows={3}
            className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-[10px] font-mono text-white/80 outline-none focus:border-white/25 resize-y"
          />
          <div className="flex items-center justify-between">
            <span className="text-[8px] text-white/25">
              {draftProblem.length}/{APPROACH_SUMMARY_MAX_CHARS * 3}
            </span>
            <button
              type="button"
              onClick={commitProblem}
              className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[9px] font-mono text-white/80"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {context.approachSummary && !compact && (
        <div className="text-[9px] text-white/35 font-mono truncate">
          Ghostly's earlier approach: {context.approachSummary}
        </div>
      )}

      {editing === "notes" ? (
        <div className="space-y-1">
          <textarea
            autoFocus
            value={draftNotes}
            onChange={(e) =>
              setDraftNotes(e.target.value.slice(0, USER_NOTES_MAX_CHARS))
            }
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(null);
            }}
            rows={4}
            placeholder="Paste the problem statement or a code sketch…"
            className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-[10px] font-mono text-white/80 outline-none focus:border-white/25 resize-y"
          />
          <div className="flex items-center justify-between">
            <span
              className={`text-[8px] ${notesRemaining < 0 ? "text-red-300/70" : "text-white/25"}`}
            >
              {draftNotes.length}/{USER_NOTES_MAX_CHARS}
            </span>
            <button
              type="button"
              onClick={commitNotes}
              className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[9px] font-mono text-white/80"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openEditor("notes")}
            className="px-1.5 py-0.5 rounded bg-white/[0.06] hover:bg-white/[0.12] text-[9px] font-mono text-white/50"
          >
            {context.userNotes ? "Edit notes" : "+ notes"}
          </button>
          {context.userNotes && (
            <span className="text-[8px] text-white/25">
              {context.userNotes.length}/{USER_NOTES_MAX_CHARS}
            </span>
          )}
          {!compact && (
            <span className="text-[8px] text-white/20 ml-auto">
              {describeSessionContext(context, now)}
            </span>
          )}
        </div>
      )}

      {/* Never applied without a click — see the component doc comment. */}
      {offerSolution && onUseSolution && (
        <button
          type="button"
          onClick={() => onUseSolution(offerSolution.source)}
          className="w-full px-2 py-0.5 rounded bg-white/[0.06] hover:bg-white/[0.12] text-[9px] font-mono text-white/60"
          title="Replaces the active problem with this one. Nothing happens until you click."
        >
          {offerSolution.label}
        </button>
      )}
    </div>
  );
};