# design/

Provenance and rules for design reference files.

| File | Role | Source | Provenance |
|---|---|---|---|
| `../DESIGN.md` | Primary design system (placeholder) | getdesign.md, brand TBD | Not yet fetched. Sam to choose a brand. |
| `DESIGN-<brand>-reference.md` | Optional secondary reference, structure only | getdesign.md, brand TBD | Not added. |
| `PALETTES.md` | Palette mechanism and rules | This project | Written 2026-10-08. |

## Rules

- Primary reference: one `DESIGN.md` from getdesign.md (VoltAgent/awesome-design-md). Follow it for all styled UI work.
- Vet before running: `getdesign` is a third-party package. Inspect it read-only first (it is a small script that copies a bundled markdown file and sends one anonymous telemetry POST). Copying the file out of the unpacked tarball avoids running any of its code. Not yet vetted.
- Secondary reference: structure only (tables, tags, cards for data-dense screens such as score tables). Never let it supply colors or type. Do not add a third.
- Keep upstream files unmodified so they can be diffed against future versions. Record project decisions (font substitutes, light-only, etc.) in `PROGRESS.md` and in this README.
