# Audit: Frontend

**Owning agent:** `frontend-builder`

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. Components live in separate files with consistent naming (one component per file, `PascalCase` components, `kebab-case` files per the project convention).
2. Every screen is correct at phone width (375px) first, and at desktop width too.
3. Semantic HTML, labeled images, and full keyboard navigation (including the report section editor, edit/regenerate buttons, and dialogs).
4. Consistent colors, fonts, spacing, and button sizes. Styled screens use `DESIGN.md` tokens only (applies after the restyle pass; during the feature pass, mark "n/a: plain UI pass").
5. Images optimized, no premature code loading; server components by default, client components only where interactivity demands it.
6. Forms show clear errors and keep the user's input on a failed submit.
7. (Added for this project) No PHI in URLs, `localStorage`, or client-side logs; unsaved report edits are not silently lost (draft kept or user warned).

Give me an overall score out of 7 and list the top 3 things to fix first.
