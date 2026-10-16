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

## Authentication role and login (migration 0006)

Better Auth connects as its own role, so a bug in feature code cannot read a password hash or session token and a bug in the auth layer cannot read clinical data. Migration `0006` creates the NOLOGIN group role `auth_runtime` (the four `auth_*` tables, `SELECT` on `users`, `UPDATE` of `email_verified` only; nothing on clients, reports, organizations, `audit_log` or `purge_client()`). `app_runtime` has no privilege on the `auth_*` tables. The app's auth login role is created like the app login, with SQL, a generated password, and membership of the group role (never in a migration, never in the console):

```sql
CREATE ROLE <auth_login_name> LOGIN PASSWORD '<generated, 32+ hex chars>' IN ROLE auth_runtime;
```

Set `AUTH_DATABASE_URL` (pooled host) to that role; the password goes straight into the environment and is never printed or committed. Also set `BETTER_AUTH_SECRET` (32+ random characters, `openssl rand -base64 32`; one per environment) and `BETTER_AUTH_URL` (the public origin). Rotate the login with `ALTER ROLE <auth_login_name> PASSWORD '...'`. Integration tests use `auth_runtime_test` and `app_runtime_authtest` on the `test` branch.

## Authentication operations

- **Session times** live in `lib/auth/config.ts` (idle 2 h, absolute cap 12 h, reset link 60 min, rate limits). Changing them is a code change and a deploy; existing sessions follow the new idle value at their next slide and the new cap immediately.
- **Sign everyone out** (suspected cookie theft, or after rotating `BETTER_AUTH_SECRET`, which invalidates every signed cookie by itself): as the owner role, `DELETE FROM auth_sessions;` (one user: add `WHERE user_id = '<uuid>'`).
- **Deactivate a user:** set `users.deleted_at` and delete their sessions in the same step; the next request from any of their sessions is refused either way (checked on every request), and deactivated users get no reset link.
- **A user is locked out by the rate limiter:** it expires on its own 15 minutes after the last attempt from that address. To clear it early (owner role): `DELETE FROM auth_rate_limits WHERE key LIKE '%<address>%';`.
- **Expired sessions and tokens are not purged automatically yet** (Better Auth removes them when they are touched). A scheduled cleanup of `auth_sessions`, `auth_verifications` and `auth_rate_limits` rows past `expires_at` / old `last_request` is a follow-up; none of these hold PHI.
- **Email:** only the console transport exists, which the environment schema refuses in production. Until a real transport is approved and added, a deployed environment cannot send verification or reset mail; the owner is bootstrapped with a verified address instead.

## Row-level security (migration 0004)

Every tenant table has a policy `tenant_isolation` for `app_runtime`: a row is visible and writable only when its `organization_id` equals `app_current_org()`, which reads `app.organization_id` set by `tenantDb` for the current transaction. With nothing set, no rows match. The table owner (the migration role) is deliberately not forced through the policies, so **the app must never connect as the owner**; if it did, RLS would not protect anything. To check a database by hand: `select relname, relrowsecurity from pg_class where relname in (...)` and `select tablename, roles from pg_policies where schemaname = 'public'` (14 tables, 14 policies). Debugging tip: if a query unexpectedly returns zero rows, the usual cause is a statement run outside `tenantDb` (no tenant bound), not missing data.

## Hard deletion of a client

`SELECT purge_client(<org_uuid>, <client_uuid>)` (via `tenantDb(ctx).purgeClient(id)`; the function refuses an organization other than the transaction's tenant) deletes the client and all derived rows and returns per-table counts; it is not wired to any route and **needs Sam's explicit approval before it touches anything but synthetic data**. `audit_log` is never touched. Purged data persists in Neon history/backups until the retention window passes: a wording question for the privacy lawyer (see PROGRESS pre-launch checklist).

## Inference endpoint down (Ollama / tunnel)

_TODO._ Expected: the health endpoint reports the org's endpoint as unavailable; generation returns a clear error; **no silent cloud LLM fallback**. Steps: check Ollama on the host, check Tailscale status, check endpoint registered on the organization record.

## Failed migration

_TODO._ Expected: stop deploys, restore from Neon branch/PITR if data was affected, ship a forward-fix migration.

## Leaked secret

_TODO._ Expected: rotate the secret in the provider, update Vercel env, redeploy, scan git history, record in PROGRESS.md. For `BETTER_AUTH_SECRET`: replace it everywhere (this signs out every user); for a database login password: `ALTER ROLE ... PASSWORD`, update the environment, redeploy.

## Suspected PHI exposure

_TODO._ Escalate to Sam immediately; this is a stop-and-ask item and likely a legal/BAA matter.
