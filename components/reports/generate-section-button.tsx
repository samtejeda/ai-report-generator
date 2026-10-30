"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { callGenerateSection } from "@/lib/reports/generate-call";
import {
  failureMayHaveChangedState,
  generateErrorMessage,
  GENERATE_BUTTON_LABEL,
  GENERATE_NEEDS_EMPTY_BOX,
  GENERATE_NOTE,
  GENERATE_RUNNING_LABEL,
  GENERATE_RUNNING_STATUS,
} from "@/lib/reports/generate-messages";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

// "Generate test text" for one empty prose section. The server decides everything (role, status,
// that the section is empty, the practice's endpoint, the limits); this only asks and reports.
// Success is a page refresh: the report becomes `generated` and the editor follows the stored text
// because its box is empty (an untouched box follows the server; reconcileDraft in
// lib/reports/save-section-call.ts). `boxHasText` still disables the button: Generate fills an
// empty section only, and text typed but not saved must never be mistaken for one.
export function GenerateSectionButton({ reportId, sectionId, boxHasText }: { reportId: string; sectionId: string; boxHasText: boolean }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const busy = running || refreshing;
  // Next keeps this page alive and hidden and restores it: do not come back to a stale error line.
  useResetWhenHidden(() => setMessage(null));

  async function onClick() {
    setRunning(true);
    setMessage(null);
    const result = await callGenerateSection(reportId, sectionId);
    setRunning(false);
    if (result.ok) return startRefresh(() => router.refresh());
    setMessage(generateErrorMessage(result.failure, result.retryAfterSeconds));
    if (failureMayHaveChangedState(result.failure)) startRefresh(() => router.refresh());
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" onClick={onClick} disabled={busy || boxHasText} aria-busy={busy} aria-describedby={`generate-note-${sectionId}`}>
        {busy ? GENERATE_RUNNING_LABEL : GENERATE_BUTTON_LABEL}
      </Button>
      <p id={`generate-note-${sectionId}`}>{GENERATE_NOTE}</p>
      {boxHasText && !busy ? <p>{GENERATE_NEEDS_EMPTY_BOX}</p> : null}
      {busy ? <p role="status">{GENERATE_RUNNING_STATUS}</p> : null}
      {message ? <p role="alert">{message}</p> : null}
    </div>
  );
}
