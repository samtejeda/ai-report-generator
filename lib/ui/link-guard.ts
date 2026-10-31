/**
 * Which clicked links the unsaved-changes guard should stop to ask about. Pure, so the rules are
 * tested without a browser. The guard (components/unsaved/unsaved-guard.tsx) asks only about a
 * link that would take the person to another page of this site in this tab:
 *
 *  - "in-site": ask first.
 *  - "ignore": not ours to stop. A link to another site, a new tab, a download, a mailto: or a
 *    jump within the current page leaves the text where it is. (A link to ANOTHER site unloads the
 *    page, and the browser's own "leave site?" box, `beforeunload`, covers that one.)
 */

export type LinkKind = "in-site" | "ignore";

export function classifyLink(href: string, currentHref: string, opts: { target?: string | null; download?: boolean } = {}): LinkKind {
  if (opts.download) return "ignore";
  if (opts.target && opts.target !== "_self") return "ignore";
  let to: URL;
  let here: URL;
  try {
    to = new URL(href, currentHref);
    here = new URL(currentHref);
  } catch {
    return "ignore";
  }
  if (to.protocol !== "http:" && to.protocol !== "https:") return "ignore";
  if (to.origin !== here.origin) return "ignore";
  // A jump within this page (a hash on the same path and query) keeps everything where it is.
  if (to.hash !== "" && to.pathname === here.pathname && to.search === here.search) return "ignore";
  return "in-site";
}

/** True for a plain left click with no modifier key (those open a new tab or window instead). */
export function isPlainLeftClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
