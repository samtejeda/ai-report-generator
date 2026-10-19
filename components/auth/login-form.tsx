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

export function LoginForm() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setMessage(null);
    const { error } = await authClient.signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    if (error) {
      setMessage(messageFor(error));
      setPending(false);
      return;
    }
    // The cookie is already stored; refresh so server components render for the new session.
    router.replace("/account");
    router.refresh();
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
