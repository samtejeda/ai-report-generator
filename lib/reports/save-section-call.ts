/**
 * Saving a section from the browser: PUT the text with the version it was loaded from. A 409 means
 * either "a colleague saved first" or "the report is closed / generating"; the route does not say
 * which (what the page does with that is lib/reports/section-conflict.ts, which is REMOVABLE).
 *
 * Nothing the server says is shown (fixed sentences in lib/reports/save-messages.ts), and the
 * person's text is never sent anywhere except the PUT. Nothing here is a gate: the server decides
 * every save (the version check, the status check and the role check all re-run there).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Paths are only ever built from something shaped like an id. */
export const isId = (value: string): boolean => UUID.test(value);

export type SaveResult =
  | { ok: true; version: number }
  /** 409: the section moved on, or the report is closed. */
  | { ok: false; kind: "refused" }
  /** 400: too long or unsupported characters. */
  | { ok: false; kind: "invalid" }
  /** Anything else, or the request never arrived. */
  | { ok: false; kind: "failed" };

export async function saveSectionCall(reportId: string, sectionId: string, text: string, baseVersion: number): Promise<SaveResult> {
  if (!UUID.test(reportId) || !UUID.test(sectionId)) return { ok: false, kind: "failed" };
  let res: Response;
  try {
    res = await fetch(`/api/reports/${reportId}/sections/${sectionId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, baseVersion }),
    });
  } catch {
    return { ok: false, kind: "failed" };
  }
  if (res.ok) {
    // The server stores baseVersion + 1, so that is also the fallback if the body is unreadable.
    let version = baseVersion + 1;
    try {
      const body = (await res.json()) as { data?: { version?: unknown } };
      if (typeof body.data?.version === "number" && Number.isInteger(body.data.version)) version = body.data.version;
    } catch {}
    return { ok: true, version };
  }
  if (res.status === 409) return { ok: false, kind: "refused" };
  if (res.status === 400) return { ok: false, kind: "invalid" };
  return { ok: false, kind: "failed" };
}
