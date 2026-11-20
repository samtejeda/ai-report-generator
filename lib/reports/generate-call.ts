import { readErrorCode, type ApiFailure } from "@/lib/admin/api-call";
import { GENERATION_ROUTE_MAX_SECONDS, GENERATION_STUB_ROUTE_SECONDS } from "@/lib/reports/generation-limits";

/**
 * The one way the report page calls the generate route from the browser. It returns what the page
 * needs to decide the next step and nothing else:
 *  - the HTTP status, the error `code` (our fixed vocabulary from lib/api/respond.ts) and the
 *    `Retry-After` number on a failure, never the server's message text;
 *  - on success only the stored version number and the review flags (a closed list);
 *  - for the two "needs_confirmation" answers only the reason, the missing categories (a closed
 *    list) and the sensitive boolean.
 * The generated TEXT in the response is never read into the page's state: the page re-reads the
 * stored text from the database. The session notes in the request body are never kept here (they
 * are an argument, sent once, and gone). `failure: null` means the request never arrived;
 * `{ status: 0, code: "timeout" }` means the browser gave up waiting. Nothing here is a gate.
 */

/** Closed lists, mirrored from lib/ai/pipeline/schemas.ts (a test keeps them equal; that file is server code). */
export const REVIEW_FLAGS = ["insufficient_input", "sensitive_content_detected", "low_confidence_interpretation"] as const;
export type ReviewFlag = (typeof REVIEW_FLAGS)[number];
export const MISSING_CATEGORIES = ["observations", "test_scores", "quotes", "family_context"] as const;
export type MissingCategory = (typeof MISSING_CATEGORIES)[number];

/** What the request carries. `notes` and `confirm` are real-mode only; the stub's strict body refuses them. */
export type GenerateBody = { baseVersion: number; replaceEdited?: true; notes?: string; confirm?: true };

export type GenerateAnswer =
  | { kind: "generated"; version: number | null; flags: ReviewFlag[] }
  | { kind: "thin_notes"; missing: MissingCategory[]; sensitive: boolean }
  | { kind: "edited_text" }
  | { kind: "failed"; failure: ApiFailure | null; retryAfterSeconds: number | null };

/** The stub request is expected to end within its own limit; the browser waits a little longer than that, then lets go. */
export const BROWSER_WAIT_MS = (GENERATION_STUB_ROUTE_SECONDS + 5) * 1000;
/** A real run is allowed up to the route's own 300 s; the browser waits a margin longer, then lets go. */
export const REAL_BROWSER_WAIT_MS = (GENERATION_ROUTE_MAX_SECONDS + 10) * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whole seconds from a Retry-After header, or null when it is missing or not a positive number. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return seconds >= 1 ? seconds : null;
}

const failed = (failure: ApiFailure | null, retryAfterSeconds: number | null = null): GenerateAnswer => ({ kind: "failed", failure, retryAfterSeconds });

/** Reads the 200 body against the closed vocabulary; anything else is "unreadable" (a generic failure). */
export function parseGenerateAnswer(json: unknown): GenerateAnswer {
  const data = (json as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") return failed({ status: 0, code: "unreadable" });
  if (data.outcome === "needs_confirmation") {
    if (data.reason === "edited_text") return { kind: "edited_text" };
    if (data.reason === "thin_notes") {
      const missing = Array.isArray(data.missing) ? MISSING_CATEGORIES.filter((c) => (data.missing as unknown[]).includes(c)) : [];
      return { kind: "thin_notes", missing, sensitive: data.sensitive === true };
    }
    return failed({ status: 0, code: "unreadable" });
  }
  const section = data.section as { version?: unknown } | undefined;
  if (!section || typeof section !== "object") return failed({ status: 0, code: "unreadable" });
  const flags = Array.isArray(data.flags) ? REVIEW_FLAGS.filter((f) => (data.flags as unknown[]).includes(f)) : [];
  return { kind: "generated", version: typeof section.version === "number" && Number.isInteger(section.version) ? section.version : null, flags };
}

export async function callGenerateSection(reportId: string, sectionId: string, body: GenerateBody, realMode = false): Promise<GenerateAnswer> {
  // Ids come from the page, but a path is only ever built from something shaped like an id.
  if (!UUID.test(reportId) || !UUID.test(sectionId)) return failed({ status: 400, code: "validation_failed" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), realMode ? REAL_BROWSER_WAIT_MS : BROWSER_WAIT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`/api/reports/${reportId}/sections/${sectionId}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      return failed(controller.signal.aborted ? { status: 0, code: "timeout" } : null);
    }
    if (res.ok) {
      try {
        return parseGenerateAnswer(await res.json());
      } catch {
        return failed({ status: 0, code: "unreadable" });
      }
    }
    const code = await readErrorCode(res);
    return failed({ status: res.status, code }, parseRetryAfter(res.headers.get("retry-after")));
  } finally {
    clearTimeout(timer);
  }
}
