"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

// Shown only when the report is "generated"; the server refuses any other state with a 409.
export function FinalizeButton({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
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
    </div>
  );
}
