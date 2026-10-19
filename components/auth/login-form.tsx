"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { fieldClass } from "./auth-card";

// Fixed messages only: never echo what the server said, and never reveal whether an address has
// an account (a wrong password and an unknown address look the same).
function messageFor(error: { status?: number; code?: string } | null): string | null {
  if (!error) return null;
  if (error.status === 429) return "Too many attempts. Wait a few minutes and try again.";
  if (error.code === "EMAIL_NOT_VERIFIED") return "Verify your email address first. We sent you a new link.";
  if (error.status === 401) return "Email or password is incorrect.";
  return "Could not sign in. Try again.";
}

function codeMessageFor(error: { status?: number; code?: string } | null): string | null {
  if (!error) return null;
  if (error.status === 429) return "Too many attempts. Wait a few minutes and try again.";
  if (error.code === "INVALID_TWO_FACTOR_COOKIE" || error.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE")
    return "That sign-in expired. Enter your password again.";
  return "That code is not right. Try again.";
}

export function LoginForm() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The password was accepted and a code is needed. The password is not kept in the page.
  const [codeStep, setCodeStep] = useState(false);
  const [useBackup, setUseBackup] = useState(false);

  function finish() {
    // The cookie is already stored; refresh so server components render for the new session.
    router.replace("/account");
    router.refresh();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setMessage(null);
    const { data, error } = await authClient.signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    if (error) {
      setMessage(messageFor(error));
      setPending(false);
      return;
    }
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      setCodeStep(true);
      setPending(false);
      return;
    }
    finish();
  }

  async function onCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const code = String(form.get("code") ?? "").trim();
    const trustDevice = form.get("trust") === "on";
    setPending(true);
    setMessage(null);
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice });
    if (error) {
      setMessage(codeMessageFor(error));
      setPending(false);
      return;
    }
    finish();
  }

  if (codeStep) {
    return (
      <form onSubmit={onCode} className="flex flex-col gap-3">
        <p className="text-sm">
          {useBackup ? "Enter one of your backup codes. Each works once." : "Enter the 6-digit code from your authenticator app."}
        </p>
        <label className="flex flex-col gap-1 text-sm">
          {useBackup ? "Backup code" : "Code"}
          <input
            name="code"
            type="text"
            inputMode={useBackup ? "text" : "numeric"}
            autoComplete="one-time-code"
            required
            className={fieldClass}
          />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input name="trust" type="checkbox" className="mt-1" />
          <span>Trust this device for 14 days. Only on a device you own and do not share. You will still need your password.</span>
        </label>
        {message ? (
          <p role="alert" className="text-sm text-red-700">
            {message}
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Checking…" : "Continue"}
        </Button>
        <button type="button" className="text-left text-sm underline" onClick={() => setUseBackup((v) => !v)}>
          {useBackup ? "Use my authenticator app instead" : "Use a backup code instead"}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input name="email" type="email" autoComplete="username" required className={fieldClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input name="password" type="password" autoComplete="current-password" required className={fieldClass} />
      </label>
      {message ? (
        <p role="alert" className="text-sm text-red-700">
          {message}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <Link href="/forgot-password" className="text-sm underline">
        Forgot your password?
      </Link>
    </form>
  );
}
