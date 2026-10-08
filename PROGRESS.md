# PROGRESS.md

Source of truth for project state. Update after every commit or milestone. Conventions: resolved items get a date and ~~strikethrough~~, never deletion. Don't rewrite historical snapshots; add a "Superseded <date>" pointer. Anything unverified is marked **unverified**. Audit scores are honest: partial is not pass, unverified is not pass.

## Done

- 2026-10-08: Repo initialized (`git init`) on `chore/workflow-scaffold`; baseline `CLAUDE.md` committed.
- 2026-10-08: Workflow scaffold written (ORCHESTRATION.md, PROGRESS.md, API.md, audit-prompts/, .claude/agents/, docs/RUNBOOK.md stub, DESIGN.md placeholder). Awaiting Sam's review.

## In progress

- `chore/workflow-scaffold`: pending Sam's review and merge.

## Next up

1. Create the `main` branch on the remote and set branch protection (see Blocked on Sam). Merge the scaffold PR.
2. Plan Mode: Phase A scaffold (Next.js 16 + Tailwind + shadcn/ui + Drizzle + Neon), then data model migrations. Sam picks which to plan first.
3. Add `.github/workflows/ci.yml` in the same PR that adds the app's lint/typecheck/test/build scripts.
4. Choose design reference(s) and vet the `getdesign` package (see Open questions).

## Decisions & assumptions

- Decided (Sam, 2026-10-08): adopt the multi-agent build workflow (supervisor + six builders + 13 audit checklists). Reason: most valuable pieces land first; pass/fail definition of done per domain.
- Assumed (Claude, 2026-10-08, **unconfirmed**): the "stop and ask" trigger list in ORCHESTRATION.md was proposed from the domain; Sam to confirm or edit.
- Assumed (Claude, 2026-10-08, **unconfirmed**): no inference-specific builder agent; `backend-builder` owns `lib/ai/*`.
- Assumed (Claude, 2026-10-08, **unconfirmed**): the repo is created without any commit on `main`; the first branch is `chore/workflow-scaffold`. `main` will be created from it on merge.
- Assumed (Claude, 2026-10-08, **unconfirmed**): `.github/workflows/ci.yml` is deferred until the app stack exists.

### Findings

- Finding (Claude, 2026-10-08): Neon vs Supabase HIPAA/BAA comparison. Web search only; vendor pages not fetched, so figures are **unverified** until confirmed with each vendor.
  - Neon: HIPAA is self-serve on the **Scale** plan with an accepted BAA; no extra charge now, a 15% invoice surcharge is planned with advance notice (neon.com/docs/security/hipaa). `CLAUDE.md` says "Business tier"; likely stale naming.
  - Supabase: BAA requires **Team** ($599/mo) or Enterprise plus the paid HIPAA add-on (about $350/mo per secondary sources; not officially published). Customer must also enforce MFA, PITR, SSL enforcement, network restrictions.
  - Vercel: BAA on Pro as a paid add-on (about $350/mo, click-through, unsigned) or a signed BAA on Enterprise. `CLAUDE.md` says Enterprise required; Pro + add-on may suffice if the lawyer accepts a click-through BAA.
  - Rough Phase C database cost: Neon Scale (usage-based) vs Supabase about $950+/mo.
- Decision pending (Sam): stay on Neon or switch to Supabase. Claude's recommendation: stay on Neon; revisit only if bundled Supabase Auth/RLS is wanted.

## Open questions for Sam

- Confirm or edit the stop-and-ask trigger list (ORCHESTRATION.md).
- Which getdesign.md brand for `DESIGN.md`, and is a secondary reference wanted for data-dense screens (report editor, score tables)? Until answered, `DESIGN.md` is a placeholder.
- Remote: GitHub repo name/visibility, and is `gh` authenticated? (**unverified**; not checked.)
- Roles/permission matrix (owner / associate / admin): confirm before auth planning.
- Existing deferred questions in `CLAUDE.md` ("Open questions / decisions deferred") still apply.

## Pre-launch checklist

Single home for anything gated on a later condition. Do not bury these in dated logs.

- [ ] BAA signed with Neon (Business tier) before any real client data.
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

- Review/merge of `chore/workflow-scaffold`.
- Decision on GitHub remote and branch protection for `main`.
- Design reference choice.
