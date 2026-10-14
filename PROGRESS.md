# PROGRESS.md

Source of truth for project state. Update after every commit or milestone. Conventions: resolved items get a date and ~~strikethrough~~, never deletion. Don't rewrite historical snapshots; add a "Superseded <date>" pointer. Anything unverified is marked **unverified**. Audit scores are honest: partial is not pass, unverified is not pass.

## Done

- 2026-10-12: `feat/inference-stub`: `lib/ai/models.ts` (model role constants + `resolveModel` with per-organization overrides) and `lib/ai/inference.ts` (`runInference`, stub mode over Ollama's OpenAI-compatible API via Vercel AI SDK `ai@7.0.138` + `@ai-sdk/openai-compatible@3.0.68`; real mode throws `not_implemented`). 21 new unit tests with a mocked transport (25 total pass; lint and typecheck clean). Manual run against local Ollama `qwen3:1.7b`: replied "ready" in about 4.9 s (cold), 23 in / 2 out tokens; a dead port returned the `unreachable` error. No DB writes, routes, or UI.
- 2026-10-08: Repo initialized (`git init`) on `chore/workflow-scaffold`; baseline `CLAUDE.md` committed.
- 2026-10-13 (Claude, with Sam's go-ahead): applied migrations `0001`-`0003` to Neon `dev` (verified: 4 migrations recorded, 14 public tables, `purge_client()` and `app_runtime` present, 3 triggers on `audit_log`, 0 data rows). Created SQL login role `app_runtime_login` (member of `app_runtime`) with a generated 48-hex password written only to the gitignored `.env.local`; `DATABASE_URL` (pooled) now uses it, `DATABASE_URL_UNPOOLED` stays on the owner for drizzle-kit. Verified on the pooled connection as that role: SELECT and `select 1` succeed; DELETE on `report_versions` and `clients`, UPDATE on `audit_log`, TRUNCATE on `methodology_prompts`, DROP TABLE and CREATE TABLE are all refused (42501); `/api/health` returns ok under it. Not yet true for other copies of `.env.local` (agent worktrees copied before this) or for a deployed environment: set the runtime role there too. Merged worktrees and local branches removed.
- 2026-10-12: PRs #1 and #2 merged. PR #2 = Next.js 16.4 app, Tailwind + shadcn defaults, zod env validation at startup (4 tests), Vitest, security headers, `private, no-store` default for dynamic routes.
- 2026-10-12: `feat/ci` (PR #4, open): `.github/workflows/ci.yml` (one job `checks`: Node 24, `npm ci`, lint, typecheck, test, `db:check`, build with placeholder DB URLs; read-only token, no secrets, never touches Neon) and `.github/dependabot.yml` (npm + github-actions, weekly). First run was red at `npm ci`: the macOS-written lockfile lacked `@emnapi/core`/`@emnapi/runtime` (needed by sharp's optional wasm32 package on Linux). Fixed by relocking in a `node:24-slim` container (no `package.json` change, no version moved). Second run green in 28s. Branch protection untouched.
- 2026-10-12: `feat/drizzle-neon`: Drizzle (neon-serverless WebSocket pool on the pooled URL; drizzle-kit on the unpooled URL), migration `0000_enable_pgvector` applied to Neon `dev` (verified: `vector` 0.8.6 installed, 1 migration recorded), `GET /api/health` (200 ok with real DB; 503 with a broken URL; neither log nor response leaks credentials or host). `channel_binding=require` caused no problems.
- 2026-10-09: Scaffold bootstrapped to `main` (`63a3c26`) by Sam's approval; GitHub repo `samtejeda/ai-report-generator` created. Branch protection on `main` enabled (PR required, 0 approvals, admins enforced, no force-push or deletion; no required status checks until CI exists). Ollama 0.40.2 installed via Homebrew (service on `localhost:11434`), `qwen3:1.7b` pulled and answering (one-shot test). Neon dev branch linked.
- 2026-10-08: Workflow scaffold written (ORCHESTRATION.md, PROGRESS.md, API.md, audit-prompts/, .claude/agents/, docs/RUNBOOK.md stub, DESIGN.md placeholder). Awaiting Sam's review.

## In progress

- ~~Phase A app scaffold, PR 2 of 3 (`feat/drizzle-neon`): merged (#3). PR 3 (`feat/ci`) next.~~ Superseded 2026-10-13: PRs #2, #3 and #4 are merged (see the next line).
- Phase A app scaffold complete: PRs #2, #3 and #4 merged (`checks` is a required status check on `main`, see Next up 3).
- `feat/inference-stub`: PR open for review (inference wrapper, stub mode only).
- Data model (`feat/data-model`): steps 1-5 and 7 done, PR #11 open for Sam's review (2026-10-13); step 6 (apply to Neon `dev`) held for Sam's schema sign-off. Plan approved by Sam 2026-10-13. Build order, one commit per step: (1) core tables [done: `0001_core_tables`, generated and `db:check`ed, **not applied** to Neon]; (2) RAG tables + HNSW index, `audit_log`, `jobs` [done: `0002_rag_audit_jobs`, generated and `db:check`ed, not applied]; (3) custom migration: `set_updated_at` trigger, immutability triggers, `purge_client()`, `app_runtime` role and grants [done: `0003_integrity_triggers_purge_and_grants`, applied to Neon `test` branch only (project `delicate-boat-70144866`, branch `test` `br-dawn-wind-b5t4yckd`, created 2026-10-13 from `dev`); behavior not yet tested]; (4) `lib/db/tenant.ts` helper, ESLint restriction on raw `getDb()`, schema-introspection tests [done: 44 unit tests, no DB needed; lint rule proven with a throwaway probe file]; (5) integration tests on a Neon `test` branch (needs `TEST_DATABASE_URL`) [done: 22 tests in `lib/db/integration.test.ts`, all pass, repeatable, skipped when `.env.test.local` is absent]; (6) apply to Neon `dev` only after Sam signs off the final schema; (7) PITR/restore drill recorded in `docs/RUNBOOK.md` [done 2026-10-13, scratch branch restored to an earlier timestamp and compared, then deleted]; (8) push, PR, stop.

## Next up

0. Supply-chain pass (`platform-ops-builder`, checklist 15): baseline dependency report, CI guards (install-script allowlist, `npm audit signatures`, registry check, dependency review on PRs), `process.env` lint rule, and drop `DATABASE_URL_UNPOOLED` from the app's runtime env schema. Added 2026-10-13 at Sam's request; assessed as mostly missing except `npm ci` hash verification, which already runs in CI.

0. Inference follow-ups, each blocked on something else: per-organization `inference_endpoint` / `model_config` wiring (needs the organizations table); SSRF allow-list for `inference_endpoint` (Tailscale/Cloudflare hosts), enforced where admin sets it (backend-builder); streaming; `real` mode with the three-pass pipeline (needs `methodology_prompts` and Sam/practice-owner input on prompt content).
1. Auth and roles plan (Plan Mode first); it must answer the questions listed under "Auth plan must answer". Then `lib/audit.ts` (explicit helper with a no-PHI metadata allow-list, over the `audit_log` table that now exists).
2. ~~Plan Mode: Phase A scaffold (Next.js 16 + Tailwind + shadcn/ui + Drizzle + Neon), then data model migrations. Sam picks which to plan first.~~ Superseded 2026-10-13: scaffold merged (PRs #2-#4) and the data model is built in PR #11 (awaiting Sam's sign-off).
3. ~~Add `.github/workflows/ci.yml`~~ Done in PR #4 (2026-10-12). ~~Still open: make `checks` a required status check on `main`~~ Done 2026-10-13 by Sam in the GitHub UI (Claude's API call was blocked by the permission classifier; not retried). Verified read-only: `required_status_checks` = `checks` (GitHub Actions app 15368), strict off.
4. ~~Add `.github/workflows/ci.yml` (then add the checks job as a required status check on `main`) in the same PR that adds the app's lint/typecheck/test/build scripts.~~ Superseded 2026-10-13: done in PR #4 and `checks` is now required (see the item above).
5. Decide auth provider in the plan: Neon Auth (Better Auth, data in `neon_auth` schema) vs Auth.js; confirm Neon BAA coverage and role fit first. Clerk is out.

## Decisions & assumptions

- Decided (Sam, 2026-10-08): adopt the multi-agent build workflow (supervisor + builders + audit checklists; now seven builders and 14 checklists, see below). Reason: most valuable pieces land first; pass/fail definition of done per domain.
- Assumed (Claude, 2026-10-08, **unconfirmed**): the "stop and ask" trigger list in ORCHESTRATION.md was proposed from the domain; Sam to confirm or edit.
- Decided (Sam, 2026-10-08): add `inference-builder` (owns `lib/ai/*`) with its own checklist `audit-prompts/14-inference-and-methodology.md`. Replaces the earlier assumption that `backend-builder` would own it.
- Assumed (Claude, 2026-10-08, **unconfirmed**): the repo is created without any commit on `main`; the first branch is `chore/workflow-scaffold`. `main` will be created from it on merge.
- ~~Assumed (Claude, 2026-10-08, **unconfirmed**): `.github/workflows/ci.yml` is deferred until the app stack exists.~~ Superseded 2026-10-12: the stack exists; CI added in PR #4.

- Decided (Sam, 2026-10-12): raise the Node floor to `>=22` (`package.json` engines, `CLAUDE.md`). Reason: `ai` and `@ai-sdk/*` declare `node >=22`; Sam develops on Node 24 and Vercel supports 22/24.
- Decided (Claude, 2026-10-12, within Sam's approved plan): stub mode ignores any caller prompt and sends one fixed neutral prompt, per `CLAUDE.md` ("single trivial prompt"). The wrapper has no retries (`maxRetries: 0`) and contacts one endpoint per call.

- Decided (Sam, 2026-10-13): data-model plan approved with the recommended options:
  - D1: active methodology prompt is `report_templates.active_methodology_prompt_id` (composite FK pins it to a prompt of the same template and org), not an `is_active` flag. Reason: `methodology_prompts` rows are then truly never updated. Departs from CLAUDE.md's `is_active` wording; CLAUDE.md to be reconciled when the PR lands.
  - D2: `report_sections` is identity only (key, type, position); `report_versions` holds content, one insert-only row per section edit; current text = highest `version_number`.
  - D3: composite FKs `(organization_id, parent_id)` so the database rejects cross-tenant links.
  - D4: `app_runtime` NOLOGIN role with no UPDATE/DELETE on immutable tables and no DELETE on domain tables; the login role is created with SQL `CREATE ROLE <login> LOGIN PASSWORD '...' IN ROLE app_runtime` (no passwords in migrations) and `DATABASE_URL` switches to it. Do NOT create it in the Neon console: as I recall, console/API-created roles inherit `neon_superuser` and would bypass the grants (~~unverified~~ **verified 2026-10-13** on the `test` branch: a SQL-created login role in `app_runtime` is not superuser, not `neon_superuser`, no `pg_read_all_data`/`pg_write_all_data`, no BYPASSRLS; asserted in `integration.test.ts`). Supersedes the plan wording "Sam creates the login role in the Neon console".
  - D5: Postgres RLS deferred to the auth plan; enforcement is query guard + composite FKs + grants.
  - D6: client columns limited to `display_name`, `date_of_birth`, `grade_level`, optional `external_id`. No address, guardian contact, school name, or diagnosis columns.
  - D7: integration tests run on a separate Neon `test` branch of the dev project.
- Assumed (Claude, 2026-10-13, **unconfirmed**): `app_runtime` will keep DELETE on `rag_documents`, `rag_chunks`, `rag_embeddings` and `jobs` (derived/regenerable data; re-indexing replaces chunks). Clinical tables (`clients`, `reports`, `report_*`, `client_history`) get no DELETE; those go through `purge_client()`. Client-derived RAG documents (`client_note`, `client_report`) must carry a `client_id` (CHECK) so a purge always finds them.
- Assumed (Claude, 2026-10-13, **unconfirmed**): `organizations.type` defaults to `private_practice` (free text, no CHECK); `data_retention_days` exists but nothing enforces it (retention policy is for Sam and the lawyer); `audit_log` rows are kept after a client purge (UUIDs only, no PHI); status/type columns are text + CHECK rather than pg enums.

- Decided (Sam, 2026-10-13): Neon branches are not phases. Phases A and B both use the `dev` branch with synthetic data (only the tenant's `inference_endpoint` / `model_config` change between them). `test` is a scratch branch for DB integration tests only (reset from `dev` when heavy; never holds anything of value). Phase C uses a new production project under the company Neon organization (Scale plan, BAA signed); the dev project, including its unused default `production` branch, must never hold real data. Open, for the CI/deploy plan: Vercel previews and the deployed app both point at `dev` until Phase C unless a `staging` branch is added.

### Auth plan must answer (left open by the data model)

`users` in `lib/db/schema/users.ts` is a minimal, marked extension point (no `password_hash`, no sessions).
- Provider: Neon Auth (Better Auth) vs Auth.js; where credentials live; is `password_hash` needed at all?
- How the auth identity links to `users.id`; email unique globally or per org (provisional: per org, active rows, case-insensitive).
- Can a user belong to more than one org (CLAUDE.md says one)?
- Permission matrix; client assignment model for associates (`client_assignments` join table vs column on `clients`).
- Org bootstrap and invitations (how org #1 is created).
- Session storage and expiry; reset and verification token tables; MFA.
- Failed logins for an unknown user have no org: make `audit_log.organization_id` nullable, or send those events to application logs?
- Role from the session claim or looked up in the DB per request?
- Deactivation: `deleted_at` or a separate flag?
- Where rate-limit state lives.
- How the session produces the `tenantDb` context.
- If Neon Auth is used, grants for `app_runtime` on the `neon_auth` schema.

### Findings

- Finding (Claude, 2026-10-12, verified by curl against Ollama 0.40.2): `qwen3:1.7b` is a thinking model. Without `reasoning_effort: "none"` on `/v1/chat/completions`, it spent all 64 tokens on reasoning and returned empty `content`; with it, `content` is "ready" in 2 tokens. The wrapper sends it (the `--think=false` equivalent) and also strips inline `<think>` blocks as a safety net. A real-mode worker (`qwen3:8b`) must be re-checked for the same behavior.
- Finding (Claude, 2026-10-12): the registry tags `qwen3:1.7b`, `qwen3:8b`, `qwen3:30b-a3b` exist on ollama.com. Only `qwen3:1.7b` is pulled locally, so the worker and heavy IDs are **unverified on a running Ollama**. The filter role currently defaults to `qwen3:1.7b` (CLAUDE.md allows it or `gemma3:4b`).

- Finding (Claude, 2026-10-08): Neon vs Supabase HIPAA/BAA comparison. Web search only; vendor pages not fetched, so figures are **unverified** until confirmed with each vendor.
  - Neon: HIPAA is self-serve on the **Scale** plan with an accepted BAA; no extra charge now, a 15% invoice surcharge is planned with advance notice (neon.com/docs/security/hipaa). `CLAUDE.md` says "Business tier"; likely stale naming.
  - Supabase: BAA requires **Team** ($599/mo) or Enterprise plus the paid HIPAA add-on (about $350/mo per secondary sources; not officially published). Customer must also enforce MFA, PITR, SSL enforcement, network restrictions.
  - Vercel: BAA on Pro as a paid add-on (about $350/mo, click-through, unsigned) or a signed BAA on Enterprise. `CLAUDE.md` says Enterprise required; Pro + add-on may suffice if the lawyer accepts a click-through BAA.
  - Rough Phase C database cost: Neon Scale (usage-based) vs Supabase about $950+/mo.
- Decided (Sam, 2026-10-08): stay on Neon (not Supabase). Reason: cheaper HIPAA path (Scale plan vs Supabase Team + add-on) and we don't need Supabase's bundled extras. Next steps: auth provider still open (NextAuth vs Clerk); confirm Neon Scale/BAA terms with Neon before Phase C.

- Decided (Sam, 2026-10-08): repo name `ai-report-generator` (private). Neon dev project lives on Sam's personal account (`ai-report-generator-dev`, synthetic data only); the production project is created fresh under a company Neon organization when billing starts (migrations rebuild the schema; only `DATABASE_URL` changes). Do not enable the Neon Vercel/GitHub integrations, since integrated projects can't be transferred; use a plain env var. Source: neon.com/docs/manage/orgs-project-transfer (unverified beyond search).

- Done (2026-10-08): Neon CLI 8.1.0 installed globally and logged in (keyring). Folder linked to project `delicate-boat-70144866`, branch `dev` (not `production`) via `.neon` (gitignored); `neon link` wrote the pooled `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and `NEON_BRANCH` into `.env.local` (verified shape only, values not read). Declined: `neon skills`, `neon mcp`, `neon config init`/`neon.ts`/`neon deploy`. Sam also asked to consider Neon's new backend offering (storage, functions, AI gateway) later; not adopted.

- Decided (Sam, 2026-10-09): the GitHub repo is **public** (free branch protection). Consequence rule: the repo must never contain methodology prompt text, example/hand-written reports from the practice owner, or any client-derived data. Those live in the database and local files only. Code, docs, and synthetic fixtures are fine. Cost accepted: product/strategy text in `CLAUDE.md` is public.
- Decided (Sam, 2026-10-09): design brand is not a concern now; `DESIGN.md` stays a placeholder until the restyle pass.

## Open questions for Sam

- Confirm or edit the stop-and-ask trigger list (ORCHESTRATION.md).
- ~~Which getdesign.md brand for `DESIGN.md`~~ Deferred 2026-10-09 (see Decisions).
- ~~Remote: GitHub repo name/visibility~~ Resolved 2026-10-09: public repo `samtejeda/ai-report-generator`.
- Roles/permission matrix (owner / associate / admin): confirm before auth planning.
- Existing deferred questions in `CLAUDE.md` ("Open questions / decisions deferred") still apply.

### Audit self-checks (Claude, 2026-10-12; files re-read from disk; partial/unverified is not pass)

- 14 inference-and-methodology (`feat/inference-stub`; file re-read from disk; items 4-11 not yet applicable, nothing for them exists): **2/11 pass, 1 partial, 8 pending.**
  - 1 **pass**: the only code importing the AI SDK is `lib/ai/inference.ts` and nothing outside `lib/ai` calls it yet; `mode` comes from `INFERENCE_MODE` (test "reads the mode from INFERENCE_MODE"); stub verified on the laptop with `qwen3:1.7b` (manual run above).
  - 2 **partial, not pass**: model IDs only in `models.ts` is enforced by a scan test over `lib/`, `app/`, `components/`; but "overrides come from the organization row" is unverifiable until the organizations table exists (overrides are currently function arguments).
  - 3 **pass**: tests show an unreachable host and a 5xx each make exactly one request to the one configured host, with a fixed error message that contains no prompt, host, or body; manual dead-port run returned `unreachable`; grep finds no cloud provider imports. Caveat: the endpoint allow-list (SSRF) is not built yet; the wrapper only requires http(s) with no embedded credentials.
  - Top 3 next: (a) item 4/2: load the active prompt and per-org config from the DB once those tables exist; (b) item 7: schema-validate model output (`{content, flags}`) before any pipeline work; (c) item 10: record model/tokens/latency in `llm_metadata` and the audit log (the result is already shaped for it).
- (Superseded 2026-10-13: see "05 re-score after step 5" below.) 05 database-and-storage (this PR): 1 pass (item 8: versioned migration, pooled URL in app code, unpooled only in drizzle config). Items 1-5 and 7 not yet applicable (no tables; arrive with the data-model plan). Item 6 **unverified**: Neon backups/PITR not confirmed on the free dev project, no restore drilled. Score 1/8 pass, 6 pending, 1 unverified. Top fixes: data-model migrations (1-4, 7); confirm Neon restore window and drill one restore (6).
- 02 apis-and-backend (this PR): items 1, 2, 5, 7 pass for the single route (`/api/health`: consistent path, 503 without internals, minimal body, listed in API.md). Items 3, 4, 6, 8, 9 not yet applicable (no input, no protected endpoints, no inference, health intentionally unaudited). Score 4/9 pass, 5 pending. Top fix: auth and audit helper before the first real endpoint.
- 04 security-and-rls (PR #2 + this PR): pass on items 2 (no secrets; history scanned before going public), 3 (HTTPS is Vercel's job; HSTS header set; **unverified** until deployed), 7 (headers verified with curl). Item 4 partial (no input yet). Items 1, 5, 6, 8, 9 not yet applicable. Known weakness: CSP still allows `unsafe-inline`. Score 1/9 verified pass (item 2), 7 verified in dev only.
- 01 frontend and 10 caching: `private, no-store` verified for dynamic routes and long-lived caching for hashed assets (10 item 8, item 2 partial). Lighthouse/LCP not recorded.

- 08 cicd-and-version-control (PR #4; file re-read from disk; partial/unverified is not pass):
  1. Commits small and message says why: **pass.** Example: `951e294` ("Without a gate, the scripts ... only protect main if someone remembers to run them"); the six app-code commits before it each carry a why-body. Older docs-era commits are subject-only.
  2. Feature branches and PRs, `main` protected on the checks job: **pass (2026-10-13).** PR required, admins enforced, no force-push or deletion, and `checks` required (strict off): `gh api repos/samtejeda/ai-report-generator/branches/main/protection` returns `required_status_checks.contexts = ["checks"]`. History is PR merges except the approved bootstrap commit `63a3c26` (2026-10-09). Not yet exercised: no red PR has been blocked from merging since the rule was set (the earlier red run predates it).
  3. Automated lint, typecheck, tests, build, plus Drizzle check on every PR: **pass.** PR #4 run 38296858882: `checks` green in 28s with all five steps. Gate proven to fail too: run 38295916913 was red at `npm ci`. Now a required check (see 2).
  4. Auto-deploy on merge to `main`: **fail, not yet applicable.** No Vercel project exists (no `.vercel/`, no deploy integration). Closes when the Vercel project is connected.
  5. No secrets in code or history: **pass.** `git grep -nEI 'postgres(ql)?://[^ ]*:[^ @]+@[^ ]+|napi_[A-Za-z0-9]+|npg_[A-Za-z0-9]+|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}'` on the tree hit only placeholder URLs (`postgresql://u:p@h/d` in ci.yml, `user:pw@host.example.com` in `lib/env.test.ts`); `git log --all --name-only | grep '^\.env'` lists only `.env.example`; `git log --all -p -G'...neon|aws|napi_|npg_'` found nothing. This is a one-time manual scan, not continuous: `gh api repos/samtejeda/ai-report-generator --jq .security_and_analysis` shows `secret_scanning`, `secret_scanning_push_protection` and `dependabot_security_updates` were all **disabled** at scan time; **enabled 2026-10-12 at Sam's request** (plus vulnerability alerts, which Dependabot security updates require), verified with the same `gh api` call: all three `enabled`. Item 5 is now backed by a continuous scan, not only the one-time manual one.
  6. Fast revert, tested: **fail.** No revert drilled, and rollback is meaningless until a deploy exists. Closes with the Vercel connection (revert the merge commit, confirm redeploy).
  Score 4/6 pass (1, 2, 3, 5; was 3/6 before `checks` became required); fails 4, 6. Top fixes: connect Vercel and verify auto-deploy; drill one revert. Secret scanning, push protection and Dependabot security updates now enabled.
- 06 hosting-and-deployment (PR #4): 1 secrets in Vercel env per environment: **not yet applicable** (no Vercel project). 2 HTTPS on all hosts: **not yet applicable** (nothing served; HSTS header set, unverified until deployed). 3 clean build with no ignored failures: **pass.** CI build green on Linux; `grep` of `next.config.ts`, `app/`, `lib/`, `components/`, eslint config finds no `ignoreBuildErrors`, `ignoreDuringBuilds`, `@ts-ignore`, `@ts-nocheck` or `eslint-disable`. 4 domain and DNS: **not yet applicable.** 5 repo-connected deploy with PR previews: **fail, not yet applicable** (no Vercel project). 6 one-click rollback tested: **fail, not yet applicable.** 7 BAA gate tracked, no real data on non-BAA tiers: **pass.** Pre-launch checklist carries the Neon, Vercel and other-vendor BAA items and the Phase C gate; only synthetic data exists (Neon dev project). Score 2/7 pass (3, 7); 5 not yet applicable (Vercel project missing). Top fixes: create and connect the Vercel project with env vars per environment; add domain/HTTPS; test one rollback.
- 07 cloud-and-compute (PR #4): 1 no needless polling/calls: **not yet applicable** (one route, `/api/health`, called on demand). 2 right-sized compute (Vercel region near Neon, Neon autosuspend): **fail, unverified.** Neon region/compute settings not checked; no Vercel region yet. 3 timeouts and `maxDuration`: **not yet applicable** (no generation routes). 4 large assets via CDN: **not yet applicable** (nothing deployed; assets are hashed static files). 5 first failure point at 10x written down: **fail.** Expected answer (single Ollama box concurrency, then Neon connections) is not written anywhere yet. 6 billing alerts: **fail.** Tracked in the Pre-launch checklist only. Score 0/6 pass; 3 not yet applicable. Top fixes: write the 10x failure-point note in `docs/RUNBOOK.md`; confirm Neon region/autosuspend; set billing alerts when Vercel exists.

- 05 database-and-storage (`feat/data-model` step 1, 2026-10-13; file re-read from disk; nothing applied to Neon yet, so DB-level behavior is **unverified**): 
  1. partial: core tables follow conventions (`clients.organization_id uuid NOT NULL`, uuid PKs, timestamptz); RAG, `audit_log`, `jobs` not yet written.
  2. partial: explicit delete behavior on every FK (`reports_client_fk` cascade, `report_versions_created_by_fk` restrict); purge function not yet written, cascade not yet tested.
  3. partial: one active prompt per template is structural (`report_templates.active_methodology_prompt_id`); `methodology_prompts_template_version_uq` on `(template_id, version_number)`; other uniques present; untested against a DB.
  4. partial: org-leading indexes on all FK paths (`reports_org_client_created_idx`); `audit_log` composite and pgvector HNSW not yet written.
  5. partial: no `bytea` or file columns so far; complete only when all tables exist.
  6. unverified: no restore drilled.
  7. fail (pending): no triggers or grants yet.
  8. pass: `0001_core_tables.sql` generated by drizzle-kit, `db:check` clean, no `db push`, app uses the pooled URL.
  Score 1/8 pass. Top 3: immutability triggers + grants (7), RAG/audit/jobs tables with their indexes (1, 4), DB-level tests plus restore drill (2, 3, 6).

- 05 update after step 2 (2026-10-13, file unchanged on re-read): items 1-5 still partial pending DB-level tests but now cover all 14 tables: `audit_log_org_resource_idx` on `(organization_id, resource_type, resource_id, created_at)`; `rag_embeddings_embedding_hnsw_idx` (HNSW, cosine); `rag_embeddings_chunk_fk` cascades chunk to embedding. Item 7 still fail until step 3; item 6 unverified. Score 1/8 pass.

- 05 update after step 3 (2026-10-13, file unchanged on re-read): item 7 still **unverified** (not fail): triggers and grants exist and the migration applies on the `test` branch, but no test has tried to UPDATE `report_versions` or DELETE `audit_log` yet. `.env.test.local` (gitignored) holds the test-branch URLs. Score 1/8 pass until step 5.

- 05 update after step 4 (2026-10-13, file unchanged on re-read): item 1 now has automated checks (`lib/db/schema.test.ts`: every table has uuid PK, `created_at`, `organization_id` NOT NULL, snake_case) but stays partial until the DB is migrated and reviewed; item 4 FK-index coverage and the audit/HNSW indexes are asserted in the same file; item 5 asserted (no bytea columns). 04 item 1: query guard exists with SQL-level unit tests (`lib/db/tenant.test.ts`) but the cross-tenant test against a real DB is step 5, so **not yet pass**. Score 1/8 pass.

- 05 re-score after step 5 (2026-10-13; audit file re-read from disk, unchanged; evidence is the passing integration suite on the Neon `test` branch, nothing applied to `dev` yet):
  1. pass: all 14 tables have uuid PK, `created_at`, NOT NULL `organization_id` (`schema.test.ts`); documented exceptions: `audit_log` has no FKs, insert-only tables have no `updated_at`/`deleted_at`.
  2. pass: purge test removes client + history + report + sections + 2 versions + RAG doc/chunk/embedding + job in one call and leaves another client, org B, and the audit row (`purge_client` result counts asserted).
  3. pass: duplicate prompt version, duplicate template slug, duplicate external id (soft-delete aware), duplicate report version number all raise 23505; one active prompt per template is a pointer whose FK rejects another template's or org's prompt.
  4. pass: FK-covering-index test over all FKs; `audit_log_org_resource_idx`; `rag_embeddings_embedding_hnsw_idx` confirmed in `pg_indexes` as HNSW `vector_cosine_ops`. Query plans not EXPLAINed (no data volume yet).
  5. pass: no bytea/blob columns (asserted); exports are generated on demand (no export code yet).
  6. pass (dev project only): `neon branches restore` of a scratch copy of `test` to an earlier timestamp showed the earlier row counts (2 orgs vs 6 now) with schema intact; recorded in `docs/RUNBOOK.md`. Caveat: 6-hour history window on the dev project; in-place restore not exercised; re-drill on the production project before Phase C.
  7. pass: UPDATE/DELETE/TRUNCATE on `report_versions`, `methodology_prompts`, `audit_log` fail for the app role (42501) and the owner (23001; plain TRUNCATE of FK-referenced `methodology_prompts` is refused by Postgres 0A000, and CASCADE is stopped by the `report_versions` trigger); FK cascade cannot bypass the trigger; setting `app.purge` by hand does not help the app.
  8. pass: four versioned migrations (`0000`-`0003`), no `db push`, app code uses the pooled `DATABASE_URL`; `db:check` clean. Caveat: `dev` still has only `0000` applied.
  Score 8/8 pass (item 6 with the caveat above). Top 3 remaining: apply to `dev` after Sam's sign-off and switch `DATABASE_URL` to the `app_runtime` login role; `lib/audit.ts` must enforce the no-PHI metadata allow-list (04 item 9 second half).
- 04 security-and-rls overlap (data layer only): item 1 pass at the data layer (cross-tenant read/update/soft-delete/FK tests; no route exists yet to test end to end); item 9: append-only at DB permission level pass, "no PHI content" not yet enforceable until `lib/audit.ts` exists.

### Known issues

- `npm audit --omit=dev` reports 13 (4 moderate, 9 high), all through `braces`/`fast-glob` under `shadcn` (a direct dependency, though a CLI) and dev tooling; none come from `ai` or `@ai-sdk/openai-compatible` (checked after install). Consider moving `shadcn` to devDependencies in a separate change.
- Lockfile hygiene: `package-lock.json` must be generated on Linux or CI's `npm ci` can fail on optional wasm packages (sharp, tailwind oxide). macOS `npm install` strips those entries and `--package-lock-only` does not restore them. Fix recipe: copy `package.json` + lockfile into a scratch dir and run `docker run --rm -v <dir>:/w -w /w node:24-slim npm install --package-lock-only --ignore-scripts`, then copy the lockfile back. Dependabot runs on Linux, so its PRs should keep this correct. Docker Desktop's default 1 GB VM is too small to run `next build`; use CI for the build.

- (Superseded 2026-10-13: the advisory comes through `shadcn`, a direct dependency, not the ESLint chain; see the entry above and checklist 15 item 7.) `npm audit`: high `braces` advisory via the dev-only ESLint chain (`eslint-config-next`). The suggested fix is a breaking downgrade, so left alone. Revisit when `eslint-config-next` updates; tracked, not accepted permanently.

## Pre-launch checklist

Single home for anything gated on a later condition. Do not bury these in dated logs.

- [ ] Company Neon organization created; production project created there on the Scale plan (not a transfer of the dev project).
- [ ] BAA signed with Neon (Scale plan; `CLAUDE.md` says "Business", likely stale) before any real client data.
- [ ] BAA signed with Vercel (Enterprise tier) before any real client data.
- [ ] Any other vendor touching PHI identified and under BAA (Resend content policy: no PHI in emails).
- [ ] Healthcare-privacy lawyer reviews first client contract and BAA.
- [ ] Practice confirmed to bill insurance electronically (confirms HIPAA covered-entity status).
- [ ] Sentry configured to scrub PHI (no request bodies) before it is enabled outside dev.
- [ ] Audit log retention policy set (6 years minimum) and append-only enforced at DB permission level.
- [ ] Hard-deletion path propagates to report versions, RAG embeddings, derived data; tested.
- [ ] Tailscale/Cloudflare tunnel in place for the cloud-to-SLM path; endpoint not publicly exposed.
- [ ] Backup restore performed once and recorded in `docs/RUNBOOK.md`. (Drilled 2026-10-13 on the dev project's `test` branch only; repeat on the production Neon project.)
- [ ] Billing alerts set on Vercel and Neon.
- [ ] Uptime monitoring and alerting in place.
- [ ] Phase C gate: Sam explicitly approves real data flowing.

## Blocked on Sam

- Review the `feat/data-model` PR and sign off the final schema (14 tables, migrations `0001`-`0003`). Nothing has been applied to Neon `dev` (still only `0000_enable_pgvector`). After sign-off: run `npm run db:migrate` against `dev` (one command, owner role), then create the app login role with SQL per `docs/RUNBOOK.md` and point `DATABASE_URL` at it.
- Confirm the **assumptions** logged under "Decisions & assumptions" dated 2026-10-13 (defaults for `organizations.type`, retention column unenforced, audit rows kept after purge, text+CHECK instead of enums, `app_runtime` keeps DELETE on RAG/jobs tables).
- Legal/policy (not blocking this PR): how long purged client data may persist in Neon history/backups, and how long `audit_log` rows are kept after a purge.
