# PROGRESS.md

Source of truth for project state. Update after every commit or milestone. Conventions: resolved items get a date and ~~strikethrough~~, never deletion. Don't rewrite historical snapshots; add a "Superseded <date>" pointer. Anything unverified is marked **unverified**. Audit scores are honest: partial is not pass, unverified is not pass.

## Done

- 2026-10-08: Repo initialized (`git init`) on `chore/workflow-scaffold`; baseline `CLAUDE.md` committed.
- 2026-10-09: Scaffold bootstrapped to `main` (`63a3c26`) by Sam's approval; GitHub repo `samtejeda/ai-report-generator` created. Branch protection on `main` enabled (PR required, 0 approvals, admins enforced, no force-push or deletion; no required status checks until CI exists). Ollama 0.40.2 installed via Homebrew (service on `localhost:11434`), `qwen3:1.7b` pulled and answering (one-shot test). Neon dev branch linked.
- 2026-10-08: Workflow scaffold written (ORCHESTRATION.md, PROGRESS.md, API.md, audit-prompts/, .claude/agents/, docs/RUNBOOK.md stub, DESIGN.md placeholder). Awaiting Sam's review.

## In progress

- Phase A app scaffold: planning (Plan Mode), not started.

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
