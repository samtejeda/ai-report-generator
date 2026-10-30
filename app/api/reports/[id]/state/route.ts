// REMOVABLE (Sam, PROGRESS.md decision 15): the "someone changed this section" check may be dropped or
// reduced to on-focus and before-save if it proves a burden on the server. This route exists only for
// that check. Removing it means deleting, together: this route; lib/db/report-state.ts;
// lib/reports/state-limits.ts; lib/reports/state.test.ts and lib/auth/state.integration.test.ts; its
// entries in lib/api-inventory.test.ts and lib/auth/guard-coverage.test.ts; the API.md row; the CI
// step "Integration tests (report state check)" and the RUNBOOK suite count. The counter below it
// (tenantDb.countRead and the read_limit_counters table) is removed separately; see the REMOVABLE
// notes there. Nothing else in the app calls this route.
import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api/respond";
import { guardedRoute } from "@/lib/auth/guard";
import { getReportState } from "@/lib/db/report-state";

const params = z.object({ id: z.uuid() });

// The "someone changed this section" check: the report's status and, per section, version, edit
// type, time and author's display name. No text. Same visibility as GET /api/reports/{id} (anything
// not visible is the same 404). Limit: 120 per person per minute (429 with Retry-After).
//
// NO AUDIT ROW, ON PURPOSE (Sam, 2026-10-30, PROGRESS.md decision 14): opening a report and every
// edit are audited, and this carries no client text, so a row per call would only bury real events.
// Do not add one here or in lib/db/report-state.ts (lib/reports/state.test.ts fails if you do).
// This check may be reduced or removed later (decision 15); keep it small.
export const GET = guardedRoute<{ id: string }>({
  roles: ["owner", "associate", "admin"],
  resource: "report",
  handler: async ({ session, params: rawParams }) => {
    const parsed = params.safeParse(rawParams);
    if (!parsed.success) return jsonError("validation_failed");
    const result = await getReportState(session, parsed.data.id);
    if (!result.ok) {
      return result.reason === "rate_limited" ? jsonError("rate_limited", { retryAfterSeconds: result.retryAfterSeconds }) : jsonError("not_found");
    }
    return jsonOk({ data: result.state });
  },
});
