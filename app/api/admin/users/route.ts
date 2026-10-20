import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { guardedRoute } from "@/lib/auth/guard";
import { MAX_OFFSET, MAX_PAGE_SIZE } from "@/lib/db/client-access";
import { listUsers } from "@/lib/db/user-admin";

const query = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
  })
  .strict();

// The people in the caller's own practice, deactivated ones included (flagged `active: false`).
// Owner and admin manage users; an associate is refused by the guard. Only the caller's
// organization is ever queried (tenantDb), so another practice's users cannot appear.
export const GET = guardedRoute({
  roles: ["owner", "admin"],
  resource: "user",
  handler: async ({ request, session }) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return jsonError("validation_failed");
    const data = await listUsers(session, parsed.data);
    return jsonOk({ data, limit: parsed.data.limit ?? 50, offset: parsed.data.offset ?? 0 });
  },
});
