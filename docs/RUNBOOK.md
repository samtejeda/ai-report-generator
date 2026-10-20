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

## Two-step sign-in (MFA, migration 0008)

Every role must set up an authenticator app. The secret and the ten one-time backup codes are stored **encrypted** in `auth_two_factors` with a key derived from `BETTER_AUTH_SECRET`; only `auth_runtime` can read the table, and only `auth_runtime` can set `users.two_factor_enabled`.

- **Rotating `BETTER_AUTH_SECRET` invalidates every enrollment** (the stored secrets can no longer be decrypted) as well as every cookie. Do not rotate it casually. If it must change, plan for every user to be reset with the script below and to enroll again; there is no re-encryption tool.
- **A user lost their phone but still has a backup code:** they can sign in with "Use a backup code instead" (each code works once). There is no screen yet to replace the authenticator on a working account; to move to a new phone, run the reset below, then enroll again.
- **A user lost the phone and the backup codes (or the owner did): break-glass reset.** Run on a machine you trust, with `DATABASE_URL_UNPOOLED` (the owner credential) in `.env.local`:

  ```
  node scripts/mfa-reset.mjs person@example.com          # dry run: prints the database host and who it would reset
  node scripts/mfa-reset.mjs person@example.com --apply  # does it
  ```

  Check the printed host is the database you mean, and confirm the person's identity by a channel other than email first. It removes the enrollment, turns the MFA flag off, deletes every session of the user, revokes every trusted device and pending link, and writes an `auth.mfa_reset` audit row (no actor user: the operator is the database owner). The password is untouched, so the person signs in with it and is sent to set up a new phone. If the account is also locked out of its password, use the normal password reset first.
- **The MFA step is locked** (5 wrong codes in a row): it clears on its own after 15 minutes. To clear it early (owner role): `UPDATE auth_two_factors SET failed_verification_count = 0, locked_until = NULL WHERE user_id = '<uuid>';`.
- **Trusted devices** are rows in `auth_verifications` whose `value` is the user id. Revoke one user's devices with `DELETE FROM auth_verifications WHERE value = '<user uuid>';` (this also clears pending reset links). A password change, a password reset and the MFA reset do this automatically. A device in regular use stays trusted: the 14 days restart at every sign-in from it.
- **Enrollment race:** the first sign-in of a new account has only a password in front of it, so whoever has the password and gets there first can enroll their own phone. The account owner gets an "Two-step sign-in was turned on" email at enrollment, so a hijack is visible; invitations (admin step) should hand out the first password only to the person who will enroll straight away.

## Row-level security (migration 0004)

Every tenant table has a policy `tenant_isolation` for `app_runtime`: a row is visible and writable only when its `organization_id` equals `app_current_org()`, which reads `app.organization_id` set by `tenantDb` for the current transaction. With nothing set, no rows match. The table owner (the migration role) is deliberately not forced through the policies, so **the app must never connect as the owner**; if it did, RLS would not protect anything. To check a database by hand: `select relname, relrowsecurity from pg_class where relname in (...)` and `select tablename, roles from pg_policies where schemaname = 'public'` (14 tables, 14 policies). Debugging tip: if a query unexpectedly returns zero rows, the usual cause is a statement run outside `tenantDb` (no tenant bound), not missing data.

## Client access: roles and assignments (migration 0009)

Who sees which client is decided inside the query (`lib/db/client-access.ts`): the **owner** sees every live client of the practice, an **associate** sees only clients with an active row in `client_assignments`, an **admin** sees only clients the owner has granted them, which is the same assignment row (an admin with no grant sees an empty list). A client the caller may not see is simply absent (404), so nothing confirms an id exists.

