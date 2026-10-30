import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { leaveIfSignedIn } from "@/lib/auth/visitor";

// The link's token arrives in the query string; next.config.ts sends no Referer from this page.
export const metadata: Metadata = { title: "Choose a new password", robots: { index: false } };

async function ResetForm({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token, error } = await searchParams;
  // A signed-in person who typed this address goes home; one who opened an emailed link (a token or
  // an error in the address) is shown the page, so the link still works.
  await leaveIfSignedIn({ resetLink: Boolean(token || error) });
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
