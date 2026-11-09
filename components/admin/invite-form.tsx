"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { fieldClass } from "@/components/auth/auth-card";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Button } from "@/components/ui/button";
import { callAdminApi } from "@/lib/admin/api-call";
import { INVITE_CREATED_MESSAGE, validateInviteEmail } from "@/lib/admin/invitation-view";
import { adminErrorMessage, needsReauth } from "@/lib/admin/messages";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

// Owner only. Email only: the role is fixed to associate (the server refuses any other, and this
// form sends none). The server decides whether the address is acceptable and hides whether it already
// has an account, so a success always shows the same sentence. Creating needs a sign-in from the
// last few minutes; if it is older we say so and offer sign-out, as the inference-endpoint screen does.
export function InviteForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [pending, setPending] = useState(false);

  // Next keeps this page alive and hidden and restores its state: no stale "created" line, error or
  // re-sign-in prompt on return. The address in the box is kept.
  useResetWhenHidden(() => {
    setMessage(null);
    setCreated(false);
    setReauth(false);
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const problem = validateInviteEmail(email);
    setCreated(false);
    setReauth(false);
    if (problem) return setMessage(problem);
    setPending(true);
    setMessage(null);
    const result = await callAdminApi("/api/admin/invitations", "POST", { email: email.trim() });
    setPending(false);
    if (!result.ok) {
      setReauth(needsReauth(result.failure));
      return setMessage(adminErrorMessage("invite", result.failure));
    }
    setEmail("");
    setCreated(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        Email address
        <input
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={254}
          required
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className={fieldClass}
        />
      </label>
      <p>They join as an associate and see no client until you assign one.</p>
      {message ? <p role="alert">{message}</p> : null}
      {reauth ? <SignOutButton /> : null}
      {created ? <p role="status">{INVITE_CREATED_MESSAGE}</p> : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Inviting…" : "Invite an associate"}
        </Button>
      </div>
    </form>
  );
}
