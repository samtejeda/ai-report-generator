"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";
import { fieldClass } from "./auth-card";

export function ForgotPasswordForm() {
  const [state, setState] = useState<"idle" | "pending" | "sent" | "limited" | "failed">("idle");

  // Next keeps this page alive and hidden and restores it: do not come back to "a link is on its way".
  useResetWhenHidden(() => setState((s) => (s === "pending" ? s : "idle")));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setState("pending");
    const { error } = await authClient.requestPasswordReset({
      email: String(form.get("email") ?? ""),
      redirectTo: "/reset-password",
    });
    if (error?.status === 429) setState("limited");
    else if (error) setState("failed");
    // The same answer whether or not the address has an account.
    else setState("sent");
  }

  if (state === "sent") {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p>If that address has an account, a reset link is on its way. It works once and expires in 60 minutes.</p>
        <Link href="/login" className="underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input name="email" type="email" autoComplete="username" required className={fieldClass} />
      </label>
      {state === "limited" ? (
        <p role="alert" className="text-sm text-red-700">
          Too many requests. Wait a few minutes and try again.
        </p>
      ) : null}
      {state === "failed" ? (
        <p role="alert" className="text-sm text-red-700">
          Could not send the request. Try again.
        </p>
      ) : null}
      <Button type="submit" disabled={state === "pending"}>
        {state === "pending" ? "Sending…" : "Send reset link"}
      </Button>
      <Link href="/login" className="text-sm underline">
        Back to sign in
      </Link>
    </form>
  );
}
