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
