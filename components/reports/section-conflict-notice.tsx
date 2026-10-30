"use client";

// REMOVABLE (Sam, 2026-10-30, PROGRESS.md decisions row 15): the notice shown when somebody saved
// this section while you were editing. Delete with components/reports/use-section-conflict.ts,
// lib/reports/section-conflict.ts (+ test) and the four blocks and two import lines marked REMOVABLE in
// components/reports/section-editor.tsx.

import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/reports/local-time";
import { conflictSentence, HIDE_THEIRS_BUTTON, SAVE_MINE_BUTTON, SEE_THEIRS_BUTTON, USE_THEIRS_BUTTON, USE_THEIRS_NOTE, type CurrentSection } from "@/lib/reports/section-conflict";

// One sentence and two buttons. The person's box stays on screen above it, still editable and
// still holding their changes; the other version is behind a toggle, closed by default.
export function SectionConflictNotice({
  theirs,
  showTheirs,
  busy,
  onToggle,
  onSaveMine,
  onUseTheirs,
}: {
  theirs: CurrentSection;
  showTheirs: boolean;
  busy: boolean;
  onToggle: () => void;
  onSaveMine: () => void;
  onUseTheirs: () => void;
}) {
  const sentenceId = useId();
  const theirsId = useId();
  const sentenceRef = useRef<HTMLParagraphElement>(null);
  const { before, after } = conflictSentence(theirs);

  // The Save button the person just pressed is gone: put the cursor on the notice so a keyboard or
  // screen-reader user lands on it.
  useEffect(() => {
    sentenceRef.current?.focus();
  }, []);

  return (
    <div role="group" aria-labelledby={sentenceId} className="flex flex-col gap-2 rounded-md border border-zinc-400 p-3">
      <p ref={sentenceRef} id={sentenceId} tabIndex={-1}>
        {before}
        {after !== null && theirs.editedAt ? (
          <>
            <LocalTime iso={theirs.editedAt} />
            {after}
          </>
        ) : null}
      </p>
      <button type="button" className="text-left underline" aria-expanded={showTheirs} aria-controls={showTheirs ? theirsId : undefined} onClick={onToggle}>
        {showTheirs ? HIDE_THEIRS_BUTTON : SEE_THEIRS_BUTTON}
      </button>
      {showTheirs ? (
        <p id={theirsId} className="whitespace-pre-wrap rounded-md border border-zinc-300 p-2">
          {theirs.text || "—"}
        </p>
      ) : null}
      <Button type="button" onClick={onSaveMine} disabled={busy}>
        {busy ? "Saving…" : SAVE_MINE_BUTTON}
      </Button>
      <Button type="button" variant="outline" onClick={onUseTheirs} disabled={busy}>
        {USE_THEIRS_BUTTON}
      </Button>
      <p>{USE_THEIRS_NOTE}</p>
    </div>
  );
}
