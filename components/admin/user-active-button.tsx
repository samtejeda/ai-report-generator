"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { callAdminApi } from "@/lib/admin/api-call";
import { adminErrorMessage } from "@/lib/admin/messages";

// Deactivate or reactivate one person. Shown only where the server's own rule would allow it;
// the route checks again. Deactivation ends their sessions on their next request.
export function UserActiveButton({ userId, name, active }: { userId: string; name: string; active: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
    if (active && !window.confirm("Deactivate this person? They are signed out and cannot sign in until you reactivate them.")) return;
    setPending(true);
    setMessage(null);
    const result = await callAdminApi(`/api/admin/users/${userId}/${active ? "deactivate" : "reactivate"}`, "POST");
    setPending(false);
    if (!result.ok) return setMessage(adminErrorMessage(active ? "deactivate" : "reactivate", result.failure));
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <Button type="button" variant={active ? "destructive" : "outline"} onClick={onClick} disabled={pending} aria-label={`${active ? "Deactivate" : "Reactivate"} ${name}`}>
        {active ? "Deactivate" : "Reactivate"}
      </Button>
      {message ? <p role="alert">{message}</p> : null}
    </div>
  );
}
