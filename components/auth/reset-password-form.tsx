"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/config";
import { resetFormWhenHidden, useResetWhenHidden } from "@/lib/ui/reset-when-hidden";
import { PasswordField } from "./password-field";

export function ResetPasswordForm({ token }: { token: string | null }) {
  const [invalidLink, setInvalidLink] = useState(!token);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  // Next keeps this page alive and hidden and restores it. After a successful reset the link is spent,
  // so the restored page says so instead of showing "done" or a form that can only fail.
  useResetWhenHidden(() => {
    setMessage(null);
    if (done) {
      setDone(false);
      setInvalidLink(true);
    }
  });

  useEffect(() => {
    // Keep the token out of the address bar, history and screenshots once it is in memory.
    if (token) window.history.replaceState(null, "", "/reset-password");
  }, [token]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("password") ?? "");
    if (newPassword !== String(form.get("confirm") ?? "")) {
      setMessage("The two passwords do not match.");
      return;
    }
    setPending(true);
    setMessage(null);
    const { error } = await authClient.resetPassword({ newPassword, token: token ?? "" });
    setPending(false);
    if (!error) return setDone(true);
    if (error.status === 429) return setMessage("Too many attempts. Wait a few minutes and try again.");
    if (error.code === "INVALID_TOKEN") return setInvalidLink(true);
    if (error.code === "PASSWORD_TOO_SHORT") return setMessage(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
    setMessage("Could not reset the password. Try again.");
  }

  if (done) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p>Your password was changed and every other session was signed out.</p>
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </div>
    );
  }

  if (invalidLink) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p>This reset link is invalid or has expired. Links work once and last 60 minutes.</p>
        <Link href="/forgot-password" className="underline">
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <form ref={resetFormWhenHidden} onSubmit={onSubmit} className="flex flex-col gap-3">
      <PasswordField label="New password" name="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />
      <PasswordField label="Confirm new password" name="confirm" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />
      {message ? (
        <p role="alert" className="text-sm text-red-700">
          {message}
        </p>
      ) : null}
      <Button type="submit" disabled={pending || !token}>
        {pending ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}
