"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { callAdminApi } from "@/lib/admin/api-call"; // not admin-specific: our own routes, status and error code only
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/config";
import { acceptOutcome, INVALID_LINK_MESSAGE, NAME_MAX_LENGTH, validateAcceptForm } from "@/lib/auth/invitation-accept-form";
import { INVITED_PATH } from "@/lib/auth/login-notice";
import { resetFormWhenHidden, useResetWhenHidden } from "@/lib/ui/reset-when-hidden";
import { fieldClass } from "./auth-card";
import { PasswordField } from "./password-field";

// Turns an emailed single-use link into an account. The token is the credential, so:
//  - it leaves the address bar, history and screenshots as soon as the page is in memory;
//  - it goes only in the POST body, never a URL, storage, a log or a message;
//  - this component's copy of it is dropped the moment the link proves unusable or is spent;
//  - one sentence for every bad link, whatever the reason (the server answers the same way);
//  - success is a FULL page load of /login, which drops every kept-alive page and the password.
// No session is created here: the person signs in normally and sets up the authenticator app then.
export function AcceptInvitationForm({ token }: { token: string | null }) {
  const [heldToken, setHeldToken] = useState(token);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  // Next keeps this page alive and hidden and restores it: no stale message, and the passwords go
  // (the callback ref on the form). The name stays (it is not a secret).
  useResetWhenHidden(() => {
    setMessage(null);
    setPending(false);
  });

  useEffect(() => {
    // Keep the token out of the address bar, history and screenshots once it is in memory.
    if (token) window.history.replaceState(null, "", "/accept-invitation");
  }, [token]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!heldToken || pending) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "");
    const password = String(form.get("password") ?? "");
    const problem = validateAcceptForm(name, password, String(form.get("confirm") ?? ""));
    if (problem) {
      setMessage(problem);
      return;
    }
    setPending(true);
    setMessage(null);
    const result = await callAdminApi("/api/invitations/accept", "POST", { token: heldToken, name, password });
    if (!result.ok) {
      const outcome = acceptOutcome(result.failure);
      // An unusable link cannot be retried: let go of the token and show only the one sentence.
      if (outcome.kind === "invalid_link") setHeldToken(null);
      setMessage(outcome.message);
      setPending(false);
      return;
    }
    // Spent: let go of the token and the typed password, then load the sign-in page afresh.
    formElement.reset();
    setHeldToken(null);
    setDone(true);
    window.location.assign(INVITED_PATH);
  }

  if (done) return <p className="text-sm">Your account is ready. Taking you to sign in…</p>;

  if (!heldToken) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p role={message ? "alert" : undefined}>{INVALID_LINK_MESSAGE}</p>
        <Link href="/login" className="underline">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form ref={resetFormWhenHidden} onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Your name
        <input name="name" type="text" autoComplete="name" required maxLength={NAME_MAX_LENGTH} className={fieldClass} />
      </label>
      <PasswordField label="Password" hint={`(${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters)`} name="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} />
      <PasswordField label="Confirm password" name="confirm" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} />
      {message ? (
        <p role="alert" className="text-sm text-red-700">
          {message}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
