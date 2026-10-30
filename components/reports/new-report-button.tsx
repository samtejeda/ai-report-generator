"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PSYCHOED_TEMPLATE_SLUG } from "@/lib/reports/structure";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

// Owner or associate (the server refuses anyone else). Starts a draft report for this client.
export function NewReportButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useResetWhenHidden(() => setMessage(null));

  async function onClick() {
    setPending(true);
    setMessage(null);
    const res = await fetch("/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, templateSlug: PSYCHOED_TEMPLATE_SLUG }),
    }).catch(() => null);
    setPending(false);
    if (res?.status === 201) {
      const created = (await res.json()) as { data: { id: string } };
      return router.push(`/reports/${created.data.id}`);
    }
    if (res?.status === 409) return setMessage("The practice has no report template ready yet.");
    setMessage("The report could not be started.");
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <Button type="button" onClick={onClick} disabled={pending}>
        New report
      </Button>
      {message ? <p role="alert">{message}</p> : null}
    </div>
  );
}
