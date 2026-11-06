import { eq } from "drizzle-orm";
import { getAuthDb, type AuthDb } from "@/lib/db/auth-db";
import { issueInvitation, resendInvitation, type InvitationView } from "@/lib/db/invitation-admin";
import { users } from "@/lib/db/schema";
import { mailTemplates, type Mail } from "@/lib/email";
import { getAuthEnv } from "@/lib/env";
import { INVITATION_SECONDS } from "./config";
import { newInvitationToken } from "./invitation-token";
import { sendMailInBackground } from "./server";
import type { SessionContext } from "./session";

/**
 * The owner's "invite" and "send again", with the parts that need the auth layer:
 *
 *  - "does this address already have an account, in ANY practice?" is answered by `auth_runtime`, the
 *    one role that may read `users` across practices (it needs that to sign people in). Feature code
 *    (`app_runtime`) gains no cross-practice read, and the answer never leaves this file except as the
 *    `taken` flag the route does not return. Deactivated people count: an address is never reused.
 *  - the raw token is made here, goes into the mail link and nowhere else; the database gets its hash.
 *  - mail is sent after the response, so the response time does not tell a new address from a taken
 *    one. A taken address gets no mail at all.
 */

export type InviteDeps = {
  authDb: () => AuthDb;
  baseUrl: () => string;
  send: (mail: Mail) => void;
};

const realDeps: InviteDeps = { authDb: getAuthDb, baseUrl: () => getAuthEnv().BETTER_AUTH_URL, send: sendMailInBackground };

export async function addressHasAccount(authDb: AuthDb, email: string): Promise<boolean> {
  const rows = await authDb.select({ id: users.id }).from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  return rows.length > 0;
}

/** The link in the mail. The page that reads it is the frontend's; it must take the token out of the address bar. */
export function invitationUrl(baseUrl: string, token: string): string {
  const url = new URL("/accept-invitation", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function deliver(deps: InviteDeps, to: string, token: string) {
  deps.send(mailTemplates.invitation(to, invitationUrl(deps.baseUrl(), token), INVITATION_SECONDS / 86_400));
}

export type InviteOutcome = { ok: true; invitation: InvitationView } | { ok: false; reason: "rate_limited"; retryAfterSeconds: number };

export async function inviteAssociate(session: SessionContext, email: string, deps: InviteDeps = realDeps): Promise<InviteOutcome> {
  const { token, hash } = newInvitationToken();
  const result = await issueInvitation(session, { email, tokenHash: hash, addressTaken: (e) => addressHasAccount(deps.authDb(), e) });
  if (!result.ok) return result;
  if (!result.taken) deliver(deps, result.invitation.email, token);
  return { ok: true, invitation: result.invitation };
}

export type ResendOutcome =
  | { ok: true; invitation: InvitationView }
  | { ok: false; reason: "not_found" | "closed" }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number };

export async function resendAssociateInvitation(session: SessionContext, id: string, deps: InviteDeps = realDeps): Promise<ResendOutcome> {
  const { token, hash } = newInvitationToken();
  const result = await resendInvitation(session, { id, tokenHash: hash, addressTaken: (e) => addressHasAccount(deps.authDb(), e) });
  if (!result.ok) return result;
  if (!result.taken) deliver(deps, result.email, token);
  return { ok: true, invitation: result.invitation };
}
