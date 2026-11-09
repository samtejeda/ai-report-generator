"use client";

import { useEffect, useRef } from "react";
import { UnsavedList } from "@/components/unsaved/unsaved-list";
import { focusSectionBox } from "@/components/unsaved/focus-section-box";
import { Button } from "@/components/ui/button";
import { FINALIZE_BLOCKED_HEADING, FINALIZE_BLOCKED_NEXT, finalizeBlockedIntro, GO_BACK_BUTTON } from "@/lib/reports/finalize-check";

// Shown when Finalize is pressed with unsaved changes (lib/reports/finalize-check.ts). A native
// modal <dialog>: focus is held inside it, the page behind is inert, and Esc closes it. It has ONE
// way forward, "Go back and save", which is also what Esc does; there is no "finalize anyway". On
// close the cursor goes to the first unsaved box (after closing, or the browser's own focus
// restoration would win).
export function FinalizeBlockedDialog({ blocked, onClose }: { blocked: { titles: string[]; firstKey: string } | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (blocked) lastKey.current = blocked.firstKey;
    if (blocked && !dialog.open) {
      dialog.showModal();
      buttonRef.current?.focus();
    } else if (!blocked && dialog.open) {
      dialog.close();
      const key = lastKey.current;
      if (key) focusSectionBox(key);
    }
  }, [blocked]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="finalize-blocked-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-md border border-zinc-400 p-4 backdrop:bg-black/40"
    >
      {blocked ? (
        <div className="flex flex-col gap-3 text-sm">
          <h2 id="finalize-blocked-heading" className="text-base font-semibold">
            {FINALIZE_BLOCKED_HEADING}
          </h2>
          <UnsavedList intro={finalizeBlockedIntro(blocked.titles.length)} titles={blocked.titles} />
          <p>{FINALIZE_BLOCKED_NEXT}</p>
          <Button ref={buttonRef} type="button" onClick={onClose}>
            {GO_BACK_BUTTON}
          </Button>
        </div>
      ) : null}
    </dialog>
  );
}
