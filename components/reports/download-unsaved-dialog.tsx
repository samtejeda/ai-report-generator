"use client";

import { useEffect, useRef } from "react";
import { focusSectionBox } from "@/components/unsaved/focus-section-box";
import { UnsavedList } from "@/components/unsaved/unsaved-list";
import { Button } from "@/components/ui/button";
import { DOWNLOAD_ANYWAY_BUTTON, DOWNLOAD_UNSAVED_HEADING, DOWNLOAD_UNSAVED_NEXT, downloadUnsavedIntro, GO_BACK_BUTTON } from "@/lib/reports/export-download";

// Shown when "Download Word file" is pressed with unsaved changes (lib/reports/export-download.ts).
// Same native modal <dialog> as the Finalize one: focus is held inside, the page behind is inert.
// TWO choices, because the file is only a copy and the report stays open: "Go back and save" is the
// default (it has focus, and Esc does the same) and puts the cursor in the first unsaved box;
// "Download anyway" closes the dialog and starts the download.
export function DownloadUnsavedDialog({
  warn,
  onGoBack,
  onDownloadAnyway,
}: {
  warn: { titles: string[]; firstKey: string } | null;
  onGoBack: () => void;
  onDownloadAnyway: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const goBackRef = useRef<HTMLButtonElement>(null);
  const lastKey = useRef<string | null>(null);
  // Only "Go back and save" (and Esc) moves the cursor to the unsaved box; "Download anyway" leaves focus where it was.
  const focusBoxOnClose = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (warn) lastKey.current = warn.firstKey;
    if (warn && !dialog.open) {
      dialog.showModal();
      goBackRef.current?.focus();
    } else if (!warn && dialog.open) {
      dialog.close();
      const key = lastKey.current;
      if (focusBoxOnClose.current && key) focusSectionBox(key);
      focusBoxOnClose.current = false;
    }
  }, [warn]);

  function goBack() {
    focusBoxOnClose.current = true;
    onGoBack();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="download-unsaved-heading"
      onCancel={(event) => {
        event.preventDefault();
        goBack();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-md border border-zinc-400 p-4 backdrop:bg-black/40"
    >
      {warn ? (
        <div className="flex flex-col gap-3 text-sm">
          <h2 id="download-unsaved-heading" className="text-base font-semibold">
            {DOWNLOAD_UNSAVED_HEADING}
          </h2>
          <UnsavedList intro={downloadUnsavedIntro(warn.titles.length)} titles={warn.titles} />
          <p>{DOWNLOAD_UNSAVED_NEXT}</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={goBackRef} type="button" onClick={goBack}>
              {GO_BACK_BUTTON}
            </Button>
            <Button type="button" variant="outline" onClick={onDownloadAnyway}>
              {DOWNLOAD_ANYWAY_BUTTON}
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
