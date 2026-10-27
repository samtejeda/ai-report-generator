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

// "Generate test text" for one empty prose section. The server decides everything (role, status,
// that the section is empty, the practice's endpoint, the limits); this only asks and reports.
// Success is a page refresh: the report becomes `generated`, the section's key changes with its
// version, and the editor remounts with the stored text. `boxHasText` disables the button because
// that refresh would silently throw away text typed but not saved (audit 01 item 7).
export function GenerateSectionButton({ reportId, sectionId, boxHasText }: { reportId: string; sectionId: string; boxHasText: boolean }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const busy = running || refreshing;

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
