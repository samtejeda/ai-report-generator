# Manual test results, 2026-10-28 to 2026-10-30

First click-through of `docs/MANUAL-TEST.md`: owner role only, in Chrome, against the Neon `dev` database and `npm run dev` from the main checkout (app code at `main`). Sam did every step on screen and reported what he saw; the supervising session checked the audit log from the database (read-only) after each group. Synthetic data only. Design was out of scope (the plain UI is deliberate until a design is chosen).

Rebuilt from the session transcript on 2026-10-30 after the working log was lost; findings keep their original numbers except the stale sign-out button, which is **FINDING-13** (it was called FINDING-8 in chat; FINDING-8 is the audit address one).

## Result by step

| Step | Result | Notes |
|---|---|---|
| A1.1, A1.2 | Pass | |
| A1.3, A1.4 | Pass | The first attempt skipped the code step: the browser held a 14-day trusted-device cookie. A private window showed the code step. Wrong code refused, right code signed in; with the trust box unticked no trusted-device row was written. |
| A1.5 | Pass | Backup-code sign-in works and the code is spent (audit: two refused attempts, then `auth.login` with `password+backup_code` and `auth.mfa_backup_code_used`). |
| A1.6 | Partial | A trusted-device sign-in skipped the code and still asked for the password. The ticked-box path itself was not re-run. |
| A1.7 | Pass | The browser shows the same message for a real and a made-up address. The "user not found" Sam saw is a server-side warning that Better Auth writes to the dev terminal, never sent to the browser. A reset request for the real address wrote `auth.password_reset_requested`; the made-up one left no row. |
| A1.8 | Pass | Old password refused (`login_failed`), new one works, trusted devices revoked (code asked again), "password changed" email printed in the dev terminal. |
| A2.1 to A2.3 | Pass | Wrong current password refused. The private-window session was signed out on its next click. |
| A3.1 to A3.3, A3.5, A3.6 | Pass | |
| A3.4 | Partial | Empty name refused. The 300-character name did not exercise the server: the browser cut it to 200 (`maxLength`). Server limit goes to the Postman pass. |
| A4.1 to A4.4, A4.6 | Pass | 6 sections. A stale save was refused and the typed text stayed in the box. |
| A4.5 | Deferred | The browser caps the box at 20 000 characters; the server limit goes to the Postman pass. |
| A5.1 to A5.5 | Pass | |
| C1.1 to C1.5 | Pass | Verified in the audit log: endpoint set, two generation attempts that failed in about a second each with reason `unreachable`, no fallback of any kind, endpoint cleared. The practice has no endpoint set now. |
| D3 to D7 | Pass | |
| D1, D2 | Not run | D1 (sign-in limit) waits for the raised limit; D2 (2-hour idle) is a wait. |
| D8, C2 | Blocked | Need Tailscale and a working endpoint. |
| B, E | Blocked / optional | B needs an associate and an admin (no way to create them yet). E needs Sam's go-ahead. |

## Findings (open)

Kind: **bug** = the screen does the wrong thing; **gap** = missing; **decision** = Sam chooses. None blocks Phase B.

