import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { guardedRoute } from "@/lib/auth/guard";
import { resendAssociateInvitation } from "@/lib/auth/invitation-owner";

const id = z.uuid();

// A new link and a fresh period for a pending (or expired) invitation; the old link stops working.
// Owner only. Accepted or revoked is a 409; another practice's id and a made-up one are the same 404.
// Counts against the same per-practice limit as creating. Like creating, the answer does not say
// whether the address has an account by now.
export const POST = guardedRoute<{ id: string }>({
  roles: ["owner"],
  resource: "invitation",
  handler: async ({ session, params }) => {
    if (!id.safeParse(params.id).success) return jsonError("validation_failed");
    const result = await resendAssociateInvitation(session, params.id);
    if (!result.ok) {
      if (result.reason === "rate_limited") return jsonError("rate_limited", { retryAfterSeconds: result.retryAfterSeconds });
      return jsonError(result.reason === "not_found" ? "not_found" : "conflict");
    }
    return jsonOk({ data: result.invitation });
  },
});
