import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import { guardedRoute } from "@/lib/auth/guard";
import { endAssignment } from "@/lib/db/assignment-admin";

const id = z.uuid();

// Ends one assignment (the row stays, marked ended). Takes effect on that person's next request.
// Another practice's assignment, one already ended, and one that never existed are the same 404.
export const DELETE = guardedRoute<{ id: string }>({
  roles: ["owner"],
  resource: "client_assignment",
  handler: async ({ session, params }) => {
    if (!id.safeParse(params.id).success) return jsonError("validation_failed");
    const result = await endAssignment(session, params.id);
    if (!result.ok) return jsonError("not_found");
    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      { action: "assignment.ended", resourceType: "client_assignment", resourceId: params.id },
    );
    return jsonOk({ data: { id: params.id, ended: true } });
  },
});
