/**
 * The text in a section's box, as a draft. Two pure rules, shared by every section editor:
 *
 *  - reconcileDraft: when the server's copy of the section changes under an open editor (a refresh
 *    after a save, a generation, a colleague), an untouched box follows it and an edited box never
 *    does.
 *  - isUnsaved: a section is unsaved when its box differs from the last saved text.
 *
 * Not tied to concurrent editing: Generate's text appearing and another section's save refreshing
 * the page need reconcileDraft even when only one person works on a report.
 */

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

/** True when the box holds something other than the last saved (or last adopted) text. */
export function isUnsaved(draft: string, savedText: string): boolean {
  return draft !== savedText;
}
