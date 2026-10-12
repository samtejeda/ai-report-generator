# PROGRESS.md

Source of truth for project state. Update after every commit or milestone. Conventions: resolved items get a date and ~~strikethrough~~, never deletion. Don't rewrite historical snapshots; add a "Superseded <date>" pointer. Anything unverified is marked **unverified**. Audit scores are honest: partial is not pass, unverified is not pass.

## Done

- 2026-10-08: Repo initialized (`git init`) on `chore/workflow-scaffold`; baseline `CLAUDE.md` committed.
- 2026-10-12: PRs #1 and #2 merged. PR #2 = Next.js 16.4 app, Tailwind + shadcn defaults, zod env validation at startup (4 tests), Vitest, security headers, `private, no-store` default for dynamic routes.
- 2026-10-12: `feat/drizzle-neon`: Drizzle (neon-serverless WebSocket pool on the pooled URL; drizzle-kit on the unpooled URL), migration `0000_enable_pgvector` applied to Neon `dev` (verified: `vector` 0.8.6 installed, 1 migration recorded), `GET /api/health` (200 ok with real DB; 503 with a broken URL; neither log nor response leaks credentials or host). `channel_binding=require` caused no problems.
- 2026-10-09: Scaffold bootstrapped to `main` (`63a3c26`) by Sam's approval; GitHub repo `samtejeda/ai-report-generator` created. Branch protection on `main` enabled (PR required, 0 approvals, admins enforced, no force-push or deletion; no required status checks until CI exists). Ollama 0.40.2 installed via Homebrew (service on `localhost:11434`), `qwen3:1.7b` pulled and answering (one-shot test). Neon dev branch linked.
- 2026-10-08: Workflow scaffold written (ORCHESTRATION.md, PROGRESS.md, API.md, audit-prompts/, .claude/agents/, docs/RUNBOOK.md stub, DESIGN.md placeholder). Awaiting Sam's review.

## In progress

- Phase A app scaffold, PR 2 of 3 (`feat/drizzle-neon`): open for review. PR 3 (`feat/ci`) next.

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
