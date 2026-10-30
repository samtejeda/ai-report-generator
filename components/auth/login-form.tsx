"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { HOME_PATH } from "@/lib/auth/landing";
import { codeErrorMessage, codeStepExpired, signInErrorMessage } from "@/lib/auth/login-messages";
import { resetFormWhenHidden, useResetWhenHidden } from "@/lib/ui/reset-when-hidden";
import { fieldClass } from "./auth-card";
import { PasswordField } from "./password-field";

// Fixed messages only (lib/auth/login-messages.ts): never echo what the server said, and never
// reveal whether an address has an account.
export function LoginForm() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The password was accepted and a code is needed. The password is not kept in the page.
  const [codeStep, setCodeStep] = useState(false);
  const [useBackup, setUseBackup] = useState(false);
  // Only the address (never the password) is kept, so going back to the password step after an
  // expired code step does not make the person retype it.
  const [email, setEmail] = useState("");

  // Next keeps this page alive and hidden after sign-in and restores it: without this, coming back
  // shows the old code step with the button stuck on "Checking…". Nothing typed here is a draft.
  useResetWhenHidden(() => {
    setMessage(null);
    setPending(false);
    setCodeStep(false);
    setUseBackup(false);
    setEmail("");
  });

  function finish() {
    // The cookie is already stored; refresh so server components render for the new session.
    router.replace(HOME_PATH);
    router.refresh();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const typedEmail = String(form.get("email") ?? "");
    setPending(true);
    setMessage(null);
    const { data, error } = await authClient.signIn.email({
      email: typedEmail,
      password: String(form.get("password") ?? ""),
    });
    if (error) {
      setMessage(signInErrorMessage(error));
      setPending(false);
      return;
    }
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      setEmail(typedEmail);
      setCodeStep(true);
      setPending(false);
      return;
    }
    finish();
  }

  async function onCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const code = String(form.get(useBackup ? "backup-code" : "otp-code") ?? "").trim();
    const trustDevice = form.get("trust-device") === "on";
    setPending(true);
    setMessage(null);
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice });
    if (error) {
      setMessage(codeErrorMessage(error));
      setPending(false);
      // The challenge is over: the only way forward is the password again, so go back to it.
      if (codeStepExpired(error)) {
        setCodeStep(false);
        setUseBackup(false);
      }
      return;
    }
    finish();
  }

  if (codeStep) {
    return (
      <form ref={resetFormWhenHidden} onSubmit={onCode} className="flex flex-col gap-3">
        <p className="text-sm">
          {useBackup ? "Enter one of your backup codes. Each works once." : "Enter the 6-digit code from your authenticator app."}
        </p>
        <label className="flex flex-col gap-1 text-sm">
          {useBackup ? "Backup code" : "Code"}
          {/* A distinct name per kind of code, the one-time-code hint, and the opt-outs the common
              password managers honour (1Password, LastPass, Bitwarden). Chrome's own manager has no
              documented opt-out, so a saved password may still be offered here; nothing sensitive
              leaves the browser either way. */}
          <input
            key={useBackup ? "backup" : "totp"}
            name={useBackup ? "backup-code" : "otp-code"}
            type="text"
            inputMode={useBackup ? "text" : "numeric"}
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            required
            className={fieldClass}
          />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input name="trust-device" type="checkbox" className="mt-1" />
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
    <form ref={resetFormWhenHidden} onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input name="email" type="email" autoComplete="username" required defaultValue={email} className={fieldClass} />
      </label>
      <PasswordField label="Password" name="password" autoComplete="current-password" />
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
