# PROGRESS.md

Source of truth for project state. Update after every commit or milestone. Conventions: resolved items get a date and ~~strikethrough~~, never deletion. Don't rewrite historical snapshots; add a "Superseded <date>" pointer. Anything unverified is marked **unverified**. Audit scores are honest: partial is not pass, unverified is not pass.

## Done

- 2026-10-08: Repo initialized (`git init`) on `chore/workflow-scaffold`; baseline `CLAUDE.md` committed.
- 2026-10-12: PRs #1 and #2 merged. PR #2 = Next.js 16.4 app, Tailwind + shadcn defaults, zod env validation at startup (4 tests), Vitest, security headers, `private, no-store` default for dynamic routes.
- 2026-10-12: `feat/drizzle-neon`: Drizzle (neon-serverless WebSocket pool on the pooled URL; drizzle-kit on the unpooled URL), migration `0000_enable_pgvector` applied to Neon `dev` (verified: `vector` 0.8.6 installed, 1 migration recorded), `GET /api/health` (200 ok with real DB; 503 with a broken URL; neither log nor response leaks credentials or host). `channel_binding=require` caused no problems.
- 2026-10-09: Scaffold bootstrapped to `main` (`63a3c26`) by Sam's approval; GitHub repo `samtejeda/ai-report-generator` created. Branch protection on `main` enabled (PR required, 0 approvals, admins enforced, no force-push or deletion; no required status checks until CI exists). Ollama 0.40.2 installed via Homebrew (service on `localhost:11434`), `qwen3:1.7b` pulled and answering (one-shot test). Neon dev branch linked.
- 2026-10-08: Workflow scaffold written (ORCHESTRATION.md, PROGRESS.md, API.md, audit-prompts/, .claude/agents/, docs/RUNBOOK.md stub, DESIGN.md placeholder). Awaiting Sam's review.

## In progress

