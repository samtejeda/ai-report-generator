import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { SignedOutOnly } from "@/components/auth/signed-out-only";

export const metadata: Metadata = { title: "Reset your password", robots: { index: false } };

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Reset your password">
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <SignedOutOnly>
          <ForgotPasswordForm />
        </SignedOutOnly>
      </Suspense>
    </AuthCard>
  );
}
