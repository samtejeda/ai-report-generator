import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { BackupCodes } from "@/components/auth/backup-codes";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireSession } from "@/lib/auth/server";

export const metadata: Metadata = { title: "Account", robots: { index: false } };

// Proving ground for requireSession(): the page re-checks the session itself, so it is
// protected even if the proxy or a layout is ever removed.
async function AccountDetails() {
  const { role } = await requireSession();
  return (
    <>
      <p className="text-sm">You are signed in as {role}.</p>
      <ChangePasswordForm />
      <BackupCodes />
      <SignOutButton />
    </>
  );
}

export default function AccountPage() {
  return (
    <AuthCard title="Account">
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <AccountDetails />
      </Suspense>
    </AuthCard>
  );
}