- Phase A app scaffold, PR 2 of 3 (`feat/drizzle-neon`): merged (#3). PR 3 (`feat/ci`) next.
- Data model (`feat/data-model`), plan approved by Sam 2026-10-13. Build order, one commit per step: (1) core tables [done: `0001_core_tables`, generated and `db:check`ed, **not applied** to Neon]; (2) RAG tables + HNSW index, `audit_log`, `jobs` [done: `0002_rag_audit_jobs`, generated and `db:check`ed, not applied]; (3) custom migration: `set_updated_at` trigger, immutability triggers, `purge_client()`, `app_runtime` role and grants [done: `0003_integrity_triggers_purge_and_grants`, applied to Neon `test` branch only (project `delicate-boat-70144866`, branch `test` `br-dawn-wind-b5t4yckd`, created 2026-10-13 from `dev`); behavior not yet tested]; (4) `lib/db/tenant.ts` helper, ESLint restriction on raw `getDb()`, schema-introspection tests; (5) integration tests on a Neon `test` branch (needs `TEST_DATABASE_URL`); (6) apply to Neon `dev` only after Sam signs off the final schema; (7) PITR/restore drill recorded in `docs/RUNBOOK.md`; (8) push, PR, stop.

## Next up

1. Plan Mode: Phase A scaffold (Next.js 16 + Tailwind + shadcn/ui + Drizzle + Neon), then data model migrations. Sam picks which to plan first.
2. Add `.github/workflows/ci.yml` (then add the checks job as a required status check on `main`) in the same PR that adds the app's lint/typecheck/test/build scripts.
3. Decide auth provider in the plan: Neon Auth (Better Auth, data in `neon_auth` schema) vs Auth.js; confirm Neon BAA coverage and role fit first. Clerk is out.

## Decisions & assumptions

- Decided (Sam, 2026-10-08): adopt the multi-agent build workflow (supervisor + builders + audit checklists; now seven builders and 14 checklists, see below). Reason: most valuable pieces land first; pass/fail definition of done per domain.
- Assumed (Claude, 2026-10-08, **unconfirmed**): the "stop and ask" trigger list in ORCHESTRATION.md was proposed from the domain; Sam to confirm or edit.
- Decided (Sam, 2026-10-08): add `inference-builder` (owns `lib/ai/*`) with its own checklist `audit-prompts/14-inference-and-methodology.md`. Replaces the earlier assumption that `backend-builder` would own it.
- Assumed (Claude, 2026-10-08, **unconfirmed**): the repo is created without any commit on `main`; the first branch is `chore/workflow-scaffold`. `main` will be created from it on merge.
- Assumed (Claude, 2026-10-08, **unconfirmed**): `.github/workflows/ci.yml` is deferred until the app stack exists.

- Decided (Sam, 2026-10-13): data-model plan approved with the recommended options:
  - D1: active methodology prompt is `report_templates.active_methodology_prompt_id` (composite FK pins it to a prompt of the same template and org), not an `is_active` flag. Reason: `methodology_prompts` rows are then truly never updated. Departs from CLAUDE.md's `is_active` wording; CLAUDE.md to be reconciled when the PR lands.
  - D2: `report_sections` is identity only (key, type, position); `report_versions` holds content, one insert-only row per section edit; current text = highest `version_number`.
  - D3: composite FKs `(organization_id, parent_id)` so the database rejects cross-tenant links.
  - D4: `app_runtime` NOLOGIN role with no UPDATE/DELETE on immutable tables and no DELETE on domain tables; the login role is created with SQL `CREATE ROLE <login> LOGIN PASSWORD '...' IN ROLE app_runtime` (no passwords in migrations) and `DATABASE_URL` switches to it. Do NOT create it in the Neon console: as I recall, console/API-created roles inherit `neon_superuser` and would bypass the grants (**unverified**; the integration tests connect as the real login role to prove the lockdown). Supersedes the plan wording "Sam creates the login role in the Neon console".
  - D5: Postgres RLS deferred to the auth plan; enforcement is query guard + composite FKs + grants.
  - D6: client columns limited to `display_name`, `date_of_birth`, `grade_level`, optional `external_id`. No address, guardian contact, school name, or diagnosis columns.
  - D7: integration tests run on a separate Neon `test` branch of the dev project.
- Assumed (Claude, 2026-10-13, **unconfirmed**): `app_runtime` will keep DELETE on `rag_documents`, `rag_chunks`, `rag_embeddings` and `jobs` (derived/regenerable data; re-indexing replaces chunks). Clinical tables (`clients`, `reports`, `report_*`, `client_history`) get no DELETE; those go through `purge_client()`. Client-derived RAG documents (`client_note`, `client_report`) must carry a `client_id` (CHECK) so a purge always finds them.
- Assumed (Claude, 2026-10-13, **unconfirmed**): `organizations.type` defaults to `private_practice` (free text, no CHECK); `data_retention_days` exists but nothing enforces it (retention policy is for Sam and the lawyer); `audit_log` rows are kept after a client purge (UUIDs only, no PHI); status/type columns are text + CHECK rather than pg enums.

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

- 05 database-and-storage (this PR): 1 pass (item 8: versioned migration, pooled URL in app code, unpooled only in drizzle config). Items 1-5 and 7 not yet applicable (no tables; arrive with the data-model plan). Item 6 **unverified**: Neon backups/PITR not confirmed on the free dev project, no restore drilled. Score 1/8 pass, 6 pending, 1 unverified. Top fixes: data-model migrations (1-4, 7); confirm Neon restore window and drill one restore (6).
- 02 apis-and-backend (this PR): items 1, 2, 5, 7 pass for the single route (`/api/health`: consistent path, 503 without internals, minimal body, listed in API.md). Items 3, 4, 6, 8, 9 not yet applicable (no input, no protected endpoints, no inference, health intentionally unaudited). Score 4/9 pass, 5 pending. Top fix: auth and audit helper before the first real endpoint.
- 04 security-and-rls (PR #2 + this PR): pass on items 2 (no secrets; history scanned before going public), 3 (HTTPS is Vercel's job; HSTS header set; **unverified** until deployed), 7 (headers verified with curl). Item 4 partial (no input yet). Items 1, 5, 6, 8, 9 not yet applicable. Known weakness: CSP still allows `unsafe-inline`. Score 1/9 verified pass (item 2), 7 verified in dev only.
- 01 frontend and 10 caching: `private, no-store` verified for dynamic routes and long-lived caching for hashed assets (10 item 8, item 2 partial). Lighthouse/LCP not recorded.

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

### Known issues

- `npm audit`: high `braces` advisory via the dev-only ESLint chain (`eslint-config-next`). The suggested fix is a breaking downgrade, so left alone. Revisit when `eslint-config-next` updates; tracked, not accepted permanently.

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
- [ ] Backup restore performed once and recorded in `docs/RUNBOOK.md`.
- [ ] Billing alerts set on Vercel and Neon.
- [ ] Uptime monitoring and alerting in place.
- [ ] Phase C gate: Sam explicitly approves real data flowing.

## Blocked on Sam

- Nothing at the moment.
