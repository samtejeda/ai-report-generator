import { z } from "zod";
import { readJsonBody } from "@/lib/api/body";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import { guardedRoute } from "@/lib/auth/guard";
import { auditFieldList, parseClientPatch } from "@/lib/clients/input";
import { getClient } from "@/lib/db/client-access";
import { softDeleteClient, updateClient } from "@/lib/db/client-write";

const params = z.object({ id: z.uuid() });

// One client, if the caller may see it. A client in another practice, one the associate or admin is
// not assigned to, and one that does not exist all answer the same 404, so the response never
// confirms that an id exists. Viewing a client is a sensitive read and is audited (ids only).
export const GET = guardedRoute<{ id: string }>({
  roles: ["owner", "associate", "admin"],
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

// Edits one client's D6 fields. Owner: any client in the practice. Associate: assigned clients only,
// enforced inside the UPDATE itself. A client the caller may not edit, one in another practice, a
// deleted one and a made-up id are all the same 404. An empty body, unknown keys and values that fail
// validation are a 400; a duplicate externalId is a 409. Nothing from the body is echoed.
export const PATCH = guardedRoute<{ id: string }>({
  roles: ["owner", "associate"], // CLIENT_WRITE_ROLES: written out so the coverage scan can see them
  resource: "client",
  handler: async ({ request, session, params: rawParams }) => {
    const parsedId = params.safeParse(rawParams);
    if (!parsedId.success) return jsonError("validation_failed");
    const raw = await readJsonBody(request);
    if (!raw.ok) return jsonError("validation_failed");
    const patch = parseClientPatch(raw.value);
    if (!patch.ok) return jsonError("validation_failed");

    const result = await updateClient(session, parsedId.data.id, patch.value);
    if (!result.ok) return jsonError(result.reason === "not_found" ? "not_found" : "conflict");

    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      {
        action: "client.updated",
        resourceType: "client",
        resourceId: result.client.id,
        metadata: { role: session.role, fields: auditFieldList(Object.keys(patch.value) as Parameters<typeof auditFieldList>[0]) },
      },
    );
    return jsonOk({ data: result.client });
  },
});

// Soft-deletes one client (owner only). The row is kept with a deletion time; the client and every
// report under it disappear for every role. Hard deletion is purge_client(), which no route calls.
// The audit row is written in the same transaction as the delete, so a delete is never unrecorded.
export const DELETE = guardedRoute<{ id: string }>({
  roles: ["owner"], // CLIENT_DELETE_ROLES
  resource: "client",
  handler: async ({ session, params: rawParams }) => {
    const parsedId = params.safeParse(rawParams);
    if (!parsedId.success) return jsonError("validation_failed");
    const result = await softDeleteClient(session, parsedId.data.id);
    if (!result.ok) return jsonError("not_found");
    return jsonOk({ data: { id: parsedId.data.id, deleted: true } });
  },
});
