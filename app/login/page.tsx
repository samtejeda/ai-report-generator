import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";
import { SignedOutOnly } from "@/components/auth/signed-out-only";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default function LoginPage() {
  return (
    <AuthCard title="Sign in">
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <SignedOutOnly>
          <LoginForm />
        </SignedOutOnly>
      </Suspense>
    </AuthCard>
  );
}
