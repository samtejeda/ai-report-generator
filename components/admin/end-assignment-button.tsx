"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { callAdminApi } from "@/lib/admin/api-call";
import { adminErrorMessage } from "@/lib/admin/messages";

// Owner only. Ends one assignment (the row stays, marked ended); the person loses that client on
// their next request. `description` is only the accessible name, e.g. "Alex Doe, Sam Client".
export function EndAssignmentButton({ assignmentId, description }: { assignmentId: string; description: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
    if (!window.confirm("End this assignment? The person loses access to this client on their next request.")) return;
    setPending(true);
    setMessage(null);
    const result = await callAdminApi(`/api/admin/assignments/${assignmentId}`, "DELETE");
    setPending(false);
    if (!result.ok) return setMessage(adminErrorMessage("end_assignment", result.failure));
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <Button type="button" variant="outline" onClick={onClick} disabled={pending} aria-label={`End assignment: ${description}`}>
        End
      </Button>
      {message ? <p role="alert">{message}</p> : null}
    </div>
  );
}
