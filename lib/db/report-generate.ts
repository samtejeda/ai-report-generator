import { and, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
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
import { pgCode, RESTRICT_VIOLATION, UNIQUE_VIOLATION } from "./pg-error";
import { reportVisibilityFilter } from "./report-access";
import { auditLog, reports, reportSections, reportVersions } from "./schema";
import { tenantDb, type TenantDb } from "./tenant";

/**
 * The three database steps of one section generation (the stub loop). No step holds a
 * transaction open across the model call: claim, then call, then finish or fail.
 *
 *   claim   one transaction, under a per-organization lock: visibility, configuration, state, rate
 *           and concurrency checks, then draft|error -> generating and the "started" audit row.
 *   finish  one transaction: generating -> generated and the ai_generated version, together.
 *   fail    one transaction: generating -> error and the failure audit row, together.
 *
 * Since migration 0017 a `generated` report may be claimed again: for another empty section, or to
 * REGENERATE one that has text (a new version above it, `ai_regenerated_section`; nothing is ever
 * overwritten). The status the run started from is remembered by the database itself
 * (`reports.status_before_generation`, set and cleared by the trigger), and a failed or abandoned run
 * returns the report to it: `generated` stays `generated` with its text untouched, `draft` and `error`
 * go to `error`. The version the person saw (`baseVersion`) is checked at the claim and again at the
 * finish, so a section that moved on while the model worked is a conflict and nothing is stored.
 *
 * Every status change states the status it expects (compare-and-set), the migration 0013 trigger
 * refuses any other, and times are compared with the database clock (set_updated_at stamps
 * `updated_at` with it). "Generating" for longer than the lease means the function that started
 * it died; the next claim on that report moves it to error first.
 */

type Db = Parameters<typeof tenantDb>[1];
type Mode = "stub" | "real";

function assertWriter(session: SessionContext) {
  if (!(REPORT_WRITE_ROLES as readonly string[]).includes(session.role)) throw new Error("generating a section is not allowed for this role");
}

const lease = sql`make_interval(secs => ${GENERATION_LEASE_SECONDS})`;
const window = sql`make_interval(secs => ${RATE_WINDOW_SECONDS})`;

/** The transaction handle `tenantDb(...).transaction` gives a callback. */
export type Tx = Pick<TenantDb, "find" | "update" | "insert" | "lock" | "get" | "organization">;
type ReportRow = typeof reports.$inferSelect;

export type FromStatus = "draft" | "error" | "generated";
const FROM_STATUSES: readonly string[] = ["draft", "error", "generated"];

/** The `from_status` audit field for a value the database remembered (nothing if it holds none). */
export function fromStatusMeta(prior: string | null | undefined): { from_status?: FromStatus } {
  return prior && FROM_STATUSES.includes(prior) ? { from_status: prior as FromStatus } : {};
}

/** Where a failed or abandoned run sends the report: a report that had content goes back to `generated`, anything else to `error`. */
export function returnStatus(prior: string | null | undefined): "generated" | "error" {
  return prior === "generated" ? "generated" : "error";
}

/** A guard that matches only while the remembered status still is what the caller read (so a report that moved on is left alone). */
function priorGuard(prior: string | null | undefined) {
  return prior === "generated" ? eq(reports.statusBeforeGeneration, "generated") : or(isNull(reports.statusBeforeGeneration), ne(reports.statusBeforeGeneration, "generated"));
}

/**
 * A run that never finished (its function was killed) is abandoned once the lease is over: return the
 * report to the status it was claimed from (`generated` if it had content, else `error`), with its
 * failure row, and return the status the report has now. Never left `generating`. Shared by the stub
 * claim and the real flow's precheck and claim, so the lease rule is in one place.
 */
export async function reclaimIfStale(t: Tx, report: ReportRow, session: SessionContext): Promise<ReportRow["status"]> {
  if (report.status !== "generating") return report.status;
  const prior = report.statusBeforeGeneration;
  const target = returnStatus(prior);
  const reclaimed = await t.update(reports, report.id, { status: target }, and(eq(reports.status, "generating"), sql`${reports.updatedAt} < now() - ${lease}`, priorGuard(prior)));
  if (!reclaimed[0]) return report.status;
  await t.insert(auditLog, {
    ...buildAuditRow({
      action: "report.generation_failed",
      resourceType: "report",
      resourceId: report.id,
      outcome: "failure",
      metadata: { reason: "stale" satisfies GenerationFailure, role: session.role, ...fromStatusMeta(prior) },
    }),
    actorUserId: session.userId,
    requestId: null,
  });
  return target;
}

/** What a request to generate a section turns out to be, once the report and the section are known. */
export type SectionPlan = { kind: "first" } | { kind: "regenerate"; editedByPerson: boolean };

/**
 * Whether this section may be generated now, and as what. A prose section only. An EMPTY one is a first
 * generation (the person saw version 0). One WITH text is a regenerate, allowed only on a `generated`
 * report (text on a draft or error report is never replaced, Sam 2026-11-14). In both cases `baseVersion`
 * must be the section's current version: a different one means it moved on, and the answer is no.
 * `editedByPerson` says the current text is a person's own edit (it then needs an explicit confirmation).
 */
export async function planSection(t: Tx, section: typeof reportSections.$inferSelect, status: ReportRow["status"], baseVersion: number): Promise<SectionPlan | null> {
  if (section.sectionType !== "prose") return null;
  const [latest] = await t.find(reportVersions, { where: eq(reportVersions.sectionId, section.id), orderBy: desc(reportVersions.versionNumber), limit: 1 });
  if ((latest?.versionNumber ?? 0) !== baseVersion) return null;
  if (!latest) return { kind: "first" };
  if (status !== "generated") return null;
  return { kind: "regenerate", editedByPerson: latest.editType === "human_edit" };
}

/**
 * Starts are the audit rows written by the claim (or the real flow's precheck), inside the practice
 * lock. Returns null when the caller may start, else how long until they may.
 */
export async function startRateLimit(t: Tx, session: SessionContext): Promise<{ retryAfterSeconds: number } | null> {
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
      return { retryAfterSeconds: Math.max(1, Math.ceil(RATE_WINDOW_SECONDS - (Date.now() - oldest) / 1000)) };
    }
  }
  return null;
}

