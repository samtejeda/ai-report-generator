import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";
import { SignedOutOnly } from "@/components/auth/signed-out-only";
import { INVITED_FLAG, loginNotice } from "@/lib/auth/login-notice";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

// The only thing read from the address is a fixed flag set after an invitation was accepted
// (lib/auth/login-notice.ts); it carries no data and anything else shows nothing.
async function Form({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  return <LoginForm notice={loginNotice(params[INVITED_FLAG])} />;
}

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <AuthCard title="Sign in">
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <SignedOutOnly>
          <Form searchParams={searchParams} />
        </SignedOutOnly>
      </Suspense>
    </AuthCard>
  );
}
