import { headers } from "next/headers";
import { getAuthDb } from "@/lib/db/auth-db";
import { clientIp } from "./client-ip";
import { RATE_LIMITS } from "./config";
import { consumeAddressLimit } from "./invitation-accept";
import { callInvitationLinkUsable, tokenForForm, type LinkCheckDeps } from "./invitation-link";

/**
 * The real wiring for the accept-invitation page's link check (the logic and its order are in
 * invitation-link.ts, tested with injected dependencies). Server only.
 */
export const realLinkCheckDeps: LinkCheckDeps = {
  limit: (bucket) => consumeAddressLimit(getAuthDb(), `${bucket}|/invitations/check`, RATE_LIMITS.checkInvitation),
  usable: (tokenHash) => callInvitationLinkUsable(getAuthDb(), tokenHash),
  log: (event, fields = {}) => console.warn(JSON.stringify({ event, ...fields })),
};

/** The token for the form, or null for the not-valid page (see invitation-link.ts). */
export async function invitationTokenForForm(token: string | undefined): Promise<string | null> {
  // Only read the request's address when there is something to look up: a missing or malformed token needs no database.
  if (!token) return null;
  return tokenForForm(token, clientIp(await headers()), realLinkCheckDeps);
}
