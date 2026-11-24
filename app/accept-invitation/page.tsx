import type { Metadata } from "next";
import { Suspense } from "react";
import { AcceptInvitationGate } from "@/components/auth/accept-invitation-gate";
import { AuthCard } from "@/components/auth/auth-card";

// The link's token arrives in the query string; next.config.ts sends no Referer from this page, and the
// form removes it from the address bar on load (for every link, usable or not).
// Public (lib/auth/public-surface.ts): the single-use token is the credential. This page reads no
// tenant data. The gate makes one read-only, rate-limited "is this link usable" check and shows the
// same not-valid page for every unusable link; the accept route re-checks everything at submit.
export const metadata: Metadata = { title: "Accept your invitation", robots: { index: false } };

export default function AcceptInvitationPage({ searchParams }: PageProps<"/accept-invitation">) {
  return (
    <AuthCard title="Accept your invitation">
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <AcceptInvitationGate searchParams={searchParams as Promise<{ token?: string }>} />
      </Suspense>
    </AuthCard>
  );
}