- **Assigning and ending are owner-only API calls** (`POST /api/admin/assignments` with `{clientId, userId}`, `DELETE /api/admin/assignments/{id}`; both audited, both take effect on the person's next request). There is no screen yet (`frontend-builder`), so until there is one an associate or admin sees an empty list until the owner makes those calls. Break-glass with the owner credential, an assignment is one row: `insert into client_assignments (organization_id, client_id, user_id, assigned_by_user_id) values (...)` (all four from the same organization; the composite foreign keys reject a mix). Do this only on synthetic data until Phase C, and it is an audited admin action once the screen exists, so do not make it a habit.
- **Ending an assignment** is `update client_assignments set deleted_at = now() where id = ...`; it takes effect on the person's next request. A client can be assigned again later (a new row).
- **A role change applies on the next request** (the role is read from the database every time, never from the cookie); no sign-out is needed.
- **Symptom: an associate says "my clients are gone".** Check, in order: the assignment row exists and `deleted_at` is null; the client's `deleted_at` is null; the user's `role` is still `associate`; the user and the client are in the same organization.
- **Symptom: a page is blank for an admin.** By design when the owner has granted them no client: `/clients` shows an empty list and `/api/clients` answers `{data: []}`. Grant a client with `POST /api/admin/assignments`. Check the same things as for an associate (grant exists and is not ended, client not deleted, same practice).
- **Public pages and endpoints** are the one list in `lib/auth/public-surface.ts`; the proxy lets those through and everything else needs a session cookie. A route, page or server action added without a guard fails CI (`lib/auth/guard-coverage.test.ts`).

## CI integration tests (the `integration` job)

The four database suites (`lib/db/integration.test.ts`, `lib/auth/auth.integration.test.ts`, `lib/auth/authz.integration.test.ts`, `lib/auth/admin.integration.test.ts`) run in CI as the `integration` job in `.github/workflows/ci.yml`, against a **CI-only Neon project** (synthetic data only). It is separate from the required `checks` job, which holds no secrets. The job is advisory until it has been green on a few PRs.

- **Why a separate project:** Neon logins belong to the whole project, so the owner login on the `test` branch is the same login as on `dev`. A GitHub secret holding it would be the `dev` owner credential. The CI project has its own owner password and holds nothing else. Never put a `dev` or `test` branch URL into a GitHub secret.
- **The secret:** one repository secret, `CI_DATABASE_URL`, the CI project's direct (unpooled) owner connection string. The job applies migrations with it, then the suites use it to create their own login roles with a random per-run password (generated in the job and masked; there is nothing else to store).
- **Who can read it:** only the migrate and test steps of the `integration` job. It runs for `push` to `main` and for pull requests from this repository, not from forks, and not for Dependabot. Without the secret the job passes with every step skipped.
- **Rotate:** reset the owner password in the Neon console for the CI project, then `gh secret set CI_DATABASE_URL` with the new string. No code change.
- **Reset the CI database:** the suites clean up after themselves, but a cancelled run can leave synthetic rows. Delete the leftover branch data or recreate the CI project's database, then re-run the job; it applies all migrations from scratch.
- **Symptom: the job is green but nothing ran.** The gate step found no `CI_DATABASE_URL` (secret missing or the PR came from a fork). Check the first step's log.
- **Symptom: a suite fails with timeouts or dropped WebSocket connections and no assertion failure.** These suites are slow and network-sensitive (see PROGRESS.md, `feat/auth-core`). Re-run the job once before treating it as a regression.

## Practice administration (migrations 0010 to 0012)

Everything here is an API call by the owner or an admin (there are no screens yet; `frontend-builder` adds them). Every call is checked on the server, audited with ids and role names only, and takes effect on the affected person's next request, with no sign-out needed.

- **Set or clear the practice's inference endpoint** (`PUT /api/admin/inference-endpoint`, body `{"endpoint": "https://<machine>.<tailnet>.ts.net/v1"}` or `{"endpoint": null}`): **owner only, and the owner must have signed in within the last 5 minutes** (otherwise 403 `reauth_required`: sign in again, code step included; there is no password prompt on purpose). Only Tailscale names are accepted: `https`, two labels before `.ts.net`, an optional port 443, 8443 or 10000, an optional `/v1`, lower case. Anything else is a 400 that does not repeat the value. The database refuses it too (CHECK constraint on `organizations`), and the app's database role cannot write the column at all except through `set_inference_endpoint()`. **Adding another kind of host (for example a Cloudflare Tunnel domain) is a new migration, on purpose: Sam names the domain.** Nothing reads the stored endpoint yet (the pipeline is not built); when it is, it must use the organization row and never a request value.
- **People** (`GET /api/admin/users`, `PATCH /api/admin/users/{id}` with `{"role": ...}`, `POST .../deactivate`, `POST .../reactivate`; owner or admin): nobody changes their own role or deactivates themselves; an admin never touches an owner and never makes one; only an owner promotes to owner or demotes an owner. **A practice always keeps at least one active owner** (a database trigger refuses otherwise, even when two owners act at the same moment). Handing the practice to someone else: the current owner promotes the new person to owner, then the new owner demotes the old one. A deactivated person's sessions stop on their next request and their address stays reserved; reactivating restores sign-in with the same password and authenticator. **Symptom: 409 on a role change** means the person is deactivated, the change raced another one, or it would remove the last owner.
- **Assigning clients** (owner only): see "Client access" above. An admin is granted clinical access exactly the same way as an associate, one client at a time.
- **A colleague lost their phone and backup codes** (`POST /api/admin/users/{id}/reset-mfa`; owner only, signed in within 5 minutes): removes their authenticator, signs them out everywhere, revokes their trusted devices and emails them a notice (best effort; the console transport only, until a real one is approved). Their password is unchanged, so their next sign-in sends them to set up a new phone. It refuses oneself and another owner. **An owner who loses everything** uses the break-glass script with the database owner credential: `node scripts/mfa-reset.mjs <email>` (dry run) then `--apply`.
- **Create the first practice and its owner** (`scripts/bootstrap-owner.mjs`, owner credential in `.env.local`; this is also how each later tenant starts, because there is no sign-up in the app): `node scripts/bootstrap-owner.mjs --org "Practice name" --email owner@example.com --name "Display Name" [--state RI]` is a dry run that prints the database host and what exists; check the host, then add `--apply`. It prints a one-time password once and stores only its hash. Give it to the owner privately and only when they are ready to set up their authenticator app straight away: the first sign-in is protected by that password alone until they do. They then change it on `/account`. It refuses an address that already has an account and a practice name that already exists. **Synthetic names and addresses only until Phase C.** If the one-time password is lost before the first sign-in, nothing in the app can reissue it yet (a reset link needs the real email transport): on a development database with synthetic data, remove that practice and owner with the owner credential and run the script again; ask Sam first for anything else.
- **Applying 0010, 0011 and 0012 to a real database** (Sam's go-ahead first): check `select count(*) from organizations where inference_endpoint is not null` is 0 (the new CHECK constraint would otherwise fail the migration), then `npm run db:migrate`, then confirm: `app_runtime` can update `organizations.name` but not `organizations.inference_endpoint`; the functions `set_inference_endpoint` (app role only) and `reset_user_mfa` (auth role only) exist; the trigger `users_keep_an_owner` is on `users`. Until applied, the admin routes that need them fail with a fixed 500.

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
