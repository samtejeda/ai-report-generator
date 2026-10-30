/**
 * Two renderings of one instant. The server (and the first paint in the browser) cannot know the
 * viewer's time zone, so it prints UTC with the zone named; once the page is in the browser the
 * same instant is printed in the viewer's own zone (components/reports/local-time.tsx). Both are
 * pure and take the ISO string the API sends.
 */

export const UNKNOWN_TIME = "an unknown time";

function parse(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "2026-10-30 19:14 UTC" */
export function formatUtc(iso: string): string {
  const d = parse(iso);
  return d ? `${d.toISOString().slice(0, 16).replace("T", " ")} UTC` : UNKNOWN_TIME;
}

/** The viewer's own zone and language, e.g. "Oct 30, 2026, 3:14 PM". */
export function formatLocal(iso: string): string {
  const d = parse(iso);
  return d ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : UNKNOWN_TIME;
}
