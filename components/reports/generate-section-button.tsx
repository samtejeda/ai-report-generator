"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { focusSectionBox } from "@/components/unsaved/focus-section-box";
import { Button } from "@/components/ui/button";
import { GenerateDialogBody } from "@/components/reports/generate-dialog-body";
import { GenerateChoiceDialog } from "@/components/reports/generate-choice-dialog";
import { useGeneration } from "@/components/reports/generation-context";
import { callGenerateSection } from "@/lib/reports/generate-call";
import type { GenerateOffer } from "@/lib/reports/generate-control";
import { buildGenerateBody, checkBeforeGenerate, newRun, nextStep, NOTES_BOX_ID, notesReady, questionLabels, withReplaceConfirmed, withThinConfirmed, type Question, type Run } from "@/lib/reports/generate-flow";
import {
  GENERATE_NEEDS_EMPTY_BOX,
  GENERATE_RUNNING_LABEL,
  GENERATE_WORKING_CLOSE,
  GENERATE_WORKING_LABEL,
  generateButtonLabel,
  generatedResult,
  generateNote,
  generateWorkingStatus,
  NOTES_NEEDED,
  REGENERATE_NOTE,
} from "@/lib/reports/generate-messages";
import { unsavedStore } from "@/lib/ui/unsaved-store";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

// "Generate" for an empty section and "Regenerate" for one with text (lib/reports/generate-control.ts
// decides which, or neither). The server decides everything (role, status, version, the practice's
// endpoint, the limits); this asks and reports.
//
// One press is one run (lib/reports/generate-flow.ts). It starts with NO confirmation. If the
// server says the notes are thin, or that the current text is a person's own edit, NOTHING has
// been generated: a dialog asks, and only the person's click on its second button repeats the call
// with `confirm` or `replaceEdited` (each only for its own question; the safe button is the
// default, has focus and is what Esc does). The notes come from the provider's memory and are
// sent, never kept here. On success the page re-reads itself: the stored text, version and review
// flags come from the database, not from the response.
export function GenerateSectionButton({
  reportId,
  sectionId,
  offer,
  version,
  boxHasText,
}: {
  reportId: string;
  sectionId: string;
  offer: Exclude<GenerateOffer, null>;
  /** The version the person sees (0 for an empty section); sent as `baseVersion`. */
  version: number;
  boxHasText: boolean;
}) {
  const router = useRouter();
  const gen = useGeneration();
  const { realMode } = gen;
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Question | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const resultRef = useRef<HTMLParagraphElement>(null);
  const afterRef = useRef<(() => void) | null>(null);
  const busy = gen.running || refreshing;
  // Next keeps this page alive and hidden and restores it: no stale line, no open question.
  useResetWhenHidden(() => {
    setMessage(null);
    setResult(null);
    setDialog(null);
  });

  // The result is announced and the cursor goes to it (the button that was pressed may have changed).
  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  async function execute(run: Run) {
    if (!gen.startRun()) return;
    setDialog(null);
    setMessage(null);
    setResult(null);
    setWorking(true);
    const body = buildGenerateBody({ realMode, notes: gen.notes, baseVersion: version, run });
    const answer = await callGenerateSection(reportId, sectionId, body, realMode);
    gen.endRun();
    setWorking(false);
    const step = nextStep(answer, realMode);
    switch (step.step) {
      case "done":
        setResult(generatedResult(realMode, step.version));
        return startRefresh(() => router.refresh());
      case "ask_replace":
        return setDialog({ kind: "replace", run });
      case "ask_thin":
        return setDialog({ kind: "thin", run, missing: step.missing, sensitive: step.sensitive });
      case "error":
        setMessage(step.message);
        if (step.refresh) startRefresh(() => router.refresh());
    }
  }

  function onClick() {
    // Unsaved text anywhere is asked about before anything is sent (the server cannot know what is
    // typed in a box, and saving is paused while the model works).
    const check = checkBeforeGenerate(unsavedStore.getSnapshot(), sectionId);
    if (check.action === "go") return void execute(newRun());
    setDialog({ kind: check.action, titles: check.titles, firstKey: check.firstKey });
  }

  /** The safe choice of whatever is asked (also Esc). */
  function onSafe() {
    if (!dialog) return;
    if (dialog.kind === "thin") afterRef.current = () => document.getElementById(NOTES_BOX_ID)?.focus();
    else if (dialog.kind === "warn" || dialog.kind === "blocked") {
      const key = dialog.firstKey;
      afterRef.current = () => void focusSectionBox(key);
    } else afterRef.current = null;
    setDialog(null);
  }

  function onOther() {
    if (!dialog) return;
    if (dialog.kind === "thin") void execute(withThinConfirmed(dialog.run));
    else if (dialog.kind === "replace") void execute(withReplaceConfirmed(dialog.run));
    else if (dialog.kind === "warn") void execute(newRun());
  }

  const needsEmptyBox = offer === "generate" && boxHasText;
  const notesOk = notesReady(realMode, gen.notes);
  const noteId = `generate-note-${sectionId}`;
  const labels = questionLabels(dialog);

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" onClick={onClick} disabled={busy || needsEmptyBox || !notesOk} aria-busy={busy} aria-describedby={noteId}>
        {working ? (realMode ? GENERATE_WORKING_LABEL : GENERATE_RUNNING_LABEL) : generateButtonLabel(offer, realMode)}
      </Button>
      <p id={noteId}>{generateNote(realMode)}</p>
      {offer === "regenerate" ? <p>{REGENERATE_NOTE}</p> : null}
      {needsEmptyBox && !busy ? <p>{GENERATE_NEEDS_EMPTY_BOX}</p> : null}
      {!notesOk && !busy ? <p>{NOTES_NEEDED}</p> : null}
      {working ? <p role="status">{generateWorkingStatus(realMode)}</p> : null}
      {working && realMode ? <p>{GENERATE_WORKING_CLOSE}</p> : null}
      {result ? (
        <p ref={resultRef} tabIndex={-1} role="status">
          {result}
        </p>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
      <GenerateChoiceDialog
        open={dialog !== null}
        heading={labels.heading}
        safeLabel={labels.safe}
        onSafe={onSafe}
        otherLabel={labels.other}
        onOther={onOther}
        afterSafeClose={() => afterRef.current?.()}
      >
        {dialog ? <GenerateDialogBody dialog={dialog} /> : null}
      </GenerateChoiceDialog>
    </div>
  );
}
