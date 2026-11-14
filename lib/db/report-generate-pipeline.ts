import { and, eq } from "drizzle-orm";
import type { SessionContext } from "@/lib/auth/session";
import { REPORT_WRITE_ROLES } from "@/lib/auth/permissions";
import { buildAuditRow } from "@/lib/audit";
import { inferenceBaseUrl } from "@/lib/inference-endpoint";
import { BUSY_RETRY_SECONDS } from "@/lib/reports/generation-limits";
import { parseModelConfig, type GenerationFailure, type ParsedModels } from "@/lib/reports/generation";
import { reportVisibilityFilter } from "./report-access";
import { atConcurrencyCap, fromStatusMeta, planSection, reclaimIfStale, startRateLimit, type FromStatus, type GenerateTarget } from "./report-generate";
import { pgCode, RESTRICT_VIOLATION } from "./pg-error";
import { auditLog, reports, reportSections, reportTemplates } from "./schema";
import { tenantDb } from "./tenant";

/**
 * The database steps of one REAL-mode (three-pass) section generation. Same rules as the stub's
 * claim (lib/db/report-generate.ts), but the claim moves LATER: the report must not become
 * `generating` until the filter has said the notes are enough (or the person has confirmed that
 * they are thin), because `generating` can only end in `generated` or `error`, and a "please add
 * more notes" answer is neither.
 *
 *   precheck  one transaction, under the practice lock: visibility, configuration, state, the
 *             section (empty, or a regenerate of text on a generated report, at the version the
 *             person saw), the confirmation that replacing a person's own edit needs, rate and
 *             concurrency limits, and the "started" audit row. The report is NOT changed (apart
 *             from reclaiming an abandoned run, as the stub does).
 *   claim     one transaction, under the same lock, called by the pipeline between the filter and
 *             extract: everything is checked again, including that the section is still at the
 *             version the person saw (their own save may have landed while the filter ran), and
 *             draft|error|generated -> generating (compare-and-set).
 *   finish / fail (lib/db/report-generate.ts) end a claimed run. A failure BEFORE the claim has
 *             nothing to undo and writes its audit row alone (`recordFailure`).
 *
 * A failure after the claim returns the report to the status it was claimed from (failGeneration).
 * No transaction is held open across a model call. Nothing here sees the notes or any model text.
 */

type Db = Parameters<typeof tenantDb>[1];

function assertWriter(session: SessionContext) {
  if (!(REPORT_WRITE_ROLES as readonly string[]).includes(session.role)) throw new Error("generating a section is not allowed for this role");
}

export type PrecheckResult =
  | {
      ok: true;
      baseUrl: string;
      models: ParsedModels;
      /** The report's own template and the methodology version it pinned when it was created. */
      template: { id: string; slug: string };
      methodologyPromptId: string;
      sectionKey: string;
      /** The report's status now, to say back when the run stops at a warning and to record as `from_status`. */
      status: FromStatus;
    }
  | { ok: false; reason: "not_found" | "not_configured" | "not_generatable" }
  /** The current text is a person's own edit and `replaceEdited` was not sent: nothing was used, written or counted. */
  | { ok: false; reason: "edited_text" }
  | { ok: false; reason: "rate_limited" | "busy"; retryAfterSeconds: number };

