# MANUAL-TEST.md

A click-through of everything built so far, in a browser against the real app and the Neon `dev` database. Automated tests (CI) already cover each route one at a time, including cross-practice and role checks; this script covers what they cannot: whether the screens, the messages and the flows make sense to a person. Written 2026-10-28 from `API.md` and the code on `main`; every "Expect" below is what those say should happen, so a mismatch is a finding, not necessarily your mistake.

**Synthetic data only.** Invent every client name, date of birth and note. Nothing real goes into `dev`.

Mark each step Pass, Fail or Skip in the results table at the end. For a Fail, write what you did, what you saw and what you expected (no screenshots of anything with a secret in it). Hand the table to the supervising session; it checks the audit log from the database afterwards (there is no audit screen).

## What can and cannot be tested today

| Part | Needs | Status 2026-10-28 |
|---|---|---|
| A. Owner: sign-in, account, clients, reports, admin screens | The owner account (exists on `dev`, MFA on) | **Can run now** |
| D. Edge cases and abuse | Same | **Can run now** |
| C1. Generate with no endpoint set; an endpoint the server must refuse | Same | **Can run now** |
| C2. Generate that succeeds, then edit and Finalize | Tailscale on this machine, `tailscale serve` in front of Ollama, the endpoint set on the practice | **Blocked: Tailscale is not installed here.** A report only becomes `generated` when generation succeeds, so Finalize cannot be reached without it |
| B. Associate and admin roles in the screens | An associate and an admin user | **Blocked: nothing in the app or its scripts can create them.** `scripts/bootstrap-owner.mjs` makes a practice and its owner only; invitations are not built (`PROGRESS.md`, Next up item 1) |
| E. A second practice cannot see the first | A second practice made by `bootstrap-owner.mjs` on `dev` | Optional; a database write on the shared `dev` database, so only with Sam's go-ahead (dry run first, host checked) |

Roles are still covered in CI at the route level (`authz.integration.test.ts`, 31 tests, and the admin and client suites), so part B is about the screens, not about whether access control holds.

## 0. Setup

1. Make sure the main checkout is on `main` and up to date: `git checkout main && git pull`.
2. Start the app from the main checkout: `npm run dev`. If Next asks about "Claude Code detected", choose Skip. Do not use the `-auth` worktree's server (old code). Open `http://localhost:3000`.
3. Keep that terminal visible. Development email is printed there (verification, password reset, "password changed", "two-step sign-in was turned on").
4. Have your authenticator app and the owner's backup codes ready. You need a second browser profile or a private window for the multi-session steps.
5. Ollama is running with `qwen3:1.7b` on this machine already (checked 2026-10-28). The laptop has 8 GB: close other heavy apps before Part C.

## A. Owner

**A1. Public pages and sign-in**

| # | Do | Expect |
|---|---|---|
| A1.1 | Open `/` and `/clients` while signed out | Sent to `/login`; no client data visible |
| A1.2 | Sign in with a wrong password | A generic failure; the same message you would get for an unknown address |
| A1.3 | Sign in with the right password | The code step appears (authenticator or backup code) |
| A1.4 | Enter a wrong code, then the right one | Wrong is refused; right signs you in |
| A1.5 | Sign out from `/account`, sign in again using a backup code instead | Works once; that code is spent (try it a second time later: refused) |
| A1.6 | Sign in again with "Trust this device for 14 days" ticked | Next sign-in skips the code step but still asks for the password |
| A1.7 | `/forgot-password` with your address, then with a made-up address | Same message both times; the terminal prints a reset link only for the real one |
| A1.8 | Use the printed link, set a new password of at least 12 characters, then sign in | Old password refused, new one works; all other sessions ended; "password changed" email printed |

**A2. Account**

| # | Do | Expect |
|---|---|---|
| A2.1 | `/account` | Shows your role (owner) and the change-password form |
| A2.2 | Change password with the wrong current password | Refused |
| A2.3 | Change it correctly with "sign out my other sessions" ticked | Succeeds; a second browser profile signed in earlier is signed out on its next click |

**A3. Clients**

