import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import { guardedRoute } from "@/lib/auth/guard";
import { listClients, MAX_OFFSET, MAX_PAGE_SIZE } from "@/lib/db/client-access";

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
