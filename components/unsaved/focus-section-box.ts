import { sectionBoxId } from "@/lib/reports/unsaved";

/** Scrolls to a section's text box and puts the cursor in it. False when it is not on this page. */
export function focusSectionBox(sectionId: string): boolean {
  const box = document.getElementById(sectionBoxId(sectionId));
  if (!box) return false;
  box.scrollIntoView({ block: "center" });
  box.focus();
  return true;
}
