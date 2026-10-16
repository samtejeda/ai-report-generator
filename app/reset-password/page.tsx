import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

// The link's token arrives in the query string; next.config.ts sends no Referer from this page.
export const metadata: Metadata = { title: "Choose a new password", robots: { index: false } };

async function ResetForm({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token, error } = await searchParams;
  return <ResetPasswordForm token={error || !token ? null : token} />;
}

export default function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  return (
    <AuthCard title="Choose a new password">
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <ResetForm searchParams={searchParams as Promise<{ token?: string; error?: string }>} />
      </Suspense>
    </AuthCard>
  );
}
