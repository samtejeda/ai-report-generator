import { sql } from "drizzle-orm";
import { z } from "zod";
import { readJsonBody } from "@/lib/api/body";
import { jsonError, jsonOk } from "@/lib/api/respond";
import type { AuthDb } from "@/lib/db/auth-db";
import { addressBucket } from "./address-bucket";
import { clientIp } from "./auth";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./config";
import { hashInvitationToken, INVITATION_TOKEN_PATTERN } from "./invitation-token";

/**
 * POST /api/invitations/accept: the public step that turns an emailed, single-use token into an
 * account. The token is the credential, so everything here is built to say as little as possible
 * about whether a token is real:
 *
 *   1. own origin only (a cross-site page cannot make a browser submit it),
 *   2. one request counted per client address (every request, never per token or account),
 *   3. a strict body; a weak password is refused HERE, before the token is touched, so it never
 *      spends the invitation and never says anything about it,
 *   4. the password is hashed ALWAYS, before the token is looked up, so a real and a made-up token
 *      take about the same time,
 *   5. one database function does the rest in one transaction (migration 0016) and answers
 *      'accepted', 'refused' or 'unknown'; the caller sees one 400 for both refusals.
 *
 * No session is created and no cookie is set: the person signs in normally and is sent to
 * authenticator setup like everyone. Dependencies are injected so the whole order is unit-tested
 * without Next or a database; lib/auth/accept-invitation.ts wires the real ones.
 */

export type AcceptResult = "accepted" | "refused" | "unknown";

export type AcceptDeps = {
  allowedOrigin: () => string;
  /** Counts one request from this address bucket and says whether it may go on. */
  limit: (bucket: string) => Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;
  hashPassword: (password: string) => Promise<string>;
  accept: (input: { tokenHash: string; displayName: string; passwordHash: string; ip?: string }) => Promise<AcceptResult>;
  /** Operational log line: fixed event name and non-secret fields only. */
  log: (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;
};

const body = z.strictObject({
  token: z.string().regex(INVITATION_TOKEN_PATTERN),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((v) => !/\p{Cc}/u.test(v)),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

export function createAcceptHandler(deps: AcceptDeps) {
  return async function accept(request: Request): Promise<Response> {
    try {
      if (request.headers.get("origin") !== deps.allowedOrigin()) return jsonError("forbidden_origin");

      const ip = clientIp(request.headers);
      const counted = await deps.limit(addressBucket(ip));
      if (!counted.allowed) return jsonError("rate_limited", { retryAfterSeconds: counted.retryAfterSeconds });

      const raw = await readJsonBody(request);
      if (!raw.ok) return jsonError("validation_failed");
      const parsed = body.safeParse(raw.value);
      if (!parsed.success) return jsonError("validation_failed");

      const passwordHash = await deps.hashPassword(parsed.data.password);
      const result = await deps.accept({ tokenHash: hashInvitationToken(parsed.data.token), displayName: parsed.data.name, passwordHash, ip });
      if (result === "accepted") return jsonOk({ data: { status: "accepted" } }, 201);
      // An unknown token has no practice to write an audit row for: an application log line with the
      // address only (never the token, never anything from the body), like an unknown address at sign-in.
      if (result === "unknown") deps.log("invitation.accept_unknown_token", { ip });
      return jsonError("invalid_invitation");
    } catch (error) {
      // Same shape as the route guard's: the log carries the route and the kind of error, nothing from the request.
      console.error(JSON.stringify({ event: "route_error", resource: "invitation_accept", kind: error instanceof Error ? error.name : "unknown" }));
      return jsonError("internal_error");
    }
  };
}

/**
 * One request counted against a per-address window on `auth_rate_limits` (the table Better Auth's own
 * limiter uses), as one atomic statement so simultaneous requests cannot all pass a stale read. Same
 * semantics as Better Auth's: `max` requests in `window` seconds, then refused until `window` seconds
 * pass without a new allowed request; a refused request does not extend the wait.
 */
export async function consumeAddressLimit(
  authDb: AuthDb,
  key: string,
  rule: { window: number; max: number },
  now: number = Date.now(),
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const windowMs = rule.window * 1000;
  const result = await authDb.execute(sql`
    insert into auth_rate_limits as r (key, count, last_request)
    values (${key}, 1, ${now})
    on conflict (key) do update set
      count = case when ${now} - r.last_request >= ${windowMs} then 1 when r.count < ${rule.max} then r.count + 1 else r.count end,
      last_request = case when ${now} - r.last_request >= ${windowMs} or r.count < ${rule.max} then ${now} else r.last_request end
    returning last_request`);
  const lastRequest = Number((result.rows[0] as { last_request: string | number }).last_request);
  // Allowed requests stamp `now`; a refused one leaves the earlier stamp.
  if (lastRequest === now) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((lastRequest + windowMs - now) / 1000)) };
}

/** Calls accept_invitation() (migration 0016) as auth_runtime, the only role that may execute it. */
export async function callAcceptInvitation(authDb: AuthDb, input: { tokenHash: string; displayName: string; passwordHash: string; ip?: string }): Promise<AcceptResult> {
  const result = await authDb.execute(sql`select accept_invitation(${input.tokenHash}, ${input.displayName}, ${input.passwordHash}, ${input.ip ?? null}) as result`);
  const value = (result.rows[0] as { result?: unknown } | undefined)?.result;
  if (value === "accepted" || value === "refused" || value === "unknown") return value;
  throw new Error("accept_invitation returned an unexpected value");
}
