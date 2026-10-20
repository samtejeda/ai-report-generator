import { z } from "zod";
import { readJsonBody } from "@/lib/api/body";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import { guardedRoute } from "@/lib/auth/guard";
import { createAssignment, listAssignments } from "@/lib/db/assignment-admin";
import { MAX_OFFSET, MAX_PAGE_SIZE } from "@/lib/db/client-access";

// Who may see which client. OWNER ONLY: a grant is what lets an associate or an admin see a client at
// all, and picking one means seeing its name. Ids in, ids out; no names leave this route.

const query = z
  .object({
    clientId: z.uuid().optional(),
    userId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
  })
  .strict();

const body = z.strictObject({ clientId: z.uuid(), userId: z.uuid() });

export const GET = guardedRoute({
  roles: ["owner"],
  resource: "client_assignment",
  handler: async ({ request, session }) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return jsonError("validation_failed");
    const data = await listAssignments(session, parsed.data);
    return jsonOk({ data, limit: parsed.data.limit ?? 50, offset: parsed.data.offset ?? 0 });
  },
});

export const POST = guardedRoute({
  roles: ["owner"],
  resource: "client_assignment",
  handler: async ({ request, session }) => {
    const raw = await readJsonBody(request);
    if (!raw.ok) return jsonError("validation_failed");
    const parsed = body.safeParse(raw.value);
    if (!parsed.success) return jsonError("validation_failed");

    const result = await createAssignment(session, parsed.data);
    if (!result.ok) {
      switch (result.reason) {
        // A client or person in another practice, deleted, or made up: the same 404 for all.
        case "client_not_found":
        case "user_not_found":
          return jsonError("not_found");
        case "owner_needs_no_assignment":
          return jsonError("validation_failed");
        case "already_assigned":
          return jsonError("conflict");
      }
    }
    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      { action: "assignment.created", resourceType: "client_assignment", resourceId: result.assignment.id, metadata: { role: result.assigneeRole } },
    );
    return jsonOk({ data: result.assignment }, 201);
  },
});
