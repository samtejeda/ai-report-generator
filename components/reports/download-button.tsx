"use client";

import { useRef, useState, type MouseEvent } from "react";
import { DownloadUnsavedDialog } from "@/components/reports/download-unsaved-dialog";
import { buttonVariants } from "@/components/ui/button";
import { checkBeforeDownload, DOWNLOAD_BUTTON, DOWNLOAD_LIMIT_HINT, draftNote, exportUrl } from "@/lib/reports/export-download";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";
import { unsavedStore } from "@/lib/ui/unsaved-store";

// "Download Word file": a PLAIN LINK to the export route in a new tab, so the browser saves
// report-<id>.docx itself. Nothing is fetched into JavaScript and nothing is stored here. A refusal
// (the limit of 20 downloads in 10 minutes, or any error) lands in that new tab as the server's own
// fixed sentence, and this tab, with anything typed in it, is never touched. The page cannot read a
// link's answer, so the limit is a fixed hint under the button, not a live wait time.
//
// Shown only to owner and associate (the page decides); the route is the real gate.
// The file holds SAVED text only: with anything unsaved the click is held and a two-choice dialog
// asks first (components/reports/download-unsaved-dialog.tsx).
export function DownloadButton({ reportId, status }: { reportId: string; status: string }) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const goAhead = useRef(false);
  const [warn, setWarn] = useState<{ titles: string[]; firstKey: string } | null>(null);
  // The popup is a message, not a draft: let go of it when Next hides the page.
  useResetWhenHidden(() => setWarn(null));

  // True when the click may proceed (nothing unsaved, or the person chose "Download anyway").
  function mayProceed(): boolean {
    if (goAhead.current) {
      goAhead.current = false;
      return true;
    }
    const check = checkBeforeDownload(unsavedStore.getSnapshot());
    if (check.action === "download") return true;
    setWarn({ titles: check.titles, firstKey: check.firstKey });
    return false;
  }

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!mayProceed()) event.preventDefault();
  }

  // A middle click opens the link in a new tab without a click event: hold it for the same question.
  function onAuxClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button === 1 && !mayProceed()) event.preventDefault();
  }

  function downloadAnyway() {
    setWarn(null);
    goAhead.current = true;
    // The same link, so there is one path to the file. This runs inside the button's own click, so
    // the browser lets the new tab open.
    linkRef.current?.click();
  }

  const note = draftNote(status);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div>
        <a ref={linkRef} href={exportUrl(reportId)} target="_blank" rel="noopener" onClick={onClick} onAuxClick={onAuxClick} className={buttonVariants({ variant: "outline" })}>
          {DOWNLOAD_BUTTON}
        </a>
      </div>
      {note ? <p>{note}</p> : null}
      <p>{DOWNLOAD_LIMIT_HINT}</p>
      <DownloadUnsavedDialog
        warn={warn}
        onGoBack={() => setWarn(null)}
        onDownloadAnyway={downloadAnyway}
      />
    </div>
  );
}
