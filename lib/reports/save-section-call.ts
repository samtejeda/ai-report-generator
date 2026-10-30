import { isEditable, type ReportStatus } from "@/lib/reports/status";

/**
 * Saving a section from the browser, and what to do when the server refuses. Three small pieces,
 * all pure apart from `fetch`, so the whole flow is unit-tested without a browser:
 *
 *  - saveSectionCall: PUT the text with the version it was loaded from. A 409 means either "a
 *    colleague saved first" or "the report is closed / generating"; the route does not say which.
 *  - readCurrentSection: GET /api/reports/{id} (the existing read; it is audited as report.viewed
 *    like any other view) and pick out this section.
 *  - decideAfterRefusal: from that read, which of the two it was.
 *
 * Nothing the server says is shown (fixed sentences in lib/reports/save-messages.ts), and the
 * person's text is never sent anywhere except the PUT. Nothing here is a gate: the server decides
 * every save (the version check, the status check and the role check all re-run there).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_WAIT_MS = 15_000;

export type SaveResult =
  | { ok: true; version: number }
  /** 409: the section moved on, or the report is closed. Ask the server which (readCurrentSection). */
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

/** One section as the report read returns it: display name only, never an id or an email. */
export type CurrentSection = {
  version: number;
  text: string;
  editType: string | null;
  authorName: string | null;
  editedAt: string | null;
};

export type CurrentRead =
  | { ok: true; status: string; section: CurrentSection | null }
  | { ok: false };

function asCurrentSection(value: unknown): CurrentSection | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "number" || !Number.isInteger(v.version) || typeof v.text !== "string") return null;
  return {
    version: v.version,
    text: v.text,
    editType: typeof v.editType === "string" ? v.editType : null,
    authorName: typeof v.authorName === "string" ? v.authorName : null,
    editedAt: typeof v.editedAt === "string" ? v.editedAt : null,
  };
}

export async function readCurrentSection(reportId: string, sectionId: string): Promise<CurrentRead> {
  if (!UUID.test(reportId) || !UUID.test(sectionId)) return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_WAIT_MS);
  try {
    const res = await fetch(`/api/reports/${reportId}`, { signal: controller.signal });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { data?: { status?: unknown; sections?: unknown } };
    const status = body.data?.status;
    const sections = body.data?.sections;
    if (typeof status !== "string" || !Array.isArray(sections)) return { ok: false };
    const found = sections.find((s) => typeof s === "object" && s !== null && (s as { id?: unknown }).id === sectionId);
    return { ok: true, status, section: found === undefined ? null : asCurrentSection(found) };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export type RefusalOutcome =
  /** The report cannot take edits now (finalized, or a generation is running). */
  | { kind: "closed" }
  /** A newer version exists: show it beside the person's text. */
  | { kind: "newer"; theirs: CurrentSection }
  /** Nothing newer was found: a one-off failure, try again. */
  | { kind: "unchanged" }
  /** The section is not in the report any more. */
  | { kind: "gone" }
  /** The newer text could not be read. */
  | { kind: "unreadable" };

/** What a 409 meant, given the fresh read and the version the person's text was based on. */
export function decideAfterRefusal(read: CurrentRead, baseVersion: number): RefusalOutcome {
  if (!read.ok) return { kind: "unreadable" };
  if (read.section === null) return { kind: "gone" };
  if (!isEditable(read.status as ReportStatus)) return { kind: "closed" };
  if (read.section.version > baseVersion) return { kind: "newer", theirs: read.section };
  return { kind: "unchanged" };
}

/**
 * The draft after the server's copy of the section changed under an open editor. An untouched box
 * (it still equals the text it was based on) follows the server; a box with the person's edits in
 * it is NEVER replaced: it keeps its text and its old base version, so the next Save goes to the
 * server with the version it was written against and a conflict is shown, not an overwrite.
 */
export function reconcileDraft(
  state: { draft: string; base: { version: number; text: string } },
  server: { version: number; text: string },
): { draft: string; base: { version: number; text: string }; followed: boolean } {
  if (state.draft === state.base.text) return { draft: server.text, base: { version: server.version, text: server.text }, followed: true };
  return { draft: state.draft, base: state.base, followed: false };
}