| # | Do | Expect |
|---|---|---|
| A3.1 | `/clients` | Empty list (0 clients on `dev` at the last check) and a "New client" link |
| A3.2 | New client with only a name | Created; appears in the list |
| A3.3 | New client with name, date of birth, grade level and external ID | Created with all four fields |
| A3.4 | Submit the form with an empty name, and with a 300-character name | Refused with a clear message, nothing created |
| A3.5 | Open a client, edit a field, save; clear an optional field | Saved; the cleared field is empty |
| A3.6 | Try an address like `/clients/not-an-id` and a made-up valid-looking id | The 404 page for both |

**A4. Reports (before generation)**

| # | Do | Expect |
|---|---|---|
| A4.1 | On a client page, "New report" | A draft report with one empty box per template section |
| A4.2 | Type text in one section and save | Saved as version 1; the history lists it as a person's edit |
| A4.3 | Edit and save the same section again | A new version; the older one stays in the history |
| A4.4 | Open the same report in the second browser profile, save there, then save in the first | The first save is refused as out of date (someone saved first) and tells you so; no text is lost silently |
| A4.5 | A section with 20 001 characters | Refused |
| A4.6 | Empty section: is a "Generate test text" button shown? | Yes on each empty prose section; disabled while that box holds unsaved text |

**A5. Admin screens (owner only)**

