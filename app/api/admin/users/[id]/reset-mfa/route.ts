import { z } from "zod";
import { jsonError } from "@/lib/api/respond";
import { respondToUserChange } from "@/lib/api/user-change";
import { guardedRoute } from "@/lib/auth/guard";
import { resetUserMfaAsOwner } from "@/lib/auth/mfa-reset";

const id = z.uuid();

// A colleague lost the phone and the backup codes: the OWNER, signed in within the last few minutes,
// resets their authenticator. Never oneself and never another owner (those use the break-glass script).
// The person is signed out everywhere and set up a new phone at their next sign-in. The audit row
// (`auth.mfa_reset`, method `owner_reset`) is written by the database function, in the same transaction.
export const POST = guardedRoute<{ id: string }>({
  roles: ["owner"],
  resource: "user",
  fresh: true,
  handler: async ({ session, params }) => {
    if (!id.safeParse(params.id).success) return jsonError("validation_failed");
    const result = await resetUserMfaAsOwner(session, params.id);
    return respondToUserChange(session, params.id, result, null);
  },
});
