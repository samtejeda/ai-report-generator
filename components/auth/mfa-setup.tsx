"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { fieldClass } from "./auth-card";

// Three steps: confirm the password, add the key to an authenticator app and type the first code,
// then save the backup codes (shown once, here, and never again).
type Step = "password" | "code" | "codes";

function secretFrom(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

export function MfaSetup() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("password");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [setupKey, setSetupKey] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  async function onPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setPending(true);
    setMessage(null);
    const { data, error } = await authClient.twoFactor.enable({ password, method: "totp" });
    setPending(false);
    if (error || !data || !("totpURI" in data)) {
      setMessage(error?.status === 429 ? "Too many attempts. Wait a few minutes and try again." : "Could not start setup. Check your password.");
      return;
    }
    setSetupKey(secretFrom(data.totpURI));
    setBackupCodes(data.backupCodes);
    setStep("code");
  }

  async function onCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    setPending(true);
    setMessage(null);
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) {
      setMessage("That code is not right. Check the time on your phone and try again.");
      return;
    }
    setStep("codes");
  }

  if (step === "password") {
    return (
      <form onSubmit={onPassword} className="flex flex-col gap-3">
        <p className="text-sm">Two-step sign-in is required. You will need an authenticator app on your phone. Confirm your password to begin.</p>
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
          {pending ? "Starting…" : "Begin setup"}
        </Button>
      </form>
    );
  }

  if (step === "code") {
    return (
      <form onSubmit={onCode} className="flex flex-col gap-3">
        <p className="text-sm">
          In your authenticator app, add an account and enter this setup key. Choose &quot;time-based&quot; if asked. Then type the 6-digit code the app shows.
        </p>
        <code className="break-all rounded-md border border-zinc-300 p-2 text-sm" data-testid="setup-key">
          {setupKey}
        </code>
        <label className="flex flex-col gap-1 text-sm">
          Code
          <input name="code" type="text" inputMode="numeric" autoComplete="one-time-code" required className={fieldClass} />
        </label>
        {message ? (
          <p role="alert" className="text-sm text-red-700">
            {message}
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Checking…" : "Verify and turn on"}
        </Button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Two-step sign-in is on. Save these backup codes somewhere safe, apart from your phone. Each works once if you lose the phone. They are shown only now.
      </p>
      <ul className="grid grid-cols-2 gap-1 rounded-md border border-zinc-300 p-2 font-mono text-sm" data-testid="backup-codes">
        {backupCodes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <Button
        onClick={() => {
          // Drop the codes from the page before leaving.
          setBackupCodes([]);
          router.replace("/account");
          router.refresh();
        }}
      >
        I have saved them
      </Button>
    </div>
  );
}
