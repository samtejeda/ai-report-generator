# PROGRESS.md

Source of truth for project state. Update after every commit or milestone. Conventions: resolved items get a date and ~~strikethrough~~, never deletion. Don't rewrite historical snapshots; add a "Superseded <date>" pointer. Anything unverified is marked **unverified**. Audit scores are honest: partial is not pass, unverified is not pass.

## Done

- 2026-10-08: Repo initialized (`git init`) on `chore/workflow-scaffold`; baseline `CLAUDE.md` committed.
- 2026-10-12: PRs #1 and #2 merged. PR #2 = Next.js 16.4 app, Tailwind + shadcn defaults, zod env validation at startup (4 tests), Vitest, security headers, `private, no-store` default for dynamic routes.
- 2026-10-12: `feat/ci` (PR #4, open): `.github/workflows/ci.yml` (one job `checks`: Node 24, `npm ci`, lint, typecheck, test, `db:check`, build with placeholder DB URLs; read-only token, no secrets, never touches Neon) and `.github/dependabot.yml` (npm + github-actions, weekly). First run was red at `npm ci`: the macOS-written lockfile lacked `@emnapi/core`/`@emnapi/runtime` (needed by sharp's optional wasm32 package on Linux). Fixed by relocking in a `node:24-slim` container (no `package.json` change, no version moved). Second run green in 28s. Branch protection untouched.
- 2026-10-12: `feat/drizzle-neon`: Drizzle (neon-serverless WebSocket pool on the pooled URL; drizzle-kit on the unpooled URL), migration `0000_enable_pgvector` applied to Neon `dev` (verified: `vector` 0.8.6 installed, 1 migration recorded), `GET /api/health` (200 ok with real DB; 503 with a broken URL; neither log nor response leaks credentials or host). `channel_binding=require` caused no problems.
- 2026-10-09: Scaffold bootstrapped to `main` (`63a3c26`) by Sam's approval; GitHub repo `samtejeda/ai-report-generator` created. Branch protection on `main` enabled (PR required, 0 approvals, admins enforced, no force-push or deletion; no required status checks until CI exists). Ollama 0.40.2 installed via Homebrew (service on `localhost:11434`), `qwen3:1.7b` pulled and answering (one-shot test). Neon dev branch linked.
- 2026-10-08: Workflow scaffold written (ORCHESTRATION.md, PROGRESS.md, API.md, audit-prompts/, .claude/agents/, docs/RUNBOOK.md stub, DESIGN.md placeholder). Awaiting Sam's review.

## In progress

- Phase A app scaffold, PR 3 of 3 (`feat/ci`, PR #4): open for review. PR 1 and PR 2 are merged.

## Next up

1. Plan Mode: Phase A scaffold (Next.js 16 + Tailwind + shadcn/ui + Drizzle + Neon), then data model migrations. Sam picks which to plan first.
2. ~~Add `.github/workflows/ci.yml`~~ Done in PR #4 (2026-10-12). Still open: after #4 merges and `checks` has run once on `main`, Sam asks for `checks` to be made a required status check on `main` (strict off). Claude does not change protection unprompted.
3. Decide auth provider in the plan: Neon Auth (Better Auth, data in `neon_auth` schema) vs Auth.js; confirm Neon BAA coverage and role fit first. Clerk is out.

## Decisions & assumptions

- Decided (Sam, 2026-10-08): adopt the multi-agent build workflow (supervisor + builders + audit checklists; now seven builders and 14 checklists, see below). Reason: most valuable pieces land first; pass/fail definition of done per domain.
- Assumed (Claude, 2026-10-08, **unconfirmed**): the "stop and ask" trigger list in ORCHESTRATION.md was proposed from the domain; Sam to confirm or edit.
- Decided (Sam, 2026-10-08): add `inference-builder` (owns `lib/ai/*`) with its own checklist `audit-prompts/14-inference-and-methodology.md`. Replaces the earlier assumption that `backend-builder` would own it.
- Assumed (Claude, 2026-10-08, **unconfirmed**): the repo is created without any commit on `main`; the first branch is `chore/workflow-scaffold`. `main` will be created from it on merge.
- ~~Assumed (Claude, 2026-10-08, **unconfirmed**): `.github/workflows/ci.yml` is deferred until the app stack exists.~~ Superseded 2026-10-12: the stack exists; CI added in PR #4.

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

- 08 cicd-and-version-control (PR #4; file re-read from disk; partial/unverified is not pass):
  1. Commits small and message says why: **pass.** Example: `951e294` ("Without a gate, the scripts ... only protect main if someone remembers to run them"); the six app-code commits before it each carry a why-body. Older docs-era commits are subject-only.
  2. Feature branches and PRs, `main` protected on the checks job: **fail (partial).** PR required, admins enforced, no force-push or deletion; history is PR merges except the approved bootstrap commit `63a3c26` (2026-10-09). But `checks` is not a required status check yet (`gh api .../protection` shows no `required_status_checks`). Closes when Sam asks after the first green run on `main`.
  3. Automated lint, typecheck, tests, build, plus Drizzle check on every PR: **pass.** PR #4 run 38296858882: `checks` green in 28s with all five steps. Gate proven to fail too: run 38295916913 was red at `npm ci`. Caveat: not a required check yet (see 2).
  4. Auto-deploy on merge to `main`: **fail, not yet applicable.** No Vercel project exists (no `.vercel/`, no deploy integration). Closes when the Vercel project is connected.
  5. No secrets in code or history: **pass.** `git grep -nEI 'postgres(ql)?://[^ ]*:[^ @]+@[^ ]+|napi_[A-Za-z0-9]+|npg_[A-Za-z0-9]+|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}'` on the tree hit only placeholder URLs (`postgresql://u:p@h/d` in ci.yml, `user:pw@host.example.com` in `lib/env.test.ts`); `git log --all --name-only | grep '^\.env'` lists only `.env.example`; `git log --all -p -G'...neon|aws|napi_|npg_'` found nothing. This is a one-time manual scan, not continuous: `gh api repos/samtejeda/ai-report-generator --jq .security_and_analysis` shows `secret_scanning`, `secret_scanning_push_protection` and `dependabot_security_updates` were all **disabled** at scan time; **enabled 2026-10-12 at Sam's request** (plus vulnerability alerts, which Dependabot security updates require), verified with the same `gh api` call: all three `enabled`. Item 5 is now backed by a continuous scan, not only the one-time manual one.
  6. Fast revert, tested: **fail.** No revert drilled, and rollback is meaningless until a deploy exists. Closes with the Vercel connection (revert the merge commit, confirm redeploy).
  Score 3/6 pass (1, 3, 5); fails 2, 4, 6. Top fixes: make `checks` required; connect Vercel and verify auto-deploy; drill one revert. Secret scanning, push protection and Dependabot security updates now enabled.
- 06 hosting-and-deployment (PR #4): 1 secrets in Vercel env per environment: **not yet applicable** (no Vercel project). 2 HTTPS on all hosts: **not yet applicable** (nothing served; HSTS header set, unverified until deployed). 3 clean build with no ignored failures: **pass.** CI build green on Linux; `grep` of `next.config.ts`, `app/`, `lib/`, `components/`, eslint config finds no `ignoreBuildErrors`, `ignoreDuringBuilds`, `@ts-ignore`, `@ts-nocheck` or `eslint-disable`. 4 domain and DNS: **not yet applicable.** 5 repo-connected deploy with PR previews: **fail, not yet applicable** (no Vercel project). 6 one-click rollback tested: **fail, not yet applicable.** 7 BAA gate tracked, no real data on non-BAA tiers: **pass.** Pre-launch checklist carries the Neon, Vercel and other-vendor BAA items and the Phase C gate; only synthetic data exists (Neon dev project). Score 2/7 pass (3, 7); 5 not yet applicable (Vercel project missing). Top fixes: create and connect the Vercel project with env vars per environment; add domain/HTTPS; test one rollback.
- 07 cloud-and-compute (PR #4): 1 no needless polling/calls: **not yet applicable** (one route, `/api/health`, called on demand). 2 right-sized compute (Vercel region near Neon, Neon autosuspend): **fail, unverified.** Neon region/compute settings not checked; no Vercel region yet. 3 timeouts and `maxDuration`: **not yet applicable** (no generation routes). 4 large assets via CDN: **not yet applicable** (nothing deployed; assets are hashed static files). 5 first failure point at 10x written down: **fail.** Expected answer (single Ollama box concurrency, then Neon connections) is not written anywhere yet. 6 billing alerts: **fail.** Tracked in the Pre-launch checklist only. Score 0/6 pass; 3 not yet applicable. Top fixes: write the 10x failure-point note in `docs/RUNBOOK.md`; confirm Neon region/autosuspend; set billing alerts when Vercel exists.

### Known issues

- Lockfile hygiene: `package-lock.json` must be generated on Linux or CI's `npm ci` can fail on optional wasm packages (sharp, tailwind oxide). macOS `npm install` strips those entries and `--package-lock-only` does not restore them. Fix recipe: copy `package.json` + lockfile into a scratch dir and run `docker run --rm -v <dir>:/w -w /w node:24-slim npm install --package-lock-only --ignore-scripts`, then copy the lockfile back. Dependabot runs on Linux, so its PRs should keep this correct. Docker Desktop's default 1 GB VM is too small to run `next build`; use CI for the build.

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

- After PR #4 merges and `checks` has run once on `main`: tell Claude to make `checks` a required status check on `main` (`gh api` update of existing protection, strict off). Not done unprompted.