/** Concurrency: live generations only (a run past its lease does not count). True when the practice is at its cap. */
export async function atConcurrencyCap(t: Tx): Promise<boolean> {
  const running = await t.find(reports, { where: and(eq(reports.status, "generating"), sql`${reports.updatedAt} >= now() - ${lease}`), limit: MAX_CONCURRENT_GENERATIONS });
  return running.length >= MAX_CONCURRENT_GENERATIONS;
}

export type ClaimResult =
  | { ok: true; baseUrl: string; models: { stub?: string; filter?: string; worker?: string }; fromStatus: FromStatus }
  | { ok: false; reason: "not_found" | "not_configured" | "not_generatable" }
  /** The current text is a person's own edit and the caller did not say `replaceEdited`: nothing was used or written. */
  | { ok: false; reason: "edited_text"; reportStatus: "generated" }
  | { ok: false; reason: "rate_limited" | "busy"; retryAfterSeconds: number };

export type GenerateTarget = { reportId: string; sectionId: string; baseVersion: number; replaceEdited: boolean };

export async function claimGeneration(session: SessionContext, input: GenerateTarget, db?: Db): Promise<ClaimResult> {
  assertWriter(session);
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "not_found" };
  try {
    return await tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<ClaimResult> => {
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

      const status = await reclaimIfStale(t, report, session);
      if (status !== "draft" && status !== "error" && status !== "generated") return { ok: false, reason: "not_generatable" };

      const plan = await planSection(t, section, status, input.baseVersion);
      if (!plan) return { ok: false, reason: "not_generatable" };
      // A person's own text is replaced only on request. Asked before any quota is spent or anything is written.
      if (plan.kind === "regenerate" && plan.editedByPerson && !input.replaceEdited) return { ok: false, reason: "edited_text", reportStatus: "generated" };

      const limited = await startRateLimit(t, session);
      if (limited) return { ok: false, reason: "rate_limited", retryAfterSeconds: limited.retryAfterSeconds };

      if (await atConcurrencyCap(t)) return { ok: false, reason: "busy", retryAfterSeconds: BUSY_RETRY_SECONDS };

      const moved = await t.update(reports, report.id, { status: "generating" }, eq(reports.status, status));
      if (!moved[0]) return { ok: false, reason: "not_generatable" };
      await t.insert(auditLog, {
        ...buildAuditRow({ action: "report.generation_started", resourceType: "report_generation", resourceId: report.id, metadata: { role: session.role, from_status: status } }),
        actorUserId: session.userId,
        requestId: null,
      });
      return { ok: true, baseUrl: base.baseUrl, models: models.models, fromStatus: status };
    });
  } catch (error) {
    // A finalize that won the race: the database refuses the status step. A clean conflict, not a 500.
    if (pgCode(error) === RESTRICT_VIOLATION) return { ok: false, reason: "not_generatable" };
    throw error;
  }
}

