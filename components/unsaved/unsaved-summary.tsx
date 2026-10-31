"use client";

import { sectionBoxId, summaryHeading } from "@/lib/reports/unsaved";
import { focusSectionBox } from "./focus-section-box";
import { useUnsavedSections } from "./use-unsaved";

// The red box at the top of the report page: every section with changes that are not saved, each
// a link that scrolls to and focuses its text box. It reads the same store as the leave dialog and
// Sign out, so they cannot disagree. Nothing is shown when nothing is unsaved.
export function UnsavedSummary() {
  const sections = useUnsavedSections();
  if (sections.length === 0) return null;
  return (
    <div role="region" aria-label="Unsaved changes" className="flex flex-col gap-1 rounded-md border border-red-700 p-3 text-sm text-red-700">
      <p className="font-medium">{summaryHeading(sections.length)}</p>
      <ul className="list-inside list-disc">
        {sections.map((s) => (
          <li key={s.key}>
            <a
              href={`#${sectionBoxId(s.key)}`}
              className="underline"
              onClick={(event) => {
                // Same-page link: do the scroll and the focus ourselves so the box takes the cursor.
                if (focusSectionBox(s.key)) event.preventDefault();
              }}
            >
              {s.title}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
