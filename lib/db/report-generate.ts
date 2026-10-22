import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { SessionContext } from "@/lib/auth/session";
import { REPORT_WRITE_ROLES } from "@/lib/auth/permissions";
import { buildAuditRow } from "@/lib/audit";
import { inferenceBaseUrl } from "@/lib/inference-endpoint";
import {
  BUSY_RETRY_SECONDS,
  GENERATION_LEASE_SECONDS,
  MAX_CONCURRENT_GENERATIONS,
  MAX_STARTS_PER_ORGANIZATION,
  MAX_STARTS_PER_USER,
  RATE_WINDOW_SECONDS,
} from "@/lib/reports/generation-limits";
import { parseModelConfig, type GenerationFailure, type LlmMetadata } from "@/lib/reports/generation";
import { generatedTextSchema } from "@/lib/reports/content";
import { reportVisibilityFilter } from "./report-access";
import { auditLog, reports, reportSections, reportVersions } from "./schema";
import { tenantDb } from "./tenant";

/**
 * The three database steps of one section generation (the stub loop). No step holds a
 * transaction open across the model call: claim, then call, then finish or fail.
 *
 *   claim   one transaction, under a per-organization lock: visibility, configuration, state, rate
 *           and concurrency checks, then draft|error -> generating and the "started" audit row.
 *   finish  one transaction: generating -> generated and the ai_generated version, together.
 *   fail    one transaction: generating -> error and the failure audit row, together.
 *
 * Every status change states the status it expects (compare-and-set), the migration 0013 trigger
 * refuses any other, and times are compared with the database clock (set_updated_at stamps
 * `updated_at` with it). "Generating" for longer than the lease means the function that started
 * it died; the next claim on that report moves it to error first.
 */

type Db = Parameters<typeof tenantDb>[1];
type Mode = "stub";

function assertWriter(session: SessionContext) {
  if (!(REPORT_WRITE_ROLES as readonly string[]).includes(session.role)) throw new Error("generating a section is not allowed for this role");
}

const lease = sql`make_interval(secs => ${GENERATION_LEASE_SECONDS})`;
const window = sql`make_interval(secs => ${RATE_WINDOW_SECONDS})`;

export type ClaimResult =
  | { ok: true; baseUrl: string; models: { stub?: string } }
  | { ok: false; reason: "not_found" | "not_configured" | "not_generatable" }
  | { ok: false; reason: "rate_limited" | "busy"; retryAfterSeconds: number };

