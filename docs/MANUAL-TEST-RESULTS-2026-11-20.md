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
| G1, G3, G4, G6, G7, G9, G13 | Not yet reported | Waiting for Sam |

## UX findings

- **U1.** `/accept-invitation` shows the form for any well-formed token, even a used or revoked one; the refusal comes only on submit. Works as designed, confusing for the person. Option: the page checks the token (read-only) and says "not valid" up front; tokens are 256-bit so the enumeration worry is negligible. Not a small fix (public page plus database lookup): plan first. Decision with Sam.
- **U2.** The re-sign-in message was vague. Fixed in #113 (open). Sam also finds the 5-minute rule strict; recommendation: keep, lengthen to 30 minutes; decision with Sam.
