import { z } from "zod";
import { readJsonBody } from "@/lib/api/body";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import { guardedRoute } from "@/lib/auth/guard";
import { parseClientCreate } from "@/lib/clients/input";
import { listClients, MAX_OFFSET, MAX_PAGE_SIZE } from "@/lib/db/client-access";
import { createClient } from "@/lib/db/client-write";

const query = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
  })
  .strict();

// Clients the caller may see: the owner's whole practice; an associate's or an admin's assigned
// clients (an admin with no grant gets an empty list). The visibility rule itself lives in the
// query (lib/db/client-access.ts), so it holds even if this handler is edited.
export const GET = guardedRoute({
  roles: ["owner", "associate", "admin"],
  resource: "client",
  handler: async ({ request, session }) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return jsonError("validation_failed");
    const data = await listClients(session, parsed.data);
    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      { action: "client.listed", resourceType: "client", metadata: { role: session.role } },
    );
    return jsonOk({ data, limit: parsed.data.limit ?? 50, offset: parsed.data.offset ?? 0 });
  },
});

// Creates a client. Owner or associate; an associate is assigned to the new client in the same
// transaction so they can see it. Body: displayName, and optionally dateOfBirth, gradeLevel and
// externalId (decision D6), nothing else. Nothing from the body is echoed in an error or the audit log.
export const POST = guardedRoute({
  roles: ["owner", "associate"], // CLIENT_WRITE_ROLES: written out so the coverage scan can see them
  resource: "client",
  handler: async ({ request, session }) => {
    const raw = await readJsonBody(request);
    if (!raw.ok) return jsonError("validation_failed");
    const parsed = parseClientCreate(raw.value);
    if (!parsed.ok) return jsonError("validation_failed");

    const result = await createClient(session, parsed.value);
    if (!result.ok) return jsonError("conflict");

    const actor = { organizationId: session.organizationId, actorUserId: session.userId };
    await audit(actor, { action: "client.created", resourceType: "client", resourceId: result.client.id, metadata: { role: session.role } });
    if (result.assignmentId) {
      await audit(actor, {
        action: "assignment.created",
        resourceType: "client_assignment",
        resourceId: result.assignmentId,
        metadata: { role: session.role, method: "auto_on_create" },
      });
    }
    return jsonOk({ data: result.client }, 201);
  },
});