| # | Kind | Finding | Proposed fix |
|---|---|---|---|
| 1 | bug, low-medium | The sign-in code field showed the saved password as a grey preview. The code form holds no password; Chrome's password manager filled a plain text field. | A distinct field name and the `data-1p-ignore` / `data-lpignore` hints on the code input. |
| 2 | bug | After Sign out the login page showed the old code step (code still typed, button stuck on "Checking…"). Next 16 with Cache Components keeps a page you leave alive and hidden (React `Activity`) and restores its state. | See 13. |
| 3 | decision, done | The sign-in limit was 5 per 15 minutes per address, counting successful sign-ins. Sam decided on 2026-10-28: raise it (10 per 15 minutes per address recommended), no failures-only counting, show the wait time. Per-account counting is not wanted (it would confirm which accounts exist). | Auth change. |
| 4 | gap | No screen to regenerate backup codes (API only: `POST /api/auth/two-factor/generate-backup-codes`). The remaining count is unknown (stored encrypted). | Account screen. |
| 5 | frontend | Show/hide password eye on the password fields (approved). | Frontend. |
| 6 | bug | After creating a client, `/clients/new` still showed the previous values (same cause as 2: restored hidden page). All forms need the same check (edit client, change password, new report). | See 13. |
| 7 | open | Sign-in feels like 1 to 2 seconds. Measured: password check about 54 ms; one Neon round trip 795 ms cold, about 40 ms warm; several sequential calls plus first-hit compilation in dev. A terminal timing line for the sign-in request is still wanted. | Measure in the dev terminal; re-measure deployed. **Measured 2026-10-30:** 43 sequential statements at about 37 ms each is about 2 s; no safe small fix; see PROGRESS Done 2026-10-30. |
| 8 | question | `auth.login` audit rows store the address as `0000:…:0000` while other auth rows store `::1`. Probably the masked address used for rate limiting leaking into the audit row. | Auth: confirm intent, fix or document. **Answered and fixed 2026-10-30:** yes, the /64 mask from Better Auth's session row; audit rows now carry the address as received. |
| 9 | docs | The `MANUAL-TEST.md` corrections below; `.github/workflows/ci.yml` line 9 still calls the `integration` job "advisory". | Corrections made in this PR; the `ci.yml` comment goes into the next workflow PR. |
| 10 | gap | The version history shows the raw `human_edit` and no author, although `created_by_user_id` is stored per version. The versions API returns no author. | "Edited by <name> · <date>" / "Test model text": backend returns the author's display name, frontend shows it. |
| 11 | gap | `/login` (and probably `/forgot-password`, `/reset-password`) show their forms to a person who is already signed in. Sessions are database sessions (a cookie), still valid. | Redirect a signed-in person to the working home. |
| 12 | gap | `/` is the scaffold placeholder. | Signed in goes to `/clients`, signed out to `/login`; decide the working home and the post-login destination (now `/account`). |
| 13 | bug | A pending "Signing out…" state survives: the endpoint form and the reset-authenticator button show a stuck "Signing out…" after a re-sign-in, and the login page shows a stale code step. One cause (the hidden page is restored with its state). | Sign-out does a full page load of `/login` (`window.location.assign`) instead of an in-app navigation, which drops every preserved page; or key client components with `bfcacheId`. Covers 2, 6 (partly), and 13. |
| 14 | decision | A save on a section someone else changed is refused (nothing is overwritten, and the typed text stays in the box), but the person learns it only on pressing Save, and the message says "Reload the page", which discards what they typed unless they copied it first. | See "Concurrent edits" below. |

## Concurrent edits (decision for Sam)

What happens today is optimistic concurrency: a save carries the version the text was loaded from; the server refuses it with 409 if the section moved on; versions are insert-only, so no saved version is ever lost. The gap is the person's own unsaved text and the late warning. Options, smallest first:

1. **On refusal, show the newer text next to the person's own** and let them keep theirs as the next version, take the newer one, or copy. Nothing is typed again. This fixes the loss.
2. **Warn before it happens:** when the window regains focus and every minute or so while a section is being edited, check the section's current version and, if it moved, show a banner ("changed by <name> at <time>; your text is not saved over it"). Cheap (one small read), no new tables.
3. **Soft "is being edited" notice** (presence). Needs stored state and cleanup; not worth it for a practice of a few people.
4. Real-time shared editing. Out of scope.

Recommendation: 1 and 2 together.

## Ideas that came up (new scope, not decided)

- Return the person to the page they wanted after sign-in (needs a safe same-origin allow-list; the proxy deliberately sends no `?next=`).
- Districts as a customer type, self-hosting the whole app, a platform-level screen to create practices (today only `scripts/bootstrap-owner.mjs` does).
- Admin screens for the admin role, or dropping the role.

## Postman pass (to do)

Server-side checks the browser cannot reach: a 201-character client name (A3.4) and a section of 20 001 characters (A4.5); every role check through the API; the same flows as above. Cautions: sign-in needs the code step, state-changing calls need the app's own `Origin` header, and the sign-in limit applies.
