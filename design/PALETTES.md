# PALETTES.md

Palette is a mechanism, not a hardcode. This lets the same repo be re-skinned for a different practice (tenant).

**The palette files override the design file on color.** `DESIGN.md` still governs typography, spacing, radius, and component states.

## Mechanism

- One active palette per deployment, selected by an env var (for example `NEXT_PUBLIC_PALETTE=default`).
- Identity tokens (primary, accent, surface, ink) are re-filled per palette in a CSS file per palette (for example `app/palettes/<name>.css`, scoped under `[data-palette="<name>"]`).
- Shared tokens (spacing, radius, type scale) live once in the Tailwind theme block.
- Components use token utilities only (`bg-primary`, `text-ink`), never raw hex values, so recoloring needs no component edits.

## Contrast rule

Every text/background token pairing in a palette must meet WCAG AA (4.5:1 body text, 3:1 large text and UI components). Record the checked pairs and ratios in the palette file header.

## How to add a palette

1. Copy `app/palettes/default.css` to `app/palettes/<name>.css`.
2. Fill the identity tokens; keep the token names identical.
3. Check every text/background pair against the contrast rule and record the ratios.
4. Register the name in the palette loader and set the env var for the deployment.
5. Verify no component needed edits; if one did, it used a raw value and must be fixed.

_Status: no palette files exist yet; created with the app scaffold and restyle pass._
