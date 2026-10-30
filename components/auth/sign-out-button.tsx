"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { SIGN_IN_PATH } from "@/lib/auth/landing";
import { SIGN_OUT_FAILED } from "@/lib/auth/login-messages";
import { unsavedStore } from "@/lib/ui/unsaved-store";

export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        disabled={pending}
        onClick={async () => {
          // Ask BEFORE signing out: otherwise the person is signed out first and warned second.
          // Resolves true at once when nothing is unsaved; "Stay and save" ends it here.
          if (!(await unsavedStore.askBeforeLeaving())) return;
          setPending(true);
          setMessage(null);
          let failed = false;
          try {
            const { error } = await authClient.signOut();
            failed = Boolean(error);
          } catch {
            failed = true;
          }
          if (failed) {
            // Still signed in: say so and stay, rather than look as if it worked.
            setPending(false);
            return setMessage(SIGN_OUT_FAILED);
          }
          // A full page load, not router.replace: Next keeps every page you leave alive and hidden
          // and restores its state, so an in-app navigation would leave the signed-in session's
          // pages (and any stuck "Signing out…") behind. A load drops all of them. The button stays
          // "Signing out…" until the page is replaced.
          // The person has already agreed to leave (or nothing was unsaved): keep the browser's own
          // "leave site?" box from asking a second time.
          unsavedStore.allowUnload();
          window.location.assign(SIGN_IN_PATH);
        }}
      >
        {pending ? "Signing out…" : "Sign out"}
      </Button>
      {message ? (
        <p role="alert" className="text-sm">
          {message}
        </p>
      ) : null}
    </div>
  );
}
