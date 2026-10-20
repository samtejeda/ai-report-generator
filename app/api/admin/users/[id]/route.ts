import { z } from "zod";
import { readJsonBody } from "@/lib/api/body";
import { jsonError } from "@/lib/api/respond";
import { respondToUserChange } from "@/lib/api/user-change";
import { guardedRoute } from "@/lib/auth/guard";
import { USER_ROLES } from "@/lib/db/schema/users";
import { changeUserRole } from "@/lib/db/user-admin";

const id = z.uuid();
const body = z.strictObject({ role: z.enum(USER_ROLES) });

// Change a person's role inside the caller's practice. Who may change whom is
// lib/auth/user-rules.ts (not oneself; an admin never touches or creates an owner); the practice
// always keeps an owner (migration 0011). The new role applies on the person's next request.
export const PATCH = guardedRoute<{ id: string }>({
  roles: ["owner", "admin"],
  resource: "user",
  handler: async ({ request, session, params }) => {
    if (!id.safeParse(params.id).success) return jsonError("validation_failed");
    const raw = await readJsonBody(request);
    if (!raw.ok) return jsonError("validation_failed");
    const parsed = body.safeParse(raw.value);
    if (!parsed.success) return jsonError("validation_failed");
    const result = await changeUserRole(session, params.id, parsed.data.role);
    return respondToUserChange(session, params.id, result, "user.role_changed");
  },
});
