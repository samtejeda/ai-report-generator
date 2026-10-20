import { z } from "zod";
import { jsonError } from "@/lib/api/respond";
import { respondToUserChange } from "@/lib/api/user-change";
import { guardedRoute } from "@/lib/auth/guard";
import { setUserActive } from "@/lib/db/user-admin";

const id = z.uuid();

// Turn a person's access off. Their sessions stop working on their very next request (the session
// lookup refuses a deactivated user), and their address stays reserved. Not oneself; an admin
// cannot deactivate an owner; the last active owner can never be deactivated.
export const POST = guardedRoute<{ id: string }>({
  roles: ["owner", "admin"],
  resource: "user",
  handler: async ({ session, params }) => {
    if (!id.safeParse(params.id).success) return jsonError("validation_failed");
    const result = await setUserActive(session, params.id, false);
    return respondToUserChange(session, params.id, result, "user.deactivated");
  },
});
