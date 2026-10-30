"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Button } from "@/components/ui/button";
import { callAdminApi } from "@/lib/admin/api-call";
import { adminErrorMessage, needsReauth } from "@/lib/admin/messages";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

// Owner only, for an associate or admin who lost their phone and backup codes. The route needs a
// sign-in from the last few minutes; if it is older we say so and offer sign-out (there is no
// password prompt on the route). Never offered for oneself or another owner. It stays on screen
// after a reset (disabled, nothing left to reset) so the confirmation below it is not lost.
export function ResetMfaButton({ userId, name, enrolled }: { userId: string; name: string; enrolled: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [pending, setPending] = useState(false);

  // Next keeps this page alive and hidden and restores its state: do not come back to a stale "Authenticator reset" line, error or re-sign-in prompt.
  useResetWhenHidden(() => {
    setMessage(null);
    setDone(false);
    setReauth(false);
  });

  async function onClick() {
    if (!window.confirm("Reset this person's authenticator? They are signed out everywhere and must set up a new phone at their next sign-in. Their password does not change.")) return;
    setPending(true);
    setMessage(null);
    setDone(false);
    setReauth(false);
    const result = await callAdminApi(`/api/admin/users/${userId}/reset-mfa`, "POST");
    setPending(false);
    if (!result.ok) {
      setReauth(needsReauth(result.failure));
      return setMessage(adminErrorMessage("reset_mfa", result.failure));
    }
    setDone(true);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <Button type="button" variant="outline" onClick={onClick} disabled={pending || !enrolled} aria-label={`Reset authenticator of ${name}`}>
        Reset authenticator
      </Button>
      {message ? <p role="alert">{message}</p> : null}
      {reauth ? <SignOutButton /> : null}
      {done ? <p role="status">Authenticator reset. They set up a new phone at their next sign-in.</p> : null}
    </div>
  );
}
