import { z } from "zod";
import { readJsonBody } from "@/lib/api/body";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { guardedRoute } from "@/lib/auth/guard";
import { inviteAssociate } from "@/lib/auth/invitation-owner";
import { MAX_OFFSET, MAX_PAGE_SIZE } from "@/lib/db/client-access";
import { listInvitations } from "@/lib/db/invitation-admin";

// Inviting a person to the practice. OWNER ONLY, and only the associate role (the table refuses any
// other). Creating needs a sign-in from the last 5 minutes: it mails an arbitrary address and adds a
// person to the practice, so a stolen idle session must not be able to do it. The answer is the same
// whether or not the address already has an account (see lib/auth/invitation-owner.ts).

const query = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
  })
  .strict();

// Lowercased before it is checked, because the database stores addresses lowercase.
const body = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  role: z.literal("associate").optional(),
});

export const GET = guardedRoute({
  roles: ["owner"],
  resource: "invitation",
  handler: async ({ request, session }) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return jsonError("validation_failed");
    const data = await listInvitations(session, parsed.data);
    return jsonOk({ data, limit: parsed.data.limit ?? 50, offset: parsed.data.offset ?? 0 });
  },
});

export const POST = guardedRoute({
  roles: ["owner"],
  resource: "invitation",
  fresh: true,
  handler: async ({ request, session }) => {
    const raw = await readJsonBody(request);
    if (!raw.ok) return jsonError("validation_failed");
    const parsed = body.safeParse(raw.value);
    if (!parsed.success) return jsonError("validation_failed");

    const result = await inviteAssociate(session, parsed.data.email);
    if (!result.ok) return jsonError("rate_limited", { retryAfterSeconds: result.retryAfterSeconds });
    // The audit row (created, or refused for an address that has an account) was written in the same transaction.
    return jsonOk({ data: result.invitation }, 201);
  },
});