| # | Do | Expect |
|---|---|---|
| A5.1 | `/admin` | An index of three screens: users, assignments, inference endpoint |
| A5.2 | `/admin/users` | One person (you), deactivated people would be listed too; no buttons for yourself |
| A5.3 | `/admin/assignments` | Empty; the Assign form offers no one yet (no associates or admins exist) |
| A5.4 | `/admin/inference-endpoint` | Shows "not set" and a form |
| A5.5 | Soft-delete the client with no reports (owner's delete button) | Disappears from the list; its page now shows the 404 page |

## C1. Generation without a model (works now)

| # | Do | Expect |
|---|---|---|
| C1.1 | On an empty section of a draft report, press "Generate test text" with no endpoint set | A fixed message that no inference endpoint is set up; the report stays `draft`; nothing was sent anywhere |
| C1.2 | `/admin/inference-endpoint`: enter a made-up address that is not a `*.ts.net` address, for example an `https://example.com` address | Refused by the server |
| C1.3 | Enter a plain `http://` Tailscale-looking address | Refused |
| C1.4 | (Needs a sign-in from the last 5 minutes; if refused, sign in again) Enter `https://test-box.tailnet-name.ts.net` (a well-formed Tailscale-shaped address that does not exist), save; then press Generate on an empty section | The request fails (the server cannot reach the address); the report moves to `error` and the page shows its fixed error note; **no fallback to any other model**; the Generate button is offered again |
| C1.5 | **Clear the endpoint again** on `/admin/inference-endpoint` | Shows "not set". Do not leave a fake endpoint on the practice |

## C2. Generate, edit, Finalize (blocked until Tailscale is set up)

When Tailscale is installed and `tailscale serve` exposes Ollama as an `https://<machine>.<tailnet>.ts.net` address (tailnet only, **not** Funnel; Funnel is public and is stop-and-ask), set that address as the endpoint and run:

| # | Do | Expect |
|---|---|---|
| C2.1 | Generate on an empty section | The section fills with the test model's placeholder text, marked as the test model's; the report becomes `generated` |
| C2.2 | Try Generate on the same section again, and on another empty section | The button is not offered (a generated report cannot generate again until regenerate-section is built) |
| C2.3 | Edit the generated text and save | New version; the "test model's text" marker goes away |
| C2.4 | Check the history of that section | Shows the generated version first, then your edit |
| C2.5 | Press Finalize | The report becomes `finalized`; every box is read only; there is no way back |
| C2.6 | Try to save a section on the finalized report (second browser, old page) | Refused |
| C2.7 | Finalize a report whose text is still the test model's | It **lets you** (known gap, `PROGRESS.md` decisions table row 1); decide whether that is acceptable before real data |

## D. Edge cases and abuse

| # | Do | Expect |
|---|---|---|
| D1 | Sign in with a wrong password six times in 15 minutes | A "too many attempts" response after the fifth; it clears after the window |
| D2 | Leave a session idle for over 2 hours, then click | Sent to sign in again (idle limit 2 hours; absolute limit 12 hours) |
| D3 | Open `/admin/users` and any page while signed out | Sent to `/login` |
| D4 | Paste a client or report address from the first browser into a signed-out one | Sent to `/login`, then nothing about the client is shown |
| D5 | In the address bar, open `/api/clients`, `/api/me`, `/api/admin/users` while signed in | JSON for yourself only; no password hashes or other practices' data anywhere in it |
| D6 | Open `/api/health` signed out | `{"status":"ok"}` and nothing else |
| D7 | Look at your own row on `/admin/users` | No buttons at all (you cannot change, deactivate or reset yourself) |
| D8 | Start four Generate requests across two reports quickly (with a working endpoint) | At most 2 run at once; the rest get the "try again in N seconds" message |

## B. Associate and admin (blocked until they can be created)

Run these when the invitation feature, or any other approved way to make an associate and an admin on `dev`, exists. Sign in as each in a separate browser profile.

| # | As | Do | Expect |
|---|---|---|---|
| B1 | Associate | `/clients` before any assignment | Empty list |
| B2 | Associate | Create a client | Created and visible at once (auto-assigned to them) |
| B3 | Owner | Create another client | Associate does not see it; typing its address gives the 404 page |
| B4 | Owner | `/admin/assignments`: assign that client to the associate | Associate sees it on their next click |
| B5 | Owner | End the assignment | Associate loses it on their next click |
| B6 | Associate | Open `/admin` and `/admin/users` | The 404 page for both |
| B7 | Associate | Edit an assigned client; try to delete it | Edit works; no delete button, and a direct delete request is refused |
| B8 | Associate | New report, generate, edit, finalize on an assigned client | Same as the owner's flow (needs C2 to go further than editing) |
| B9 | Admin | `/clients` before any grant | Empty list |
| B10 | Owner | Assign (grant) one client to the admin | Admin sees exactly that client, read only: no "New client", no edit form, no "New report", no Generate, no Finalize |
| B11 | Admin | Open a report on the granted client | Text readable, nothing editable |
| B12 | Admin | `/admin` | The 404 page (the screens are owner only; the user list is available to an admin through the API only) |
| B13 | Owner | `/admin/users`: change the associate's role to admin, then back | Allowed; the assignments they held stay with them |
| B14 | Owner | Deactivate the associate | Their next click sends them to sign in; the address stays reserved |
| B15 | Owner | Reactivate them | They can sign in again with the same password and authenticator |
| B16 | Owner | Reset the associate's authenticator (needs a sign-in from the last 5 minutes) | They are asked to enroll a new phone at their next sign-in |
| B17 | Owner | Try to deactivate or change your own role | No button |

## E. Second practice (optional, needs Sam's go-ahead)

Create a second practice with `scripts/bootstrap-owner.mjs` (dry run first, check the host it prints, then `--apply`). Sign in as that owner in another profile.

| # | Do | Expect |
|---|---|---|
| E1 | `/clients` and `/admin/users` | Empty, and only that practice's own people |
| E2 | Paste a client or report address from practice 1 | The 404 page |
| E3 | Call `/api/clients/<practice 1 id>` and `/api/reports/<practice 1 id>` | 404, identical to a missing id |

## Results

| Step | Pass / Fail / Skip | What happened (Fail only) |
|---|---|---|
| A1.1 to A1.8 | | |
| A2.1 to A2.3 | | |
| A3.1 to A3.6 | | |
| A4.1 to A4.6 | | |
| A5.1 to A5.5 | | |
| C1.1 to C1.5 | | |
| C2.1 to C2.7 | | |
| D1 to D8 | | |
| B1 to B17 | | |
| E1 to E3 | | |

After the run, hand this table to the supervising session. It reads the audit log from the database (read-only) and checks that each action above left the expected `client.*`, `report.*`, `auth.*` and `authz.denied` rows, and none of them contains client text.
