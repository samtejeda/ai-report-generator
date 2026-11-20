"use client";

import { useId } from "react";
import { fieldClass } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { useGeneration } from "@/components/reports/generation-context";
import { NOTES_BOX_ID } from "@/lib/reports/generate-flow";
import { MAX_NOTES_CHARS } from "@/lib/reports/generation-limits";
import { NOTES_CLEAR_BUTTON, NOTES_HEADING, NOTES_HELP, NOTES_NOT_SAVED } from "@/lib/reports/generate-messages";

// The one session-notes box for the whole report (real mode). It is deliberately outside any
// form element, has no field name (nothing can submit it) and no autofill; its value lives in the provider's
// memory only (see generation-context.tsx). It is read-only, not disabled, while a run is in
// flight, so the cursor and the text stay where they are.
export function GenerateNotesBox() {
  const { notes, setNotes, clearNotes, running } = useGeneration();
  const helpId = useId();
  return (
    <section className="flex flex-col gap-2 text-sm">
      <h2 className="text-base font-semibold">
        <label htmlFor={NOTES_BOX_ID}>{NOTES_HEADING}</label>
      </h2>
      <p id={helpId}>{NOTES_HELP}</p>
      <textarea
        id={NOTES_BOX_ID}
        aria-describedby={helpId}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        readOnly={running}
        rows={8}
        maxLength={MAX_NOTES_CHARS}
        autoComplete="off"
        className={`${fieldClass} h-auto py-2`}
      />
      <p>{NOTES_NOT_SAVED}</p>
      <div>
        <Button type="button" variant="outline" onClick={clearNotes} disabled={running || notes.length === 0}>
          {NOTES_CLEAR_BUTTON}
        </Button>
      </div>
    </section>
  );
}
