import { acceptInvitationHandler } from "@/lib/auth/accept-invitation";

// PUBLIC on purpose (lib/auth/public-surface.ts): a person with an emailed, single-use link has no account
// yet, so there is no session to check. The token is the credential; the rest of the protections (own
// origin, per-address limit, strict body, one answer for every unusable token, no session created) are
// in lib/auth/invitation-accept.ts and are what the tests pin down.
export const POST = acceptInvitationHandler;
