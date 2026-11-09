"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FinalizeBlockedDialog } from "@/components/reports/finalize-blocked-dialog";
import { checkBeforeFinalize } from "@/lib/reports/finalize-check";
import { unsavedStore } from "@/lib/ui/unsaved-store";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

// Shown only when the report is "generated"; the server refuses any other state with a 409.
export function FinalizeButton({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [blocked, setBlocked] = useState<{ titles: string[]; firstKey: string } | null>(null);
  // The popup is a message, not a draft: let go of it when Next hides the page.
  useResetWhenHidden(() => {
    setMessage(null);
    setBlocked(null);
  });

  async function onClick() {
    // Unsaved text would be left out and its box would disappear when the report closes, so with
    // anything unsaved nothing is asked and nothing is sent: the popup shows what is unsaved and
    // the one way forward is to go back and save. The server cannot know what is typed in a box.
    const check = checkBeforeFinalize(unsavedStore.getSnapshot());
    if (check.action === "blocked") return setBlocked({ titles: check.titles, firstKey: check.firstKey });
    if (!window.confirm("Finalize this report? It cannot be edited afterwards.")) return;
    setPending(true);
    setMessage(null);
    const res = await fetch(`/api/reports/${reportId}/finalize`, { method: "POST" }).catch(() => null);
    setPending(false);
    if (res?.ok) return router.refresh();
    setMessage(res?.status === 409 ? "This report cannot be finalized in its current state." : "The report could not be finalized.");
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <Button type="button" onClick={onClick} disabled={pending}>
        Finalize report
      </Button>
      {message ? <p role="alert">{message}</p> : null}
      <FinalizeBlockedDialog blocked={blocked} onClose={() => setBlocked(null)} />
    </div>
  );
}