export async function precheckGeneration(session: SessionContext, input: GenerateTarget, db?: Db): Promise<PrecheckResult> {
  assertWriter(session);
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "not_found" };
  return tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<PrecheckResult> => {
    await t.lock("generation");

    // Visibility first: what the caller may not see is the same 404 as what does not exist, and costs no quota.
    const [report] = await t.find(reports, { where: and(eq(reports.id, input.reportId), visible), limit: 1 });
    if (!report) return { ok: false, reason: "not_found" };
    const [section] = await t.find(reportSections, { where: and(eq(reportSections.id, input.sectionId), eq(reportSections.reportId, report.id)), limit: 1 });
    if (!section) return { ok: false, reason: "not_found" };

    // Configuration, before anything is written: no endpoint (or one that fails the allow-list, or an
    // unusable model_config, or no template) is a refusal, never a default.
    const org = await t.organization();
    const base = inferenceBaseUrl(org?.inferenceEndpoint);
    const models = parseModelConfig(org?.modelConfig);
    const [template] = await t.find(reportTemplates, { where: eq(reportTemplates.id, report.templateId), limit: 1 });
    if (!base.ok || !models.ok || !template) return { ok: false, reason: "not_configured" };

    const status = await reclaimIfStale(t, report, session);
    if (status !== "draft" && status !== "error" && status !== "generated") return { ok: false, reason: "not_generatable" };
    const plan = await planSection(t, section, status, input.baseVersion);
    if (!plan) return { ok: false, reason: "not_generatable" };
    // A person's own text is replaced only on request. Asked before any model call or quota.
    if (plan.kind === "regenerate" && plan.editedByPerson && !input.replaceEdited) return { ok: false, reason: "edited_text" };

    const limited = await startRateLimit(t, session);
    if (limited) return { ok: false, reason: "rate_limited", retryAfterSeconds: limited.retryAfterSeconds };
    if (await atConcurrencyCap(t)) return { ok: false, reason: "busy", retryAfterSeconds: BUSY_RETRY_SECONDS };

    // A warning that stops at the filter also used the model, so it counts as a start.
    await t.insert(auditLog, {
      ...buildAuditRow({ action: "report.generation_started", resourceType: "report_generation", resourceId: report.id, metadata: { role: session.role, mode: "real", from_status: status } }),
      actorUserId: session.userId,
      requestId: null,
    });
    return { ok: true, baseUrl: base.baseUrl, models: models.models, template: { id: template.id, slug: template.slug }, methodologyPromptId: report.methodologyPromptId, sectionKey: section.sectionKey, status };
  });
}

export type ProceedClaim = { ok: true; fromStatus: FromStatus } | { ok: false; reason: "not_found" | "not_generatable" } | { ok: false; reason: "busy"; retryAfterSeconds: number };

/**
 * The point of no return: draft|error -> generating. Everything the precheck saw is checked again
 * under the lock (the filter took a while, and another request may have moved the report), and the
 * status change names the status it expects.
 */
export async function claimAtProceed(session: SessionContext, input: GenerateTarget, db?: Db): Promise<ProceedClaim> {
  assertWriter(session);
  const visible = reportVisibilityFilter(session);
  if (visible === null) return { ok: false, reason: "not_found" };
  try {
    return await tenantDb({ organizationId: session.organizationId }, db).transaction(async (t): Promise<ProceedClaim> => {
      await t.lock("generation");
      const [report] = await t.find(reports, { where: and(eq(reports.id, input.reportId), visible), limit: 1 });
      if (!report) return { ok: false, reason: "not_found" };
      const [section] = await t.find(reportSections, { where: and(eq(reportSections.id, input.sectionId), eq(reportSections.reportId, report.id)), limit: 1 });
      if (!section) return { ok: false, reason: "not_found" };

      const status = await reclaimIfStale(t, report, session);
      if (status !== "draft" && status !== "error" && status !== "generated") return { ok: false, reason: "not_generatable" };
      // The same section rule as the precheck, now at the point of no return: the version the person saw must still be the current one.
      if (!(await planSection(t, section, status, input.baseVersion))) return { ok: false, reason: "not_generatable" };
      if (await atConcurrencyCap(t)) return { ok: false, reason: "busy", retryAfterSeconds: BUSY_RETRY_SECONDS };

      const moved = await t.update(reports, report.id, { status: "generating" }, eq(reports.status, status));
      return moved[0] ? { ok: true, fromStatus: status } : { ok: false, reason: "not_generatable" };
    });
  } catch (error) {
    // A finalize that won the race: the database refuses the status step. A clean conflict, not a 500.
    if (pgCode(error) === RESTRICT_VIOLATION) return { ok: false, reason: "not_generatable" };
    throw error;
  }
}

/** One audit row, for a failure before the claim: nothing was generating, so there is no status to undo. Code only. */
export async function recordFailure(session: SessionContext, input: { reportId: string; reason: GenerationFailure; fromStatus?: FromStatus }, db?: Db): Promise<void> {
  assertWriter(session);
  await tenantDb({ organizationId: session.organizationId }, db).insert(auditLog, {
    ...buildAuditRow({ action: "report.generation_failed", resourceType: "report", resourceId: input.reportId, outcome: "failure", metadata: { reason: input.reason, role: session.role, mode: "real", ...fromStatusMeta(input.fromStatus) } }),
    actorUserId: session.userId,
    requestId: null,
  });
}
