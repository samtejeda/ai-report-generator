"use client";

// REMOVABLE (Sam, 2026-10-30, PROGRESS.md decisions row 15): the state and handlers for "somebody
// saved this section while you were editing". Delete with lib/reports/section-conflict.ts (+ test),
// components/reports/section-conflict-notice.tsx and the four blocks and two import lines marked REMOVABLE in
// components/reports/section-editor.tsx; a refused save would then show SAVE_FAILED. The server
// refuses a save made from an old version either way, so nothing is ever overwritten.

import { useEffect, useRef, useState } from "react";
import { SAVE_FAILED, SAVE_INVALID } from "@/lib/reports/save-messages";
import { saveSectionCall } from "@/lib/reports/save-section-call";
import {
  CONFLICT_AGAIN,
  decideAfterRefusal,
  readCurrentSection,
  SAVE_CLOSED,
  SAVE_GONE,
  SAVE_UNCHANGED,
  SAVE_UNREADABLE,
  TOOK_THEIRS_NOTE,
  type CurrentSection,
} from "@/lib/reports/section-conflict";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

export function useSectionConflict(opts: {
  reportId: string;
  sectionId: string;
  /** The box as it is right now: "Save mine" sends this, not a copy from when the save was refused. */
  getDraft: () => string;
  /** A save went through (the new version number and the text that was saved). */
  onSaved: (version: number, text: string) => void;
  /** "Use theirs instead": the box and the base version become theirs. */
  onTookTheirs: (theirs: CurrentSection) => void;
  report: (message: string | null) => void;
  note: (message: string | null) => void;
  setBusy: (busy: boolean) => void;
  focusBox: () => void;
}) {
  const { reportId, sectionId, getDraft, onSaved, onTookTheirs, report, note, setBusy, focusBox } = opts;
  const [theirs, setTheirs] = useState<CurrentSection | null>(null);
  const [showTheirs, setShowTheirs] = useState(false);
  const wasOpen = useRef(false);

  // The notice holds another person's text: let go of it when Next hides the page. The person's own
  // draft stays (it is not this hook's).
  useResetWhenHidden(() => {
    setTheirs(null);
    setShowTheirs(false);
  });

  // When the notice closes, the cursor goes back to the box.
  useEffect(() => {
    if (theirs) wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      focusBox();
    }
  }, [theirs, focusBox]);

  /** The save route said 409: find out whether somebody saved first or the report closed. */
  async function handleRefusal(sentBase: number, again = false) {
    const outcome = decideAfterRefusal(await readCurrentSection(reportId, sectionId), sentBase);
    if (outcome.kind === "newer") {
      setTheirs(outcome.theirs);
      setShowTheirs(false);
      return report(again ? CONFLICT_AGAIN : null);
    }
    setTheirs(null);
    report(outcome.kind === "closed" ? SAVE_CLOSED : outcome.kind === "gone" ? SAVE_GONE : outcome.kind === "unreadable" ? SAVE_UNREADABLE : SAVE_UNCHANGED);
  }

  /** "Save mine as the newest version": resend the box with their version as the new base. */
  async function saveMine() {
    if (!theirs) return;
    const mine = getDraft();
    setBusy(true);
    report(null);
    const result = await saveSectionCall(reportId, sectionId, mine, theirs.version);
    if (result.ok) {
      setTheirs(null);
      onSaved(result.version, mine);
    } else if (result.kind === "refused") await handleRefusal(theirs.version, true);
    // Any other failure leaves the notice up so the choice is still there to make.
    else report(result.kind === "invalid" ? SAVE_INVALID : SAVE_FAILED);
    setBusy(false);
  }

  /** "Use theirs instead": mine is dropped, on purpose, by this click. */
  function useTheirs() {
    if (!theirs) return;
    const chosen = theirs;
    setTheirs(null);
    report(null);
    onTookTheirs(chosen);
    note(TOOK_THEIRS_NOTE);
  }

  return { theirs, open: theirs !== null, showTheirs, toggleTheirs: () => setShowTheirs((v) => !v), handleRefusal, saveMine, useTheirs };
}
