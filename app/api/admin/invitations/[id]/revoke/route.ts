import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { guardedRoute } from "@/lib/auth/guard";
import { revokeInvitation } from "@/lib/db/invitation-admin";

const id = z.uuid();

// Ends a pending invitation: its link stops working at once. Owner only. Already revoked is a 200 with
// nothing changed; an accepted one cannot be revoked (409); another practice's id and a made-up one are
// the same 404. To remove a person who already accepted, deactivate them (PATCH /api/admin/users).
export const POST = guardedRoute<{ id: string }>({
  roles: ["owner"],
  resource: "invitation",
  handler: async ({ session, params }) => {
    if (!id.safeParse(params.id).success) return jsonError("validation_failed");
    const result = await revokeInvitation(session, params.id);
    if (!result.ok) return jsonError(result.reason === "not_found" ? "not_found" : "conflict");
    return jsonOk({ data: result.invitation });
  },
});
