import { createHash, randomBytes } from "node:crypto";

/**
 * The invitation token: 256 random bits, base64url (43 characters). The raw value exists in exactly
 * one place, the emailed link. The database holds only its SHA-256 (`invitations.token_hash`), so a
 * reader of the database, a backup or a log cannot accept an invitation, and the lookup is an exact
 * match on a hash of a value nobody can guess (no timing attack on a 256-bit secret).
 *
 * Never log, audit or return a token or its hash.
 */

export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newInvitationToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashInvitationToken(token) };
}
