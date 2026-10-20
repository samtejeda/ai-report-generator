import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import { guardedRoute } from "@/lib/auth/guard";
import { getClient } from "@/lib/db/client-access";

const params = z.object({ id: z.uuid() });

// One client, if the caller may see it. A client in another practice, one the associate is not
// assigned to, and one that does not exist all answer the same 404, so the response never
// confirms that an id exists. Viewing a client is a sensitive read and is audited (ids only).
export const GET = guardedRoute<{ id: string }>({
  roles: ["owner", "associate"],
  resource: "client",
  handler: async ({ session, params: rawParams }) => {
    const parsed = params.safeParse(rawParams);
    if (!parsed.success) return jsonError("validation_failed");
    const client = await getClient(session, parsed.data.id);
    if (!client) return jsonError("not_found");
    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      { action: "client.viewed", resourceType: "client", resourceId: client.id, metadata: { role: session.role } },
    );
    return jsonOk({ data: client });
  },
});
