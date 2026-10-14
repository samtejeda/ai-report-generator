# Audit: Supply Chain

**Owning agent:** `platform-ops-builder`

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions. Added after the original 13 (14 is inference). Scope is deliberately proportionate: one baseline report plus a few cheap CI guards, not continuous scanning of every package.

For each item, tell me pass or fail with a specific example.

1. **Baseline dependency report** (one time, repeat before Phase C): every package in the lockfile, prod and dev, assessed for weekly downloads, maintainer changes in the last 90 days, install scripts, last publish date, and number of dependencies pulled in. Packages under 100 weekly downloads, packages with install scripts that run arbitrary code, and names within one or two characters of a popular package (typosquat check) are each listed with a decision. The report and the method used are recorded in `PROGRESS.md`.
2. **Install-script allowlist enforced in CI:** the build fails if a package outside the recorded allowlist gains an install script. The current allowlist and why each entry is legitimate are written down.
3. **Lockfile integrity on every build:** CI installs with `npm ci` (verifies every package against the lockfile hash and fails on a mismatch), `npm audit signatures` passes or its exceptions are listed, and CI fails if any lockfile entry resolves outside `registry.npmjs.org`.
4. **Lockfile change review on every PR:** added, removed, and changed packages are reported on the PR before merge (GitHub's dependency review action, free on this public repo), and newly introduced high-severity advisories fail the check.
5. **Environment scoping:** `process.env` is read only in a short, named list of files, enforced by a lint rule. The app's runtime schema does not include `DATABASE_URL_UNPOOLED` (owner credential, `drizzle-kit` only). Every variable is documented with the module that reads it, and a deployed environment holds only what runtime needs.
6. **New-dependency rule followed:** the rule in `ORCHESTRATION.md` is applied; each PR that adds a package states the checks done (downloads, maintainers, install scripts, age) in its description.
7. **Known advisories have a recorded decision:** every high or critical `npm audit` finding, including those in the production dependency list (for example `braces` via `shadcn`), has an owner, a reason, and a revisit trigger in `PROGRESS.md`, or is fixed.

Give me an overall score out of 7 and list the top 3 things to fix first.
