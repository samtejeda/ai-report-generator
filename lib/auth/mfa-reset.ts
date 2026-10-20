import { sql } from "drizzle-orm";
import { mailTemplates } from "@/lib/email";
import { getAuthDb } from "@/lib/db/auth-db";
import { users } from "@/lib/db/schema/users";
import { tenantDb } from "@/lib/db/tenant";
import { toUserView, type UserChangeResult } from "@/lib/db/user-admin";
import { sendMailInBackground } from "./server";
import type { SessionContext } from "./session";
import { checkUserChange } from "./user-rules";

/**
 * The practice owner resets a colleague's authenticator from inside the app (the route also needs a
 * recent sign-in). The rule is checked here for a clean answer, and AGAIN by the database function
 * `reset_user_mfa` (migration 0012), which is the only door: auth_runtime has no DELETE on the
 * enrollment table. The function removes the enrollment, clears the flag, deletes the person's
 * sessions and trusted devices, and writes the audit row in the same transaction.
 *
 * The person's password is untouched; their next sign-in sends them to set up a new phone, and they
 * are told by email (best effort: a mail problem never undoes the reset).
 */

type Db = Parameters<typeof tenantDb>[1];

const INSUFFICIENT_PRIVILEGE = "42501";
const NO_DATA_FOUND = "P0002";
const NOT_IN_STATE = "55000";

function pgCode(error: unknown): string | undefined {
  let cur: unknown = error;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const rec = cur as { code?: unknown; cause?: unknown };
    if (typeof rec.code === "string" && /^[0-9A-Z]{5}$/.test(rec.code)) return rec.code;
    cur = rec.cause;
  }
  return undefined;
}

export async function resetUserMfaAsOwner(session: SessionContext, targetId: string, db?: Db): Promise<UserChangeResult> {
  const t = tenantDb({ organizationId: session.organizationId }, db);
  // Active people of this practice only: another practice's person, and one who is deactivated, are both "not found".
  const target = await t.get(users, targetId);
  if (!target) return { ok: false, reason: "not_found" };
  const verdict = checkUserChange(session, target, { kind: "reset_mfa" });
  if (verdict !== "ok") return { ok: false, reason: verdict };

  try {
    await getAuthDb().execute(sql`select reset_user_mfa(${session.userId}::uuid, ${targetId}::uuid)`);
  } catch (error) {
    switch (pgCode(error)) {
      case NO_DATA_FOUND:
        return { ok: false, reason: "not_found" };
      case NOT_IN_STATE:
        return { ok: false, reason: "inactive" };
      case INSUFFICIENT_PRIVILEGE:
        // The database disagreed with the application about who may do this. Refuse.
        return { ok: false, reason: "not_allowed" };
      default:
        throw error;
    }
  }

  sendMailInBackground(mailTemplates.mfaReset(target.email));
  const after = await t.get(users, targetId);
  return { ok: true, changed: true, user: toUserView(after ?? target) };
}
