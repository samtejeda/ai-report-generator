# RUNBOOK.md

Step-by-step failure recovery. Stub for now; fill each section as the infrastructure lands, and record the date it was last drilled. Anything not yet drilled is **unverified**.

## Rollback a bad deploy

_TODO when Vercel is connected._ Expected: promote the previous Vercel deployment (or `vercel rollback`), then revert the PR on a `fix/` branch. Rollback reverts code, not schema; migrations are forward-only and backward-compatible with the previous deploy.

## Database restore (Neon)

Neon keeps a history window per project (dev project `delicate-boat-70144866`: **6 hours**, `history_retention_seconds: 21600`, Postgres 18). Recovery inside that window:

1. Pick the timestamp just before the damage (UTC, RFC 3339).
2. Do NOT restore over the damaged branch first. Make a scratch copy and restore that:
   `neon branches create --name restore-check --parent <branch> --project-id <id>`
   `neon branches restore restore-check "<branch>@<timestamp>" --project-id <id>`
3. Connect to the scratch branch (`neon connection-string restore-check --project-id <id> --role-name neondb_owner`; a branch with several roles needs `--role-name`) and validate row counts and the data you expect.
4. Only then decide: restore the real branch in place (`neon branches restore <branch> <branch>@<timestamp>`; Neon keeps a backup branch of the pre-restore state) or copy the needed rows across.
5. Repoint nothing if restored in place (same endpoint). Delete the scratch branch when done.

Last drilled: 2026-10-13 on the dev project's `test` branch (see Backup drill). Not drilled on a production project (does not exist yet) and the window there will differ by plan.

## Backup drill

- **2026-10-13 (Claude, with Sam's approval of the data-model plan): passed, dev project only.**
  - Created scratch branch `restore-drill` from `test`, then `neon branches restore restore-drill "test@2026-10-13T17:02:25Z"` (about 4 s).
  - Verified against the live `test` branch: scratch had 2 organizations / 7 clients / 5 report versions / 4 audit rows at that moment, versus 6 / 21 / 15 / 12 on `test` now. Schema and `purge_client()` were present in the restored copy.
  - Deleted the scratch branch afterwards. `test`, `dev`, `production` were not modified.
  - Limits: in-place restore of a real branch was not exercised (scratch copy only); the free-plan window is 6 hours, so this proves recoverability, not long-term backup retention. Re-drill on the production Neon project (Scale plan) before Phase C and record it here.

## Database roles and the app login (Neon)

Migration `0003` creates the NOLOGIN group role `app_runtime` with per-table least-privilege grants. The app connects as a **login role that is a member of it**, created with SQL, never in a migration and never in the Neon console (console/API roles are `neon_superuser` members and would bypass the grants; verified on the test branch that a SQL-created member is not):

```sql
CREATE ROLE <login_name> LOGIN PASSWORD '<generated, 32+ hex chars>' IN ROLE app_runtime;
```

Then set `DATABASE_URL` (pooled) to that role. Keep `DATABASE_URL_UNPOOLED` on the owner role: it is for drizzle-kit migrations only. Rotate with `ALTER ROLE <login_name> PASSWORD '...'`. Integration tests use `app_runtime_test` on the `test` branch with the password in the gitignored `.env.test.local`.

## Row-level security (migration 0004)

Every tenant table has a policy `tenant_isolation` for `app_runtime`: a row is visible and writable only when its `organization_id` equals `app_current_org()`, which reads `app.organization_id` set by `tenantDb` for the current transaction. With nothing set, no rows match. The table owner (the migration role) is deliberately not forced through the policies, so **the app must never connect as the owner**; if it did, RLS would not protect anything. To check a database by hand: `select relname, relrowsecurity from pg_class where relname in (...)` and `select tablename, roles from pg_policies where schemaname = 'public'` (14 tables, 14 policies). Debugging tip: if a query unexpectedly returns zero rows, the usual cause is a statement run outside `tenantDb` (no tenant bound), not missing data.

## Hard deletion of a client

`SELECT purge_client(<org_uuid>, <client_uuid>)` (via `tenantDb(ctx).purgeClient(id)`; the function refuses an organization other than the transaction's tenant) deletes the client and all derived rows and returns per-table counts; it is not wired to any route and **needs Sam's explicit approval before it touches anything but synthetic data**. `audit_log` is never touched. Purged data persists in Neon history/backups until the retention window passes: a wording question for the privacy lawyer (see PROGRESS pre-launch checklist).

## Inference endpoint down (Ollama / tunnel)

_TODO._ Expected: the health endpoint reports the org's endpoint as unavailable; generation returns a clear error; **no silent cloud LLM fallback**. Steps: check Ollama on the host, check Tailscale status, check endpoint registered on the organization record.

## Failed migration

_TODO._ Expected: stop deploys, restore from Neon branch/PITR if data was affected, ship a forward-fix migration.

## Leaked secret

_TODO._ Expected: rotate the secret in the provider, update Vercel env, redeploy, scan git history, record in PROGRESS.md.

## Suspected PHI exposure

_TODO._ Escalate to Sam immediately; this is a stop-and-ask item and likely a legal/BAA matter.
