import { sql } from "drizzle-orm";
import type { AuthDb } from "@/lib/db/auth-db";
import { addressBucket } from "./address-bucket";
import { hashInvitationToken, INVITATION_TOKEN_PATTERN } from "./invitation-token";

/**
 * The accept-invitation PAGE asks one question before it draws the form: "can this link still be
 * used?". It decides only what to show; it grants nothing and consumes nothing. The submit route
 * (lib/auth/invitation-accept.ts) and accept_invitation() re-check everything, so a wrong answer
 * here can never create an account.
 *
 * What it must not do is tell anyone WHY a link is unusable, or tell a guesser anything at all:
 *   - the lookup is one read-only database function (invitation_link_usable, migration 0018) that
 *     takes the token's SHA-256 and returns a bare boolean;
 *   - unknown, used, revoked, expired, replaced and "address already has an account" are all `false`;
 *     the caller renders the same page for every one of them and for a missing or malformed token;
 *   - it is counted per client address on its own bucket; a visitor over the limit, or a lookup that
 *     fails, gets today's behavior (the form), which looks the same for every token, so being limited
 *     is no oracle and nobody legitimate is locked out;
 *   - the token is never logged or returned, only its hash goes to the database.
 * Dependencies are injected so the order is unit-tested without Next or a database.
 */

export type LinkCheckDeps = {
  /** Counts one check from this address bucket and says whether it may go on. */
  limit: (bucket: string) => Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;
  /** invitation_link_usable(): true only for a link accept_invitation() would still accept. */
  usable: (tokenHash: string) => Promise<boolean>;
  /** Operational log line: a fixed event name and the kind of error, never the token or a hash. */
  log: (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;
};

/**
 * The token to hand to the form, or null for "show the not-valid page". Null for a missing or
 * malformed token (it cannot be real, no database work) and for a token the database says is unusable.
 */
export async function tokenForForm(token: string | undefined, ip: string | undefined, deps: LinkCheckDeps): Promise<string | null> {
  if (!token || !INVITATION_TOKEN_PATTERN.test(token)) return null;
  try {
    const counted = await deps.limit(addressBucket(ip));
    // Limited: do not look. The form answers for every token alike; the submit route is the judge.
    if (!counted.allowed) return token;
    return (await deps.usable(hashInvitationToken(token))) ? token : null;
  } catch (error) {
    // The check is a convenience. If it fails the person gets the form, exactly as before this check existed.
    deps.log("invitation_link_check_failed", { kind: error instanceof Error ? error.name : "unknown" });
    return token;
  }
}

/** Calls invitation_link_usable() (migration 0018) as auth_runtime, the only role that may execute it. */
export async function callInvitationLinkUsable(authDb: AuthDb, tokenHash: string): Promise<boolean> {
  const result = await authDb.execute(sql`select invitation_link_usable(${tokenHash}) as usable`);
  const value = (result.rows[0] as { usable?: unknown } | undefined)?.usable;
  if (typeof value !== "boolean") throw new Error("invitation_link_usable returned an unexpected value");
  return value;
}
