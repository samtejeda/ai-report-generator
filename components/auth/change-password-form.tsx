"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/config";
import { captureWait } from "@/lib/auth/rate-limit-wait";
import { changePasswordErrorMessage, validatePasswordChange } from "@/lib/auth/password-form";
import { resetFormWhenHidden, useResetWhenHidden } from "@/lib/ui/reset-when-hidden";
import { PasswordField } from "./password-field";

// Plain form on /account. It calls the existing POST /api/auth/change-password (through Better
// Auth's client), which re-checks the current password, rate-limits, signs out other sessions on
// request, emails a notice and writes the audit row. Nothing here is a gate; fixed messages only.
export function ChangePasswordForm() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  // Next keeps this page alive and hidden and restores it: without this, "Your password was changed."
  // and any typed password would still be there on return.
  useResetWhenHidden(() => {
    setMessage(null);
    setDone(false);
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const invalid = validatePasswordChange(currentPassword, newPassword, String(form.get("confirm") ?? ""));
    setDone(false);
    if (invalid) return setMessage(invalid);

    setPending(true);
    setMessage(null);
    const wait = captureWait();
    const { error } = await authClient.changePassword(
      {
        currentPassword,
        newPassword,
        revokeOtherSessions: form.get("revokeOthers") === "on",
      },
      wait.fetchOptions,
    );
    setPending(false);
    if (error) return setMessage(changePasswordErrorMessage(error, wait.seconds()));
    formElement.reset();
    setDone(true);
    router.refresh();
  }

  return (
    <form ref={resetFormWhenHidden} onSubmit={onSubmit} className="flex flex-col gap-3 border-t border-zinc-200 pt-4">
      <h2 className="text-base font-semibold">Change password</h2>
      <PasswordField label="Current password" name="currentPassword" autoComplete="current-password" />
      <PasswordField label="New password" hint={`(${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters)`} name="newPassword" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} />
      <PasswordField label="Repeat the new password" name="confirm" autoComplete="new-password" />
      <label className="flex items-start gap-2 text-sm">
        <input name="revokeOthers" type="checkbox" defaultChecked className="mt-1" />
        <span>Sign out my other sessions.</span>
      </label>
      {message ? (
        <p role="alert" className="text-sm text-red-700">
          {message}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm">
          Your password was changed.
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}
