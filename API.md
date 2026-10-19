# API.md

Inventory of every endpoint and server action. Updated in the same commit as any new or changed route (owner: `backend-builder`). No orphan test routes.

## Conventions

- Resource-oriented paths under `app/api/`, plural nouns, kebab-case: `/api/clients`, `/api/reports/{id}/sections/{sectionId}`.
- Methods: `GET` read, `POST` create/action, `PATCH` partial update, `DELETE` remove (soft delete unless a hard-deletion request).
- Every handler: authenticate, authorize (role + `organization_id`), validate input with a schema, call a tenant-scoped data function, write an audit event, return minimal fields.
- Errors: JSON `{ "error": { "code": string, "message": string } }` with correct status codes (400 validation, 401 unauthenticated, 403 unauthorized, 404 not found within the caller's org, 409 conflict, 429 rate limited, 500 generic with no internals).
- Return 404 (not 403) for resources in another organization, to avoid leaking existence.
- Lists are paginated (cursor or limit/offset with a max).
- Never include `password_hash`, tokens, or other tenants' fields in responses.
- Never log request bodies; audit events carry ids, not PHI.
- Generation endpoints stream via the Vercel AI SDK and call inference only through `lib/ai/inference.ts`.

## Endpoints

| Method | Path | Auth / roles | Purpose | Audit event | Rate limit |
|---|---|---|---|---|---|
| GET | `/api/health` | Public (intentionally; no tenant data) | Liveness plus database reachability (`select 1`). Returns `{status:"ok"}` or 503 `{status:"unavailable"}`; no versions, hosts, or error text. | None (health noise excluded) | None yet (resilience-builder to add a coarse limit) |
| POST | `/api/auth/sign-in/email` | Public (it creates the session) | Email + password sign-in. Needs a verified, active account; sets the session cookie (httpOnly, SameSite=Lax, 12 h cap). Same 401 for a wrong password and an unknown address. | `auth.login` / `auth.login_failed` (known users only) | 5 per 15 min per client address |
| POST | `/api/auth/sign-out` | Session | Ends the session server-side and clears the cookie. | `auth.logout` | Default (60 per minute per address) |
| POST | `/api/auth/request-password-reset` | Public | Emails a single-use reset link (valid 60 min) if the address has an active account. Same answer either way. | `auth.password_reset_requested` (known users only) | 3 per 15 min per client address |
| GET | `/api/auth/reset-password/{token}` | Public (the token is the credential) | Validates a link and redirects to `/reset-password?token=…` (or `?error=INVALID_TOKEN`). | None | 5 per 15 min per client address |
| POST | `/api/auth/reset-password` | Public (the token is the credential) | Sets a new password, spends the token, signs out every session, and emails a "password changed" notice. | `auth.password_reset_completed` | 5 per 15 min per client address |
| POST | `/api/auth/send-verification-email` | Public | Emails a new verification link if the address has an unverified, active account. | None | 3 per 15 min per client address |
| GET | `/api/auth/verify-email` | Public (the signed token is the credential) | Marks the address verified; does not sign in. | `auth.email_verified` | 10 per 15 min per client address |
| POST | `/api/auth/change-password` | Session | Changes the password after re-checking the current one; can sign out other sessions; emails a notice. | `auth.password_changed` | 5 per 15 min per client address |
| POST | `/api/auth/two-factor/enable` | Session (password only; MFA not yet on) | Re-checks the password, creates an unverified authenticator secret and 10 backup codes (both stored encrypted), returns the setup URI and the codes once. MFA is not on until the first code verifies. | `auth.mfa_enrollment_started` | 5 per 15 min per client address |
| POST | `/api/auth/two-factor/verify-totp` | Session (enrollment) or the signed code-step cookie (sign-in) | Enrollment: the first valid code turns MFA on. Sign-in: a valid code completes login; `trustDevice: true` also marks the device trusted for 14 days. 5 wrong codes end the challenge; 5 consecutive wrong codes lock the account's code step for 15 min. | `auth.mfa_enrolled`, `auth.login`, `auth.mfa_device_trusted`, `auth.mfa_failed` | 10 per 15 min per client address |
| POST | `/api/auth/two-factor/verify-backup-code` | The signed code-step cookie (sign-in) | A valid unused backup code completes login and is spent. | `auth.login`, `auth.mfa_backup_code_used`, `auth.mfa_device_trusted`, `auth.mfa_failed` | 10 per 15 min per client address |
| POST | `/api/auth/two-factor/generate-backup-codes` | Session (MFA on) | Re-checks the password, replaces all backup codes, returns the new ones once. | `auth.mfa_backup_codes_regenerated` | 5 per 15 min per client address |

Only the twelve `/api/auth/*` endpoints above are reachable; the route (`app/api/auth/[...all]/route.ts`) answers 404 for every other Better Auth path (sign-up, get-session, list-sessions, update-user, social login, ...). The list lives in `lib/auth/route-policy.ts` and a test keeps it equal to this table. POSTs are also checked for origin (CSRF) and redirect targets.

## Pages

| Path | Auth | Purpose |
|---|---|---|
| `/login` | Public | Email + password form, then the code step (authenticator or backup code; an unchecked "Trust this device for 14 days" box). |
| `/forgot-password` | Public | Requests a reset link; the same message whether or not the address has an account. |
| `/reset-password` | Public (the emailed token is the credential) | Choose a new password; the token is removed from the address bar once read, and no Referer is sent. |
| `/account/mfa` | Password session without MFA yet (`getEnrollingSessionOrNull()`); already-enrolled users are sent to `/account` | Three steps: confirm password, add the setup key to an authenticator app and type the first code, save the backup codes (shown once). |
| `/account` | Session (`requireSession()` inside the page) | Shows the signed-in role and a sign-out button. Proving ground for `requireSession()`. |

## Server actions

| Action | File | Auth / roles | Purpose | Audit event |
|---|---|---|---|---|
| _none yet_ | | | | |
