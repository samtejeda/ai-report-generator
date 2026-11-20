"use client";

import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

// One native modal <dialog> for the three questions Generate can ask (thin notes, replace a
// person's text, unsaved text elsewhere) and the one block. Same behaviour as the Finalize and
// Download dialogs: focus is held inside and the page behind is inert; the SAFE button has focus
// when it opens; Esc does the same as the safe button (the cancel event is turned into onSafe).
// The other choice, when there is one, is the second, outline button. `afterSafeClose` runs after
// the dialog has closed from the safe choice or Esc (the browser would restore focus to the
// opener and win otherwise): the caller puts the cursor in the notes box or the first unsaved box.
export function GenerateChoiceDialog({
  open,
  heading,
  children,
  safeLabel,
  onSafe,
  otherLabel,
  onOther,
  afterSafeClose,
}: {
  open: boolean;
  heading: string;
  children: ReactNode;
  safeLabel: string;
  onSafe: () => void;
  otherLabel?: string;
  onOther?: () => void;
  afterSafeClose?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const safeRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const safeChosen = useRef(false);
  const latestAfter = useRef(afterSafeClose);
  useLayoutEffect(() => {
    latestAfter.current = afterSafeClose;
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      safeRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      if (safeChosen.current) latestAfter.current?.();
      safeChosen.current = false;
    }
  }, [open]);

  function safe() {
    safeChosen.current = true;
    onSafe();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        safe();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-md border border-zinc-400 p-4 backdrop:bg-black/40"
    >
      {open ? (
        <div className="flex flex-col gap-3 text-sm">
          <h2 id={headingId} className="text-base font-semibold">
            {heading}
          </h2>
          {children}
          <div className="flex flex-wrap gap-2">
            <Button ref={safeRef} type="button" onClick={safe}>
              {safeLabel}
            </Button>
            {otherLabel && onOther ? (
              <Button type="button" variant="outline" onClick={onOther}>
                {otherLabel}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
