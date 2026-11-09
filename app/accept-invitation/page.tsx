import type { Metadata } from "next";
import { Suspense } from "react";
import { AcceptInvitationForm } from "@/components/auth/accept-invitation-form";
import { AuthCard } from "@/components/auth/auth-card";
import { INVITATION_TOKEN_PATTERN } from "@/lib/auth/invitation-token";
import { leaveIfSignedIn } from "@/lib/auth/visitor";

// The link's token arrives in the query string; next.config.ts sends no Referer from this page.
// Public (lib/auth/public-surface.ts): the single-use token is the credential. This page reads no
// tenant data and never looks the token up: only the accept route does, and it answers one way for
// every unusable token.
export const metadata: Metadata = { title: "Accept your invitation", robots: { index: false } };

async function AcceptForm({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  // A signed-in person who typed this address goes home; one who opened an emailed link (a token in
  // the address) is shown the page, so the link still works, exactly as /reset-password does.
  await leaveIfSignedIn({ resetLink: Boolean(token) });
  // A token of the wrong shape cannot be real; it gets the same page as no token at all.
  return <AcceptInvitationForm token={token && INVITATION_TOKEN_PATTERN.test(token) ? token : null} />;
}

export default function AcceptInvitationPage({ searchParams }: PageProps<"/accept-invitation">) {
  return (
    <AuthCard title="Accept your invitation">
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <AcceptForm searchParams={searchParams as Promise<{ token?: string }>} />
      </Suspense>
    </AuthCard>
  );
}
