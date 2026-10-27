import { readErrorCode, type ApiFailure } from "@/lib/admin/api-call";
import { GENERATION_ROUTE_MAX_SECONDS } from "@/lib/reports/generation-limits";

/**
 * The one way the report page calls the generate route from the browser. It returns the HTTP status,
 * the error `code` (our fixed vocabulary from lib/api/respond.ts) and the `Retry-After` number, and
 * nothing else: never the server's message text, and on success not even the body (the page
 * re-reads the stored text from the database). `failure: null` means the request never arrived;
 * `{ status: 0, code: "timeout" }` means the browser gave up waiting. Nothing here is a gate.
 */

export type GenerateResult =
  | { ok: true }
  | { ok: false; failure: ApiFailure | null; retryAfterSeconds: number | null };

/** The route stops at its own limit; the browser waits a little longer than that, then lets go. */
export const BROWSER_WAIT_MS = (GENERATION_ROUTE_MAX_SECONDS + 5) * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whole seconds from a Retry-After header, or null when it is missing or not a positive number. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return seconds >= 1 ? seconds : null;
}

export async function callGenerateSection(reportId: string, sectionId: string): Promise<GenerateResult> {
  // Ids come from the page, but a path is only ever built from something shaped like an id.
  if (!UUID.test(reportId) || !UUID.test(sectionId)) {
    return { ok: false, failure: { status: 400, code: "validation_failed" }, retryAfterSeconds: null };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROWSER_WAIT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`/api/reports/${reportId}/sections/${sectionId}/generate`, { method: "POST", signal: controller.signal });
    } catch {
      return { ok: false, failure: controller.signal.aborted ? { status: 0, code: "timeout" } : null, retryAfterSeconds: null };
    }
    if (res.ok) return { ok: true };
    const code = await readErrorCode(res);
    return { ok: false, failure: { status: res.status, code }, retryAfterSeconds: parseRetryAfter(res.headers.get("retry-after")) };
  } finally {
    clearTimeout(timer);
  }
}
