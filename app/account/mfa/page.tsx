import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { MfaSetup } from "@/components/auth/mfa-setup";
import { getEnrollingSessionOrNull, getSessionOrNull } from "@/lib/auth/server";

export const metadata: Metadata = { title: "Set up two-step sign-in", robots: { index: false } };

// The one page that accepts a signed-in user who has not finished MFA setup. It re-checks the
// session itself: signed out goes to /login, already enrolled goes to /account.
async function Gate() {
  if (await getSessionOrNull()) redirect("/account");
  if (!(await getEnrollingSessionOrNull())) redirect("/login");
  return <MfaSetup />;
}

export default function MfaPage() {
  return (
    <AuthCard title="Set up two-step sign-in">
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <Gate />
      </Suspense>
    </AuthCard>
  );
}