export async function claimGeneration(session: SessionContext, input: { reportId: string; sectionId: string }, db?: Db): Promise<ClaimResult> {
  assertWriter(session);
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "not_found" };
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<ClaimResult> => {
    // One claim at a time per organization, so the checks below and the status change cannot be raced.
    await t.lock("generation");

    // Visibility first: what the caller may not see is the same 404 as what does not exist, and costs no quota.
    const [report] = await t.find(reports, { where: and(eq(reports.id, input.reportId), visible), limit: 1 });
    if (!report) return { ok: false, reason: "not_found" };
    const [section] = await t.find(reportSections, { where: and(eq(reportSections.id, input.sectionId), eq(reportSections.reportId, report.id)), limit: 1 });
    if (!section) return { ok: false, reason: "not_found" };

    // Configuration, before anything changes: no endpoint (or a stored one that fails the allow-list,
    // or an unusable model_config) is a refusal, never a default.
    const org = await t.organization();
    const base = inferenceBaseUrl(org?.inferenceEndpoint);
    const models = parseModelConfig(org?.modelConfig);
    if (!base.ok || !models.ok) return { ok: false, reason: "not_configured" };

    // A run that never finished (its function was killed) is abandoned once the lease is over.
    let status = report.status;
    if (status === "generating") {
      const reclaimed = await t.update(reports, report.id, { status: "error" }, and(eq(reports.status, "generating"), sql`${reports.updatedAt} < now() - ${lease}`));
      if (reclaimed[0]) {
        status = "error";
        await t.insert(auditLog, {
          ...buildAuditRow({ action: "report.generation_failed", resourceType: "report", resourceId: report.id, outcome: "failure", metadata: { reason: "stale" satisfies GenerationFailure, role: session.role } }),
          actorUserId: session.userId,
          requestId: null,
        });
      }
    }
    if (status !== "draft" && status !== "error") return { ok: false, reason: "not_generatable" };

    // Only an empty prose section: a person's text is never silently replaced.
    if (section.sectionType !== "prose") return { ok: false, reason: "not_generatable" };
    const [existing] = await t.find(reportVersions, { where: eq(reportVersions.sectionId, section.id), limit: 1 });
    if (existing) return { ok: false, reason: "not_generatable" };

    // Rate: starts are the audit rows written by this very function, inside this lock.
    const startedRows = (limit: number, actorOnly: boolean) =>
      t.find(auditLog, {
        where: and(
          eq(auditLog.action, "report.generation_started"),
          actorOnly ? eq(auditLog.actorUserId, session.userId) : undefined,
          gt(auditLog.createdAt, sql`now() - ${window}`),
        ),
        orderBy: desc(auditLog.createdAt),
        limit,
      });
    for (const [limit, actorOnly] of [[MAX_STARTS_PER_USER, true], [MAX_STARTS_PER_ORGANIZATION, false]] as const) {
      const rows = await startedRows(limit, actorOnly);
      if (rows.length >= limit) {
        // The oldest of the newest `limit` starts is the one that has to age out of the window.
        const oldest = rows[rows.length - 1].createdAt.getTime();
        return { ok: false, reason: "rate_limited", retryAfterSeconds: Math.max(1, Math.ceil(RATE_WINDOW_SECONDS - (Date.now() - oldest) / 1000)) };
      }
    }

    // Concurrency: live generations only (a run past its lease does not count).
    const running = await t.find(reports, { where: and(eq(reports.status, "generating"), sql`${reports.updatedAt} >= now() - ${lease}`), limit: MAX_CONCURRENT_GENERATIONS });
    if (running.length >= MAX_CONCURRENT_GENERATIONS) return { ok: false, reason: "busy", retryAfterSeconds: BUSY_RETRY_SECONDS };

    const moved = await t.update(reports, report.id, { status: "generating" }, eq(reports.status, status));
    if (!moved[0]) return { ok: false, reason: "not_generatable" };
    await t.insert(auditLog, {
      ...buildAuditRow({ action: "report.generation_started", resourceType: "report_generation", resourceId: report.id, metadata: { role: session.role } }),
      actorUserId: session.userId,
      requestId: null,
    });
    return { ok: true, baseUrl: base.baseUrl, models: models.models };
  });
}

export type FinishResult = { ok: true; versionId: string } | { ok: false; reason: "lost" | "invalid_output" };

/** generating -> generated and the version row, in one transaction. The text is checked again here, at the door of the table. */
export async function finishGeneration(
  session: SessionContext,
  input: { reportId: string; sectionId: string; text: string; metadata: LlmMetadata },
  db?: Db,
): Promise<FinishResult> {
  assertWriter(session);
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "lost" };
  const text = generatedTextSchema.safeParse(input.text);
  if (!text.success) return { ok: false, reason: "invalid_output" };
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<FinishResult> => {
    const [report] = await t.find(reports, { where: and(eq(reports.id, input.reportId), visible), limit: 1 });
    if (!report) return { ok: false, reason: "lost" };
    // Still ours? If the lease ran out and someone reclaimed it, the status is no longer generating.
    const moved = await t.update(reports, report.id, { status: "generated" }, eq(reports.status, "generating"));
    if (!moved[0]) return { ok: false, reason: "lost" };
    const [row] = await t.insert(reportVersions, {
      reportId: report.id,
      sectionId: input.sectionId,
      versionNumber: 1,
      editType: "ai_generated",
      content: { text: text.data },
      llmMetadata: input.metadata,
      createdByUserId: null,
    });
    return { ok: true, versionId: row.id };
  });
}

/**
 * generating -> error and the failure row, in one transaction. Not filtered by visibility on
 * purpose: a report must never be left generating because someone's access changed meanwhile.
 * Returns false when the report was no longer generating (nothing to undo, nothing written).
 */
export async function failGeneration(
  session: SessionContext,
  input: { reportId: string; reason: GenerationFailure; mode?: Mode; model?: string; latencyMs?: number },
  db?: Db,
): Promise<boolean> {
  assertWriter(session);
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t) => {
    const moved = await t.update(reports, input.reportId, { status: "error" }, eq(reports.status, "generating"));
    if (!moved[0]) return false;
    await t.insert(auditLog, {
      ...buildAuditRow({
        action: "report.generation_failed",
        resourceType: "report",
        resourceId: input.reportId,
        outcome: "failure",
        metadata: {
          reason: input.reason,
          role: session.role,
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.latencyMs !== undefined ? { latency_ms: input.latencyMs } : {}),
        },
      }),
      actorUserId: session.userId,
      requestId: null,
    });
    return true;
  });
}
