"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { callAdminApi } from "@/lib/admin/api-call";
import { INVITE_RESENT_MESSAGE, INVITE_REVOKED_MESSAGE } from "@/lib/admin/invitation-view";
import { adminErrorMessage } from "@/lib/admin/messages";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

// Owner only: Resend (a new link and a fresh 7 days; the old link stops working) and Revoke (the link
// stops working at once) on one pending or expired invitation. The routes decide; a 409 means it was
// accepted or revoked in the meantime. The buttons say whose invitation they act on, by address, in
// their accessible name (the address is already on screen, from the server).
export function InvitationActions({ id, email }: { id: string; email: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Next keeps this page alive and hidden and restores its state: no stale confirmation or error.
  useResetWhenHidden(() => {
    setMessage(null);
    setStatus(null);
  });

  async function run(action: "resend_invitation" | "revoke_invitation") {
    setPending(true);
    setMessage(null);
    setStatus(null);
    const path = action === "resend_invitation" ? "resend" : "revoke";
    const result = await callAdminApi(`/api/admin/invitations/${id}/${path}`, "POST");
    setPending(false);
    if (!result.ok) return setMessage(adminErrorMessage(action, result.failure));
    setStatus(action === "resend_invitation" ? INVITE_RESENT_MESSAGE : INVITE_REVOKED_MESSAGE);
    router.refresh();
  }

  function onRevoke() {
    if (!window.confirm("Revoke this invitation? Its link stops working at once.")) return;
    void run("revoke_invitation");
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={() => void run("resend_invitation")} aria-label={`Resend invitation to ${email}`}>
          Resend
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onRevoke} aria-label={`Revoke invitation to ${email}`}>
          Revoke
        </Button>
      </div>
      {message ? <p role="alert">{message}</p> : null}
      {status ? <p role="status">{status}</p> : null}
    </div>
  );
}