class StaleVersion extends Error {}

export type FinishResult =
  | { ok: true; versionId: string; version: number; editType: "ai_generated" | "ai_regenerated_section" }
  | { ok: false; reason: "lost" | "invalid_output" | "stale" };

/**
 * generating -> generated and the version row, in one transaction. The text is checked again here, at the
 * door of the table. The new version is `baseVersion + 1` (`ai_generated` for the first, `ai_regenerated_section`
 * above existing text). The status change comes first: it takes the same row lock a person's save takes, so
 * the version read after it cannot change under us. If the section is no longer at `baseVersion` the whole
 * transaction is rolled back (the report is still `generating`, for the caller to return to its earlier status)
 * and nothing is stored; the unique index on (section, version) is the last backstop.
 */
export async function finishGeneration(
  session: SessionContext,
  input: { reportId: string; sectionId: string; baseVersion: number; text: string; metadata: LlmMetadata },
  db?: Db,
): Promise<FinishResult> {
  assertWriter(session);
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "lost" };
  const text = generatedTextSchema.safeParse(input.text);
  if (!text.success) return { ok: false, reason: "invalid_output" };
  try {
    return await tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<FinishResult> => {
      const [report] = await t.find(reports, { where: and(eq(reports.id, input.reportId), visible), limit: 1 });
      if (!report) return { ok: false, reason: "lost" };
      // Still ours? If the lease ran out and someone reclaimed it, the status is no longer generating.
      const moved = await t.update(reports, report.id, { status: "generated" }, eq(reports.status, "generating"));
      if (!moved[0]) return { ok: false, reason: "lost" };
      const [latest] = await t.find(reportVersions, { where: eq(reportVersions.sectionId, input.sectionId), orderBy: desc(reportVersions.versionNumber), limit: 1 });
      if ((latest?.versionNumber ?? 0) !== input.baseVersion) throw new StaleVersion();
      const editType = input.baseVersion === 0 ? "ai_generated" : "ai_regenerated_section";
      const [row] = await t.insert(reportVersions, {
        reportId: report.id,
        sectionId: input.sectionId,
        versionNumber: input.baseVersion + 1,
        editType,
        content: { text: text.data },
        llmMetadata: input.metadata,
        createdByUserId: null,
      });
      return { ok: true, versionId: row.id, version: row.versionNumber, editType };
    });
  } catch (error) {
    if (error instanceof StaleVersion || pgCode(error) === UNIQUE_VIOLATION) return { ok: false, reason: "stale" };
    if (pgCode(error) === RESTRICT_VIOLATION) return { ok: false, reason: "lost" };
    throw error;
  }
}

/**
 * generating -> the status the run was claimed from (`generated` if the report had content, else `error`)
 * and the failure row, in one transaction. The old text and versions are not touched. Not filtered by
 * visibility on purpose: a report must never be left generating because someone's access changed meanwhile.
 * The status change names both `generating` and the remembered status it read, so a report that moved on
 * (reclaimed and claimed again) is left alone. Returns false when nothing was undone (nothing written).
 */
export async function failGeneration(
  session: SessionContext,
  input: { reportId: string; reason: GenerationFailure; mode?: Mode; model?: string; latencyMs?: number },
  db?: Db,
): Promise<boolean> {
  assertWriter(session);
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t) => {
    const [report] = await t.find(reports, { where: eq(reports.id, input.reportId), limit: 1 });
    if (!report || report.status !== "generating") return false;
    const prior = report.statusBeforeGeneration;
    const moved = await t.update(reports, report.id, { status: returnStatus(prior) }, and(eq(reports.status, "generating"), priorGuard(prior)));
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
          ...fromStatusMeta(prior),
        },
      }),
      actorUserId: session.userId,
      requestId: null,
    });
    return true;
  });
}
