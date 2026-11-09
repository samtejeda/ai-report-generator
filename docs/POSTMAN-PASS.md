# POSTMAN-PASS.md

Server-side checks the browser cannot reach: limits the screens hide (the browser cuts a box before the server sees it), tampered bodies, wrong roles, wrong origins, and every rate limit. Written 2026-11-09 from `API.md` and the code on `main`; every "Expect" is what those say should happen, so a mismatch is a finding, not necessarily your mistake. Nothing below has been run yet. **Status of every row: not run.**

Postman (or any HTTP client) is a **second look from outside**, not the only protection: CI already runs these rules at the route level against a real database (`authz`, `admin`, `clients`, `reports`, `generation`, `state`, `export` and `invitations` integration suites). A row that fails here but passes in CI usually means the setup differs (cookie, origin, the code step), so check the setup first.

**Synthetic data only.** Same rule as the click-through: invent every name and note. Run against the app on `localhost:3000` and the `dev` database, never anything else.

Mark each row Pass, Fail or Skip in the results table at the end. For a Fail write what you sent, what came back and what you expected (never paste a cookie, token or password). Hand the table to the supervising session, which reads the audit log (read-only) and checks that each action left the expected row and that none contains client text.

## 0. Setup and cautions

1. **Signing in is a browser job.** The code step (authenticator) makes a plain API sign-in awkward. Sign in once in the browser, then copy the session cookie into Postman (find it in the browser's developer tools under Application, Cookies, `localhost`; treat it like a password, never commit or paste it). Session limits apply: idle out at 2 hours, hard stop at 12.
2. **State-changing calls need an `Origin` header** equal to the app's own origin, exactly `http://localhost:3000` (no trailing slash). Without it every POST, PUT, PATCH and DELETE is a 403 `forbidden_origin`, checked **before** the session, so an unsigned call without it is also 403, not 401. GET needs no Origin.
3. **Some calls need a sign-in from the last 5 minutes** (invitations create, inference endpoint, owner MFA reset): a 403 `reauth_required` means sign in again in the browser and copy the new cookie.
4. **Limits are real and per person or per address.** Space the runs out; the sign-in limit (10 per 15 minutes per address) counts every request. Some rows below need a runner with no delay (P12); everything else is one call at a time.
5. **Invitation links print in the dev terminal** (`[dev email] to=... token=...`). The token is 43 characters. Never put a token in a note.
6. **Do not leave a fake inference endpoint set.** Clear it (`PUT` with `{"endpoint": null}`) when you finish P9.
7. Use a **second browser profile with a second cookie** for the associate. **The admin role is not in use (Sam, 2026-11-09: only owner and associate), so every row that says Admin is skipped**; the rows stay in case the role comes back, and CI keeps proving them. Name the Postman cookie jars `owner` and `associate`.
8. Some rows need an associate (invitation by hand, MANUAL-TEST.md B), a `generated` report (blocked until the inference endpoint exists, C2) or a second practice (MANUAL-TEST.md E, Sam's go-ahead). Those are marked **needs: ...**.

## P1. Limits the browser hides (finding A3.4 and A4.5 from the first run)

| # | Send | Expect |
|---|---|---|
| P1.1 | `POST /api/clients` with `displayName` of 201 characters | 400 `validation_failed`; nothing created (A3.4, never reached the server by hand) |
| P1.2 | `POST /api/clients` with `displayName` of exactly 200 characters | 201 |
| P1.3 | `POST /api/clients` with an empty `displayName` and with only spaces | 400 |
| P1.4 | `POST /api/clients` with an extra key, for example `organizationId` or `id` | 400 (strict body); nothing created |
| P1.5 | `POST /api/clients` with `dateOfBirth` in the future, `1899-12-31`, `2020-02-30` and `20-01-2020` | 400 each |
| P1.6 | `POST /api/clients` with `gradeLevel` of 21 characters and with a symbol such as `<` | 400 each |
| P1.7 | `POST /api/clients` with `externalId` of 65 characters, then the same valid `externalId` twice | 400, then 409 on the second (the 409 does not repeat the value) |
| P1.8 | `POST /api/clients` with a body over 2 KB | 400 or 413; nothing created |
| P1.9 | `PATCH /api/clients/{id}` with `{}` and with `null` on `displayName` | 400 each; `null` on an optional field clears it |
| P1.10 | `PUT /api/reports/{id}/sections/{sectionId}` with `text` of **20 001** characters (A4.5), then exactly 20 000 | 400, then 200 `{versionId, version}` |
| P1.11 | Same PUT with a control character (for example `\u0000` or `\u0007`) in `text`; then with only line breaks and tabs | 400; 200 |
| P1.12 | Same PUT with `baseVersion` that is not the current version | 409; no new version; the error does not echo the text |
| P1.13 | Same PUT with an extra key or no `baseVersion` | 400 |
| P1.14 | Any list (`/api/clients`, `/api/reports`, `/api/admin/users`) with `limit=0`, `limit=101`, `offset=10001` and an unknown query key | 400 each |
| P1.15 | `GET /api/clients/not-a-uuid`, `/api/reports/not-a-uuid` | 400 |

## P2. Origin (CSRF) and signed-out calls

| # | Send | Expect |
|---|---|---|
| P2.1 | Any state-changing call (for example `POST /api/clients`) with a valid cookie and **no** `Origin` | 403 `forbidden_origin`; nothing created |
| P2.2 | The same with `Origin: https://example.com` and with `Origin: http://localhost:3000/` (trailing slash) | 403 each |
| P2.3 | The same with the right `Origin` and **no cookie** | 401 |
| P2.4 | `GET /api/me`, `/api/clients`, `/api/reports`, `/api/admin/users`, `/api/reports/{id}/export?format=docx` with no cookie | 401 each; no data |
| P2.5 | `GET /api/health` with no cookie | 200 `{"status":"ok"}` and nothing else |
| P2.6 | A made-up path under `/api/auth/` (for example `/api/auth/sign-up/email`, `/api/auth/get-session`, `/api/auth/list-sessions`) | 404 (only the twelve listed auth routes exist) |
| P2.7 | `POST /api/invitations/accept` with a wrong `Origin` | 403 (own origin required even though it is public) |

## P3. Roles through the API (needs: associate; Admin rows skipped, the role is not in use)

CI proves this in `authz.integration.test.ts` and the admin and client suites; this is the by-hand confirmation. Expected status as the role in the first column:

| # | As | Send | Expect |
|---|---|---|---|
| P3.1 | Associate | `GET /api/admin/users`, `/api/admin/assignments`, `/api/admin/invitations` | 403 each, each leaves an `authz.denied` row |
| P3.2 | Associate | `GET /api/admin/inference-endpoint`, then `PUT` it | 403 both |
| P3.3 | Associate | `DELETE /api/clients/{id}` on an assigned client | 403; the client is still there |
| P3.4 | Associate | `GET /api/clients/{id}` and `/api/reports/{id}` for a client not assigned to them | 404, byte-for-byte the same as a made-up id |
| P3.5 | Associate | `POST /api/admin/assignments` to give themselves a client | 403 |
| P3.6 | Admin (no grant) | `GET /api/clients` and `/api/reports` | 200 with empty lists |
| P3.7 | Admin (no grant) | `GET /api/clients/{id}` for a real client | 404 |
| P3.8 | Admin (with a grant) | `GET` the granted client and its report | 200, read only |
| P3.9 | Admin (with a grant) | `POST /api/clients`, `PATCH /api/clients/{id}`, `POST /api/reports`, `PUT` a section, `POST` generate, `POST` finalize, `GET` export | 403 each (an admin never writes, never exports), each audited as `authz.denied` |
| P3.10 | Admin | `PATCH /api/admin/users/{id}` to make someone an owner; and to change an owner's role | 403 each (audited, reasons `admin_cannot_grant_owner`, `admin_cannot_touch_owner`) |
| P3.11 | Owner | `PATCH /api/admin/users/{ownId}` (own role), `POST .../deactivate` on oneself | 403 (`self_change`) |
| P3.12 | Owner | Demote or deactivate the **last active owner** | 409 |
| P3.13 | Owner | `POST /api/admin/users/{ownerId}/reset-mfa` on oneself or on another owner | 403 |
| P3.14 | Owner | `POST /api/admin/assignments` with an owner as `userId` | 400 |
| P3.15 | Owner | `POST /api/admin/assignments` twice for the same client and person | 201, then 409 |

## P4. Reports, generation, finalize (the flow rules)

| # | Send | Expect |
|---|---|---|
| P4.1 | `POST /api/reports` with an unknown `templateSlug`, a made-up `clientId`, and an extra key | 404, 404, 400 |
| P4.2 | `POST /api/reports/{id}/finalize` on a `draft` report | 409; status unchanged |
| P4.3 | `POST /api/reports/{id}/sections/{sectionId}/generate` with **no endpoint set** | 409 `inference_not_configured`; the report stays `draft`; nothing sent anywhere |
| P4.4 | Generate with a section id that belongs to another report | 404 |
| P4.5 | Generate on a section that already has text | 409 (only an empty prose section) |
| P4.6 | **needs: a `generated` report** `PUT` a section, then `POST` finalize, then `PUT` again and finalize again | 200, 200, 409 (a finalized report takes no edit), 409 (final) |
| P4.7 | **needs: a working endpoint** start 3 generations at once on 2 reports | at most 2 run; the third is a 429 with `Retry-After` |
| P4.8 | **needs: a working endpoint** 11 generation starts by one person in 10 minutes | the 11th is a 429 (10 per person per 10 minutes); 31 per practice |
| P4.9 | `GET /api/reports?status=nonsense` and `?clientId=nope` | 400 each |

## P5. The state check (`GET /api/reports/{id}/state`)

| # | Send | Expect |
|---|---|---|
| P5.1 | A normal call, then after a save | `{data:{status, sections:[{id, version, editType, editedAt, authorName}]}}`, `version` up by one; no text, no titles, no email |
| P5.2 | An unknown id, another practice's id, a malformed id | 404, 404, 400; identical bodies for the first two |
| P5.3 | **121 calls inside one clock minute** (use the runner, P12) | the first 120 are 200; the 121st is a 429 `rate_limited` with `Retry-After`; the 429 says nothing about any report. CI proves this (`state.integration.test.ts`); the by-hand console loop is too slow to reach it |
| P5.4 | After all of the above, look at the audit | **No** audit row from any call (Sam's decision, 2026-10-30); the counter row only |

## P6. Word export (`GET /api/reports/{id}/export?format=docx`)

| # | As | Send | Expect |
|---|---|---|---|
| P6.1 | Owner | The call with the right query | 200; `Content-Type` is the docx type; `Content-Disposition` is an attachment named `report-<id>.docx`; caching off; the body is a real .docx (it opens) |
| P6.2 | Owner | `format=pdf`, no `format`, `format=docx&x=1` | 400 `validation_failed` each; no file |
| P6.3 | Owner | An unknown id, another practice's id (**needs: E**), a malformed id | 404, 404, 400; the first two identical to each other |
| P6.4 | Associate | A report on an unassigned client | 404 (same as a made-up id) |
| P6.5 | Admin | Any report, with and without a grant | 403 each, audited as `authz.denied` |
| P6.6 | Owner | Export 21 times in 10 minutes (runner) | The 21st is a 429 with `Retry-After`; each earlier export left one `report.exported` row |
| P6.7 | Owner | After one export, read the audit | One `report.exported` row (report id, role, `format`), no content, no file name, no client text |
| P6.8 | Owner | A section containing `<script>`, `&`, `"`, a very long line and emoji | The file opens; the text is literal; nothing is lost except characters Word cannot hold |
| P6.9 | Owner | A draft report, then a finalized one (**needs: C2**) | Draft: `DRAFT, not finalized` on the first line and every page header. Finalized: neither |
| P6.10 | Owner | An empty prose section | Its heading and `[Not yet written]` |

## P7. Invitations (needs: owner; **the accept route is public**)

| # | Send | Expect |
|---|---|---|
| P7.1 | `POST /api/admin/invitations` `{"email":"associate-test@example.com"}`, signed in within 5 minutes | 201 `{data:{id, email, role:"associate", status:"pending", expiresAt}}`; the link prints in the dev terminal; no token in the response |
| P7.2 | The same with a sign-in older than 5 minutes | 403 `reauth_required` |
| P7.3 | Create with `role: "owner"`, then `role: "admin"`, then an extra key, then no email, then `email: "not-an-address"` | 400 each; nothing stored |
| P7.4 | Create the same address twice | 201 both; the list shows **one** pending row; the first link is now dead |
| P7.5 | Invite an address that already has an account (your own owner address) | **The same 201** as P7.1, a row listed, **no mail line** in the terminal, nothing in the response that says why |
| P7.6 | `GET /api/admin/invitations` | `{data:[{id, email, role, status, expiresAt, createdAt, invitedByUserId}], limit, offset}`; never a token or its hash |
| P7.7 | `POST .../{id}/revoke`; again; on an accepted one; on another practice's id (**needs: E**) and a made-up id | 200; 200 (nothing changed); 409; 404; 404 |
| P7.8 | `POST .../{id}/resend` on pending; then try the old link | 200 with a new link; the old one fails |
| P7.9 | Resend on an accepted or revoked one | 409 |
| P7.10 | `POST /api/invitations/accept` `{token, name, password}` (no cookie, own Origin) with a good link | 201 `{data:{status:"accepted"}}`; **no cookie set, no session** |
| P7.11 | The same body again; a token with one character changed; a revoked link; an expired one (**needs: a database edit, skip by hand**); a link for an address that has an account by now | **One** answer for all: 400 `invalid_invitation`, the same body and headers and about the same time (compare them) |
| P7.12 | Accept with a password of 11 characters, 129 characters, an empty `name`, a `name` of 201 characters, and an extra key | 400 `validation_failed` each, decided before the token is looked up (so it says nothing about the link); the link still works afterwards (confirm by trying a good one) |
| P7.13 | Accept 11 times in 15 minutes from one address | The 11th is a 429 with `Retry-After` |
| P7.14 | Create or resend 21 times in an hour (runner) | The 21st is a 429 with `Retry-After`; refused attempts count too |
| P7.15 | As an associate and as an admin: `GET`, `POST`, revoke and resend on `/api/admin/invitations` | 403 each, audited |
| P7.16 | After accepting, sign in as the new person | Sent to authenticator setup; role is `associate`; no clients (the list is empty) |
| P7.17 | Read the audit for the whole run | `invitation.created`, `invitation.refused` (reason `address_in_use`, names no practice), `invitation.revoked`, `invitation.resent`, and the accept rows; **no token, hash or address** in any metadata |

## P8. Inference endpoint (owner only, sign-in within 5 minutes)

| # | Send | Expect |
|---|---|---|
| P8.1 | `PUT /api/admin/inference-endpoint` with `https://example.com`, `http://box.tailnet.ts.net`, `https://box.tailnet.ts.net:9999`, `https://user:pw@box.tailnet.ts.net`, `https://BOX.tailnet.ts.net`, `https://box.tailnet.ts.net/other`, an IP address, 2 049 characters | 400 each, the value never echoed |
| P8.2 | `https://box.tailnet.ts.net`, `https://box.tailnet.ts.net:443`, `:8443`, `:10000`, and `.../v1` | 200 each (set, then clear between tries) |
| P8.3 | With a sign-in older than 5 minutes | 403 `reauth_required` |
| P8.4 | As an associate or admin | 403, audited |
| P8.5 | `{"endpoint": null}` | 200; `GET` shows null. **Always finish here** |
| P8.6 | Body with an extra key | 400 |
| P8.7 | The audit for the run | `org.inference_endpoint_set` with `set` or `cleared` and **never the address** |

## P9. Auth endpoints and their limits

Remember each limit counts every request from one address, successful or not.

| # | Send | Expect |
|---|---|---|
| P9.1 | `POST /api/auth/sign-in/email` with a wrong password 11 times in 15 minutes | The 11th: 429 with an `X-Retry-After` header (the whole body is Better Auth's own, not the JSON error shape) |
| P9.2 | `POST /api/auth/sign-in/email` with a known and a made-up address, wrong passwords | The same 401 either way |
| P9.3 | `POST /api/auth/request-password-reset` 4 times in 15 minutes | The 4th is a 429 (3 per 15) |
| P9.4 | `POST /api/auth/reset-password` with a made-up token | The same refusal as an expired one; 5 per 15 |
| P9.5 | `POST /api/auth/change-password` with a wrong current password | Refused; 5 per 15 |
| P9.6 | `POST /api/auth/two-factor/verify-totp` with 5 wrong codes in a row (a sacrificed test account) | The challenge ends; **5 consecutive wrong codes lock that account's code step for 15 minutes** |
| P9.7 | `POST /api/auth/two-factor/verify-backup-code` with a spent code | Refused |
| P9.8 | `POST /api/auth/two-factor/generate-backup-codes` with a wrong password | Refused; the old codes still work |
| P9.9 | `GET /api/auth/verify-email` and `/api/auth/reset-password/{token}` with garbage | The same refusal for any bad value; rate limited (10 and 5 per 15) |
| P9.10 | After the run, read the auth audit | `auth.login_failed` only for known users; no passwords, tokens or codes anywhere |

## P10. Another practice (needs: MANUAL-TEST.md part E, Sam's go-ahead for a write to the shared `dev` database)

| # | As practice 2's owner | Send | Expect |
|---|---|---|---|
| P10.1 | | `GET /api/clients/{practice 1 id}`, `/api/reports/{id}`, `/api/reports/{id}/state`, the export, a section save, finalize, generate | 404 each, byte-for-byte equal to a made-up id |
| P10.2 | | `GET /api/clients`, `/api/reports`, `/api/admin/users`, `/api/admin/invitations`, `/api/admin/assignments` | Only practice 2's own rows |
| P10.3 | | `POST /api/admin/assignments` with a client or person from practice 1 | 404 |
| P10.4 | | `PATCH /api/admin/users/{practice 1 user id}` and reset-mfa | 404 |
| P10.5 | | Invite the address of a practice 1 person | The same 201 as a new address, no mail |
| P10.6 | | `POST /api/reports` with a practice 1 `clientId` or template | 404 |

## P11. Response hygiene (spot checks on every call above)

| # | Check | Expect |
|---|---|---|
| P11.1 | Look through all responses for `passwordHash`, `token`, `secret`, `organizationId`, another practice's names, an email you did not ask about | None |
| P11.2 | Look at every error body | `{error:{code, message}}` only; no stack trace, no SQL, no file path, no value echoed back |
| P11.3 | Look at the headers of one JSON page and one API response | The security headers are present; API responses are not cacheable |
| P11.4 | A 500 (if you can cause one) | A fixed generic body |

## P12. Runner rows (need a collection runner with no delay)

These cannot be done by hand: P4.7, P4.8, P5.3, P6.6, P7.14. Use Postman's collection runner (iterations, delay 0) or a small shell loop. Run them one at a time, note the clock minute for P5.3, and expect other limits to trip if you repeat too soon. The limits reset by themselves: wait the window out (a minute, 10 minutes or an hour) before repeating.

## Results

| Group | Pass / Fail / Skip | What happened (Fail only) |
|---|---|---|
| P1.1 to P1.15 | | |
| P2.1 to P2.7 | | |
| P3.1 to P3.15 | | |
| P4.1 to P4.9 | | |
| P5.1 to P5.4 | | |
| P6.1 to P6.10 | | |
| P7.1 to P7.17 | | |
| P8.1 to P8.7 | | |
| P9.1 to P9.10 | | |
| P10.1 to P10.6 | | |
| P11.1 to P11.4 | | |
