import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { audit } from "@/lib/audit";
import { guardedRoute } from "@/lib/auth/guard";
import { tenantDb } from "@/lib/db/tenant";
import { validateInferenceEndpoint } from "@/lib/inference-endpoint";

// Where this practice's model traffic goes (audit 04 item 8). The ONLY way to change it: the
// owner, signed in within the last few minutes, naming an address on the allow-list
// (lib/inference-endpoint.ts). The database refuses anything else even if this handler is edited
// (CHECK constraint and column grants, migration 0010), so the value is never taken on trust.

const MAX_BODY_CHARS = 2048;
const body = z.strictObject({ endpoint: z.string().nullable() });

// Reading it is practice administration, so an admin may; an associate may not.
export const GET = guardedRoute({
  roles: ["owner", "admin"],
  resource: "organization",
  handler: async ({ session }) => {
    const org = await tenantDb({ organizationId: session.organizationId }).organization();
    if (!org) return jsonError("not_found");
    return jsonOk({ data: { inferenceEndpoint: org.inferenceEndpoint } });
  },
});

export const PUT = guardedRoute({
  roles: ["owner"],
  resource: "organization",
  fresh: true,
  handler: async ({ request, session }) => {
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return jsonError("validation_failed");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return jsonError("validation_failed");
    }
    const parsed = body.safeParse(json);
    if (!parsed.success) return jsonError("validation_failed");

    let endpoint: string | null = null;
    if (parsed.data.endpoint !== null) {
      const checked = validateInferenceEndpoint(parsed.data.endpoint);
      // The reason is deliberately not echoed: the value is never reflected back.
      if (!checked.ok) return jsonError("validation_failed");
      endpoint = checked.endpoint;
    }

    await tenantDb({ organizationId: session.organizationId }).setInferenceEndpoint(endpoint);
    await audit(
      { organizationId: session.organizationId, actorUserId: session.userId },
      {
        action: "org.inference_endpoint_set",
        resourceType: "organization",
        resourceId: session.organizationId,
        metadata: { reason: endpoint === null ? "cleared" : "set" },
      },
    );
    return jsonOk({ data: { inferenceEndpoint: endpoint } });
  },
});
