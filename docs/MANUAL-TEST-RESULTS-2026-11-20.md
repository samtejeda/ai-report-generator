# Manual test results, 2026-11-20

Second click-through run, recorded live by the supervising session as Sam reports each block. Synthetic data only. Compare with [MANUAL-TEST-RESULTS-2026-10-28.md](MANUAL-TEST-RESULTS-2026-10-28.md) (owner steps, first run).

Environment: main checkout at `1530f20` (after #111), Next 16.4.6, `INFERENCE_MODE=stub`, Neon `dev`, no inference endpoint set.

## Findings during setup

- **S1 (not a code bug, a process gap).** After pulling `main`, the dev server showed "Next.js 16.4.2 is affected by a known security vulnerability": `node_modules` was stale (`package.json` pinned 16.4.6 since #107). Fix: `npm install`. Check after pulling: run `npm install` before `npm run dev`.
- **S2 (process gap, needs a plan).** The client page failed with `Failed query ... "status_before_generation"`: migration 0017 was not applied to the `dev` database although the code needing it was merged (#102, #108). Fix: `npm run db:migrate` against `dev` (owner credential, host checked). Production consequence: nothing today enforces "migrate first, deploy second". Follow-up: platform-ops plan for an enforced migrate-before-deploy step (open).

## Results

| Step | Result | Notes |
|---|---|---|
| I1 | Pass | Generate test text on each empty section, test-model note, no notes box |
| I2 | Pass | "Not set up yet" sentence, report stays draft |
| H1 (owner), H3, H4 | Pass | Button present; unsaved warning with Go back and save default; DRAFT sentence |
| F1 to F9 | Pass | File name, DRAFT line and header, text and `[Not yet written]`, no names or properties, edit shows, unsaved text absent, literal characters, bad `format` is a JSON error, signed out goes to `/login` |
| G5 | Pass (behaviour), UX finding U1 | A used link and a revoked link both show the name and password form (the page never looks the token up), and submitting gives "not valid" and creates nothing. Sam expected the page itself to refuse |
| G10 | Pass (behaviour), UX finding U1 | Same as G5 for a revoked invitation (revoke worked after a fresh sign-in) |
| G11 | Observed, finding U2 | Invite and revoke refused with a vague "sign-in more than a few minutes old" message (the rule is 5 minutes from sign-in, by design). Message rewritten in #113 |
| G1, G3, G4, G6, G7, G9, G13 | Pass | Invitation screens, same answer for an existing address, accept form, refusals keep the form, Back shows no token, new associate reaches authenticator setup, resend kills the old link |
| B1 to B8, B13 to B17, I3, F12, H1 (associate half), G8 | Skipped by decision | Sam, 2026-11-21: the owner is what matters most; associate click-through skipped. The role stays in the product as built and is still covered at route level in CI (`authz`, `admin`, `clients` suites). Revisit before a second person is invited for real |
| D1, D3 to D7 | Pass | Eleventh wrong password is limited; signed-out pages and pasted addresses go to `/login`; API JSON shows own practice only; `/api/health` is `{"status":"ok"}`; own row on `/admin/users` has no buttons |
| M1 (login, 375 px), M5 (accept page, 375 px), K4 (wrong password keeps the form) | Pass | Driven by the supervising session through the Chrome DevTools MCP in an isolated browser context, signed out, 375x812 mobile emulation: no horizontal overflow on either page (scrollWidth 375), all controls on screen; wrong password for a made-up address (`nobody-test@example.com`) shows "Email or password is incorrect." in a live alert, email and password kept; every control on the accept page takes a visible focus ring. Screenshots looked at by the supervising session, not stored. A made-up address was used so the owner's sign-in limit was not touched |

## UX findings

- **U1.** `/accept-invitation` shows the form for any well-formed token, even a used or revoked one; the refusal comes only on submit. Works as designed, confusing for the person. Option: the page checks the token (read-only) and says "not valid" up front; tokens are 256-bit so the enumeration worry is negligible. Not a small fix (public page plus database lookup): plan first. Decision with Sam.
- **U2.** The re-sign-in message was vague. Fixed in #113 (open). Sam also finds the 5-minute rule strict; recommendation: keep, lengthen to 30 minutes; decision with Sam.
