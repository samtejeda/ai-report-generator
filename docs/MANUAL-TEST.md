# MANUAL-TEST.md

A click-through of everything built so far, in a browser against the real app and the Neon `dev` database. Automated tests (CI) already cover each route one at a time, including cross-practice and role checks; this script covers what they cannot: whether the screens, the messages and the flows make sense to a person. Written 2026-10-28 from `API.md` and the code on `main`; every "Expect" below is what those say should happen, so a mismatch is a finding, not necessarily your mistake.

**Synthetic data only.** Invent every client name, date of birth and note. Nothing real goes into `dev`.

Mark each step Pass, Fail or Skip in the results table at the end. For a Fail, write what you did, what you saw and what you expected (no screenshots of anything with a secret in it). Hand the table to the supervising session; it checks the audit log from the database afterwards (there is no audit screen).

## What can and cannot be tested today

| Part | Needs | Status 2026-11-09 |
|---|---|---|
| A. Owner: sign-in, account, clients, reports, admin screens | The owner account (exists on `dev`, MFA on) | **Done 2026-10-28 to 2026-11-06** (results file). Left over: A1.6 (ticked trusted-device box), A3.4 and A4.5 (server limits, go to the Postman pass) |
| D. Edge cases and abuse | Same | D3 to D7 done. **D1 and D2 not run** (D1 can run now; D2 is a 2-hour wait). **D8 blocked** (Tailscale) |
| C1. Generate with no endpoint set; an endpoint the server must refuse | Same | **Done** |
| C2. Generate that succeeds, then edit and Finalize | Tailscale on this machine, `tailscale serve` in front of Ollama, the endpoint set on the practice | **Blocked: Tailscale is not installed here.** A report only becomes `generated` when generation succeeds, so Finalize (and the Finalize-with-unsaved-text check, #87) cannot be reached without it |
| B. Associate roles | An associate user | **Can run now, by hand:** invitations are merged (#84) and `0015` and `0016` are on `dev`; use the "Invite an associate by hand" steps. The invitation screens are merged (#90); use the screen steps in B (G below is the longer checklist for them) |
| B. Admin steps (B9 to B12) | An admin user | **Not run, on purpose.** Sam's decision (2026-11-09): only the owner and associate roles are in use; the admin role may not be needed. The steps stay in this file in case it comes back |
| F. Word export, by address (no button yet) | A report with some saved text | **Can run now** (#85 is merged); the draft case only, since a finalized report needs C2 |
| G. Invitation screens | Merged (#90, 2026-11-09) | **Can run now.** The builder's short click-through is in B ("Invite an associate by the screens"); G is the fuller list |
| H. Export button | Merged (#91, 2026-11-09) | **Can run now** (a report with some saved text; the draft case only until C2 works). Not yet clicked through in a browser; the builder's rows D9 to D12 and B18 cover the same ground in short form |
| E. A second practice cannot see the first | A second practice made by `bootstrap-owner.mjs` on `dev` | Optional; a database write on the shared `dev` database, so only with Sam's go-ahead (dry run first, host checked) |

Roles are still covered in CI at the route level (`authz.integration.test.ts`, 31 tests, and the admin and client suites), so part B is about the screens, not about whether access control holds.

**Everything not yet run, in one place (2026-11-09).** Browser: A1.6, D1, D2, C2.1 to C2.7, D8, Finalize with unsaved text (needs a `generated` report), the refused-save screen with two tabs (optional; the feature may be removed, decisions row 15), B1 to B8 and B13 to B17 (admin steps B9 to B12 skipped), E1 to E3, F1 to F10, G (can run now), H (after it merges). Server-side checks the browser cannot reach are in [POSTMAN-PASS.md](POSTMAN-PASS.md), none run yet.

## 0. Setup

1. Make sure the main checkout is on `main` and up to date: `git checkout main && git pull`. Sign-out leaves some pages in a stale state (results, finding 13): if a screen looks stuck after signing out or back in, refresh it.
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
| A1.3 | Sign in with the right password, in a **private window** | The code step appears (authenticator or backup code). In your everyday window a 14-day trusted-device cookie may skip it |
| A1.4 | Enter a wrong code, then the right one | Wrong is refused; right signs you in |
| A1.5 | Sign out from `/account`, sign in again using a backup code instead | Works once; that code is spent (try it a second time later: refused). You may have fewer than 10 codes left, and there is no screen to renew them yet |
| A1.6 | Sign in again with "Trust this device for 14 days" ticked | Next sign-in skips the code step but still asks for the password |
| A1.7 | `/forgot-password` with your address, then with a made-up address | Same message in the browser both times; the terminal prints a reset link only for the real one (a "user not found" warning in the terminal for the made-up one is the server's own log, not shown to the browser) |
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
| A4.2 | Type text in one section and save | Saved as version 1; the history lists it as a person's edit (today it shows the raw `human_edit` and no author; see the results) |
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
| D1 | Sign in with a wrong password eleven times in 15 minutes | A "too many attempts" response on the eleventh (the limit is 10 per 15 minutes per address, raised from 5 on 2026-10-30); it clears after the window |
| D2 | Leave a session idle for over 2 hours, then click | Sent to sign in again (idle limit 2 hours; absolute limit 12 hours) |
| D3 | Open `/admin/users` and any page while signed out | Sent to `/login` |
| D4 | Paste a client or report address from the first browser into a signed-out one | Sent to `/login`, then nothing about the client is shown |
| D5 | In the address bar, open `/api/clients`, `/api/me`, `/api/admin/users` while signed in | JSON for yourself only; no password hashes or other practices' data anywhere in it |
| D6 | Open `/api/health` signed out | `{"status":"ok"}` and nothing else |
| D7 | Look at your own row on `/admin/users` | No buttons at all (you cannot change, deactivate or reset yourself) |
| D8 | Start four Generate requests across two reports quickly (with a working endpoint) | At most 2 run at once; the rest get the "try again in N seconds" message |
| D9 | Open a draft report (any status except finalized) and press **Download Word file** | A new tab opens briefly and the browser saves `report-<report id>.docx` (no client name in the file name); the report tab is unchanged. The note under the button says the file starts with a line that says DRAFT, not finalized. Open the file: that line is its first line and in every page header |
| D10 | Save a section, then download again | The file holds the saved text. A finalized report shows no DRAFT note and the file has no DRAFT line |
| D11 | Type in a section without saving, then press **Download Word file** | A popup lists the unsaved sections in red and says the unsaved text will not be in the file. Focus is on **Go back and save**; Esc does the same and puts the cursor in the first unsaved box; no download starts. Press the button again and choose **Download anyway**: the file downloads and what you typed is still in the box. Check at phone width (375px) and with the keyboard only |
| D12 | Press **Download Word file** 21 times within 10 minutes | The 21st opens a tab with the server's fixed 'Too many requests' sentence (no wait time); the report tab is untouched. The hint under the button names the limit |

## B. Associate and admin

An associate can now be created by invitation, from the owner screen `/admin/invitations` and the public `/accept-invitation` page (see the screen steps below; the console steps after them still work). The admin role is not in use (Sam, 2026-11-09: only owner and associate), so skip B9 to B12 and the "to admin" half of B13. Sign in as each person in a separate browser profile.

**Invite an associate by the screens** (needs the migrations `0015` and `0016` applied to `dev`; synthetic address only; nothing is sent by email, the link is printed in the dev server terminal):

1. Sign in as the owner (a sign-in from the last 5 minutes is needed to invite: if the screen says so, sign out and in again). Open Practice, then "Invite an associate". Enter `associate-test@example.com` and press "Invite an associate". Expect the sentence "Invitation created. If the address can receive it…" and the invitation in the list as Pending with Resend and Revoke. Inviting an address that already has an account shows the same sentence.
2. In the terminal running `npm run dev`, find the line starting `[dev email] to=associate-test@example.com` and copy the whole link (`/accept-invitation?token=…`).
3. Open the link in a separate browser profile (signed out). The address bar changes to `/accept-invitation` at once. Enter a name, a password of 12 or more characters twice (try the Show password buttons) and press "Create account". Expect a move to the sign-in page with "Your account is ready. Sign in now…". Try a short password first: expect a message and the form kept. Reload the accept page after the address bar changed: expect "This invitation link is not valid."
4. Sign in as the new person; you are sent to set up an authenticator app. Then see no clients. As the owner, assign one (Practice, Client assignments); the new person now sees it.
5. As the owner, the invitation is now Accepted and has no buttons. Invite another address, press Revoke (confirm), then open its link: expect the same "not valid" sentence as any bad link.

**Invite an associate by hand** (needs the migrations `0015` and `0016` applied to `dev`, which is Sam's go-ahead; synthetic address only, for example `associate-test@example.com`; nothing is sent, the link is printed in the dev server terminal):

1. Sign in as the owner (sign in again if the last sign-in was more than 5 minutes ago; creating an invitation needs that).
2. On any page of the app, open the browser console and run `await (await fetch('/api/admin/invitations', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'associate-test@example.com'})})).json()`. Expect `{data: {id, email, role: "associate", status: "pending", expiresAt}}`.
3. In the terminal running `npm run dev`, find the line starting `[dev email] to=associate-test@example.com` and copy the token after `token=` (43 characters).
4. In a separate browser profile (or signed out), open any page of the app and run `await (await fetch('/api/invitations/accept', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token: '<the token>', name: 'Test Associate', password: '<a password of 12 or more characters>'})})).json()`. Expect `{data: {status: "accepted"}}` and no sign-in. Run it again: expect `{error: {code: "invalid_invitation", ...}}` (a link works once).
5. Sign in as the new person on `/login`: you are sent to set up an authenticator app, as everyone is. Then continue with B1.
6. Back as the owner, `await (await fetch('/api/admin/invitations')).json()` shows the invitation as `accepted`.

Also worth trying: invite an address that already has an account (for example your own owner address): you get the same answer as for a new address, no mail line appears in the terminal, and the address is not revealed.

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
| B18 | Admin | Open a report on the granted client | No **Download Word file** link (opening `/api/reports/<id>/export?format=docx` directly is refused with 403); the associate on that client sees the link and a person who cannot see the report gets the 404 page |
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

## F. Word export, by address (can run now; the button comes later, see H)

The route is merged (#85) but no screen calls it yet. Open a report page, copy its id from the address (`/reports/<id>`), then open `/api/reports/<id>/export?format=docx` in the address bar while signed in. Use a **draft** report with saved text in at least two sections and one section left empty. Open the file in Word or Pages. (A finalized report needs C2, so F10 waits.)

| # | Do | Expect |
|---|---|---|
| F1 | Open the export address for the draft report | The browser saves `report-<id>.docx`; nothing about the client is in the file name |
| F2 | Open the file | First line says `DRAFT, not finalized`, and every page header says it too |
| F3 | Read the body | Each section's title, in order, with its **current** saved text; the empty section shows `[Not yet written]` |
| F4 | Look for names | No client name, practice name, email or author anywhere in the text or in File > Properties; anything found is a finding |
| F5 | Edit a section and save, then export again | The new text is in the file |
| F6 | Type in a section and **do not save**, then export | The unsaved text is **not** in the file (this is why the button will warn first, H3) |
| F7 | Save a section containing `<b>bold</b> & "quotes"` and a line break, then export | The characters appear literally, nothing is bold, nothing breaks |
| F8 | Change the address to `format=pdf`, then remove `format`, then add `&x=1` | Each shows a JSON error (validation failed), no file |
| F9 | Open the export address while signed out | Sent to `/login`; no file |
| F10 | Export a **finalized** report | No `DRAFT` line, no header (blocked until C2) |
| F11 | As an admin (even with a grant on that client): open the export address | Refused (403); the owner's audit shows `authz.denied`. **Skipped: the admin role is not in use** |
| F12 | As an associate not assigned to that client | The same 404 as a made-up report (needs B) |

The 21st export in 10 minutes is a 429 (limit 20 per person); that is in [POSTMAN-PASS.md](POSTMAN-PASS.md) because it takes a script.

## G. Invitation screens (merged in #90, 2026-11-09)

The builder's short click-through is in part B, "Invite an associate by the screens". This is the fuller checklist for the same screens, from the request:

| # | Do | Expect |
|---|---|---|
| G1 | Owner opens the invitations screen | "Invite an associate" (email only) and a list with a status for each invitation (pending, accepted, expired, revoked) |
| G2 | Associate and admin try the same address | The 404 page |
| G3 | Invite a new address, then invite your own owner address | The same success message both times; the second prints no mail line in the dev terminal |
| G4 | Copy the link from the dev terminal, open it in another browser profile | The page asks for a name and a password twice (show/hide works); the token is gone from the address bar |
| G5 | Open the same link again after accepting, and a link with a letter changed | One and the same generic error each time |
| G6 | Short password, passwords that do not match | Plain refusals; nothing is created |
| G7 | After accepting: sign in as the new person | Sent to authenticator setup; after it, no clients (B1) |
| G8 | Owner assigns one client to them (B4) | They see it on their next click |
| G9 | Resend an invitation, then try the old link | The old link fails; the new one works |
| G10 | Revoke a pending invitation, then try its link | The link fails; the list says revoked |
| G11 | Wait over 5 minutes after signing in, then invite | A "sign in again" message, not a raw error |
| G12 | Use the page at 375 px wide and with the keyboard only | Everything reachable; nothing cut off |
| G13 | After accepting, press Back | The token and password are not shown again |

Sending real mail is not built (Resend, decisions row 8): the link only appears in the dev terminal until it is.

## H. Export button (merged #91, 2026-11-09; not yet clicked through in a browser)

| # | Do | Expect |
|---|---|---|
| H1 | Open a report as the owner and as an assigned associate | The "Download Word file" button is there |
| H2 | Open a report as an admin | No button. **Skipped: the admin role is not in use** |
| H3 | Type in a section, do not save, press the button | A red list names the unsaved sections and says their text will not be in the file; "Go back and save" is the default (Esc and the focused button); "Download anyway" is the second choice and does download |
| H4 | Read near the button | A plain sentence that a report not finalized downloads with a "DRAFT, not finalized" line |
| H5 | Press the button 21 times in 10 minutes | A short wait message, no raw error |
| H6 | Use the button at 375 px and with the keyboard only | Reachable and readable |

## Results

First run (owner only, 2026-10-28 to 2026-10-30): see [MANUAL-TEST-RESULTS-2026-10-28.md](MANUAL-TEST-RESULTS-2026-10-28.md). The table below is for the next run; fill it in then.

| Step | Pass / Fail / Skip | What happened (Fail only) |
|---|---|---|
| A1.1 to A1.8 | | |
| A2.1 to A2.3 | | |
| A3.1 to A3.6 | | |
| A4.1 to A4.6 | | |
| A5.1 to A5.5 | | |
| C1.1 to C1.5 | | |
| C2.1 to C2.7 | | |
| D1 to D12 | | |
| B1 to B18 | | |
| E1 to E3 | | |
| F1 to F12 | | |
| G1 to G13 | | |
| H1 to H6 | | |

After the run, hand this table to the supervising session. It reads the audit log from the database (read-only) and checks that each action above left the expected `client.*`, `report.*`, `auth.*` and `authz.denied` rows, and none of them contains client text.
