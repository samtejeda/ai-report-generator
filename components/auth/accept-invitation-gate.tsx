import { invitationTokenForForm } from "@/lib/auth/check-invitation-link";
import { leaveIfSignedIn } from "@/lib/auth/visitor";
import { AcceptInvitationForm } from "./accept-invitation-form";

// Decides what /accept-invitation shows, on the server, before anything reaches the browser.
// Public (lib/auth/public-surface.ts): the single-use token is the credential. This reads no tenant
// data; the one lookup is a read-only, rate-limited "is this link usable" boolean
// (lib/auth/invitation-link.ts). A missing, malformed, unknown, used, revoked, expired or replaced
// link all become the same element (<AcceptInvitationForm token={null} />), so the page never says
// why. The submit route and accept_invitation() still re-check everything.
export async function AcceptInvitationGate({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  // A signed-in person who typed this address goes home; one who opened an emailed link (a token in
  // the address) is shown the page, so the link still works, exactly as /reset-password does.
  await leaveIfSignedIn({ resetLink: Boolean(token) });
  return <AcceptInvitationForm token={await invitationTokenForForm(typeof token === "string" ? token : undefined)} />;
}
