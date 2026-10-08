# Audit: Hosting and Deployment

**Owning agent:** `platform-ops-builder` (paired with `07-cloud-and-compute.md`, `08-cicd-and-version-control.md`)

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. All secrets are in Vercel's environment settings, separate per environment.
2. Valid HTTPS on all served hosts.
3. Clean build with no errors or ignored type/lint failures.
4. Correct domain and DNS.
5. Deploy connected to the repo with PR preview deployments.
6. One-click rollback exists and has been tested.
7. (Added) The BAA-tier gate is tracked in the `PROGRESS.md` Pre-launch checklist, and no real client data is on non-BAA tiers.

Give me an overall score out of 7 and list the top 3 things to fix first.
