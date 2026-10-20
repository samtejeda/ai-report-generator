import { z } from "zod";
import { jsonError } from "@/lib/api/respond";
import { respondToUserChange } from "@/lib/api/user-change";
import { guardedRoute } from "@/lib/auth/guard";
import { setUserActive } from "@/lib/db/user-admin";

const id = z.uuid();

// Turn a deactivated person's access back on. Their password and authenticator are unchanged, so
// they sign in as before. An admin cannot reactivate an owner.
export const POST = guardedRoute<{ id: string }>({
  roles: ["owner", "admin"],
  resource: "user",
  handler: async ({ session, params }) => {
    if (!id.safeParse(params.id).success) return jsonError("validation_failed");
    const result = await setUserActive(session, params.id, true);
    return respondToUserChange(session, params.id, result, "user.reactivated");
  },
});
