# ORCHESTRATION.md

How work gets done on this project. Read before starting any session.

## Before anything else (every new session)

1. Inventory what actually exists: `git log --oneline -20`, the directory tree, what runs versus what is stubbed.
2. Read `CLAUDE.md` and reconcile it with reality; fix stale parts.
3. Read `PROGRESS.md` (create it if absent).
4. Don't trust a doc over the code.

## Mission and priority order

Build in this order so the most valuable pieces land first if time or credits run out:

1. **Data model** (organizations, users, clients, templates, methodology_prompts, reports, report_versions, report_sections, audit_log) as Drizzle migrations.
2. **Auth and roles** with route-level protection, multi-tenant from the start.
3. **Core CRUD** of the main entities (organizations, users, clients) plus the report shell and versioning.
4. **Secondary features**: dev-stub inference loop, section edit/regenerate, three-pass pipeline, RAG, export. Then hardening (rate limits, access policies) on what exists.
5. **Polish and styling** last.

Phases A/B/C in `CLAUDE.md` still govern data: synthetic data only until Phase C.

## Working method rules

- **Plan Mode for any new feature area.** Approval is for the plan, not every file.
- **Auto mode for implementation** once a plan is approved. If it falls back to manual approval after repeated blocks, treat that as a signal to look closer, not friction to route around.
- **Never commit to `main`, ever,** from any agent or from Sam's own sessions. Each piece of work gets `git checkout -b <type>/<slug>` (`feat/`, `fix/`, `chore/`, `docs/`) and lands via PR. One logical change per branch. Parallel work uses git worktrees, which branch automatically. Stop and tell Sam the branch is ready; never self-merge unless Sam says so in that turn.
- **Commit after every coherent chunk**, small and described by why. Commits are rollback points and Sam's review surface.
- **Update `PROGRESS.md`** after every commit or milestone.
- **Adding a dependency is a decision, not a convenience.** Before adding any npm package, check on the registry: weekly downloads, maintainers (any recent change), install scripts, last publish date, and how many packages it pulls in. Prefer existing dependencies or a few lines of code. State the checks in the PR description. A package with fewer than 100 weekly downloads, an unexpected install script, or a name close to a popular package is a stop-and-ask item. See `audit-prompts/15-supply-chain.md`.
- **Two-pass UI:** the feature pass ships a plain, unstyled-but-functional UI so the flow can be verified. A separate restyle pass applies `DESIGN.md` afterward. Don't mix them in one PR.
- **Stop and ask Sam directly (don't guess)** for each of:
  - Anything that would put real client data, real names of children, or PHI into any system, fixture, log, prompt, or env (synthetic only until Phase C).
  - Retention, deletion, or handling rules for minors' data.
  - HIPAA / FERPA / BAA / contract / consent wording, or anything the privacy lawyer should review.
  - Clinical or methodology content: methodology prompt text, diagnostic or interpretive language, recommendation wording. This is the practice owner's domain expertise.
  - Any cloud LLM call or fallback for report generation (explicit anti-recommendation in `CLAUDE.md`).
  - Exposing the inference endpoint publicly (for example Tailscale Funnel) or changing a real tenant's `inference_endpoint` / `model_config`.
  - Destructive or hard-to-reverse actions: dropping tables, touching `audit_log` rows, hard-delete flows, force-push, history rewrites.
  - Adding any paid service or integration not in `CLAUDE.md` (including BAA-tier upgrades).
  - Genuinely unsure between two reasonable architectures; any new scope.
- **Security rules in `CLAUDE.md` are non-negotiable** and are not "later" work.

## Model

Pin the model in each agent's frontmatter (`model: sonnet` by default; use the unversioned alias `fable` or `opus` when heavier work is wanted, since dotted version IDs were rejected by one Claude Code build). Switching with `/model` keeps context. `PROGRESS.md` is the fallback if history is lost.

## Agents as builders

Agents build or only review depending on which tools they have. Builders get Read/Write/Edit/Bash/Grep/Glob/AskUserQuestion. Keep a door open for pure audits: before a merge or deploy, invoke the same agent with "review only, don't change anything, just report."

## Running agents

- In-session delegation ("use the backend-builder agent to build X") for work tied to the current session.
- `claude --agent <name>` for a dedicated terminal.
- Concurrent agents in the same directory collide: give each its own worktree (`git worktree add ../ai-report-generator-<name> feat/<name>`), or run one at a time.
- Don't use experimental Agent Teams until worktrees feel routine.

## Self-check loop (every build agent)

Build the next item from `PROGRESS.md` "Next up" -> re-read the owned audit-prompt file(s) fresh from disk -> score every item pass/fail with evidence -> record failures you couldn't close in `PROGRESS.md` -> commit. Repeat after every chunk of work in the domain, not just the first time.

## Note on AI/inference work

`inference-builder` owns `lib/ai/*` (stub/real modes, models.ts, pipeline, RAG retrieval, methodology prompt loader) and is audited by `audit-prompts/14-inference-and-methodology.md`. `backend-builder` owns the route handlers that call it, only through `lib/ai/inference.ts`; `database-builder` owns the schema. Methodology prompt *content* is always a stop-and-ask item for the practice owner's input.
