"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/config";
import { changePasswordErrorMessage, validatePasswordChange } from "@/lib/auth/password-form";
import { fieldClass } from "./auth-card";

// Plain form on /account. It calls the existing POST /api/auth/change-password (through Better
// Auth's client), which re-checks the current password, rate-limits, signs out other sessions on
// request, emails a notice and writes the audit row. Nothing here is a gate; fixed messages only.
export function ChangePasswordForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const invalid = validatePasswordChange(currentPassword, newPassword, String(form.get("confirm") ?? ""));
    setDone(false);
    if (invalid) return setMessage(invalid);

    setPending(true);
    setMessage(null);
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: form.get("revokeOthers") === "on",
    });
    setPending(false);
    if (error) return setMessage(changePasswordErrorMessage(error));
    formRef.current?.reset();
    setDone(true);
    router.refresh();
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-3 border-t border-zinc-200 pt-4">
      <h2 className="text-base font-semibold">Change password</h2>
      <label className="flex flex-col gap-1 text-sm">
        Current password
        <input name="currentPassword" type="password" autoComplete="current-password" required className={fieldClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        New password ({PASSWORD_MIN_LENGTH} to {PASSWORD_MAX_LENGTH} characters)
        <input name="newPassword" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} className={fieldClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Repeat the new password
        <input name="confirm" type="password" autoComplete="new-password" required className={fieldClass} />
      </label>
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
