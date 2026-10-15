# CLAUDE.md

Project context for Claude Code. Read this before suggesting code changes.

## What this project is

A multi-tenant SaaS tool that helps school psychologists in private practice generate structured client reports (psychoeducational evaluations as the v1 focus) from their session notes and test data, using a locally-hosted small language model (SLM) for inference, with strict methodology guardrails.

This is a real product with real business intent — not a portfolio piece. The first and currently only tenant is the practice owner (a school psychologist). Architecture is "enterprise SaaS shape with one user today," designed so that onboarding tenant #2 requires no architectural rewrite.

**Core value prop:** school psychologists spend hours on structured report writing; this tool turns that into minutes of editing, while preserving professional judgment, following a specific methodology, and keeping client data in a privacy-preserving architecture.

## Product principles

- **The psychologist is responsible for all clinical judgment and legal content.** The tool helps articulate and structure, never decides.
- **Refusal and uncertainty are features.** The tool flags missing input and refuses to invent details. "[Please provide]" always beats hallucination — especially given these reports feed decisions about children's educational placement.
- **Strengths-based, person-first, non-stigmatizing language.** Default LLM/SLM output skews clinical-pathologizing; the methodology prompt and RAG context actively pull it back.
- **Editability is core UX.** Every section has its own edit and regenerate affordances.
- **The methodology prompt is the actual product IP.** Treat it accordingly — versioned, retrievable, iterated on intensively.
- **Enterprise shape, one user today.** Build multi-tenancy, auth, audit, versioning as if tenant #2 arrives tomorrow. Exercise it on tenant #1 (the practice owner) throughout development.

## Architecture overview

**Cloud layer (standard SaaS):**
- Next.js 16 frontend + backend (API routes, business logic, orchestration)
- Postgres on Neon (data, auth, methodology prompts, reports, audit logs, pgvector for RAG)
- Hosted on Vercel

**Local layer (one service, on the tenant's hardware):**
- Ollama running the SLM stack (filter / worker / heavy models)
- Reached by the cloud backend over a Tailscale (or Cloudflare Tunnel) encrypted tunnel
- Each tenant has their own local SLM endpoint registered on their organization record

**Request flow:**
browser → Next.js frontend → Next.js backend → per-tenant inference endpoint (over tunnel) → local Ollama → response → backend stores and returns → frontend renders.

**Why this shape:**
- All SaaS primitives (accounts, auth, billing, admin, audit) live in the cloud layer where they belong
- Inference stays on hardware the tenant controls — strong privacy story and no per-token API cost
- Swapping local SLM for cloud LLM (or vice versa) is a config change on the organization record, not a rewrite

## Three futures the architecture supports

1. **Stays small (free-software path):** package the local SLM service as a standalone installer; the cloud SaaS keeps working for individual users running their own box. This is the strategic backstop if scale doesn't materialize — "a useful free tool for the owner and his colleagues."
2. **Grows via SLM:** new tenants provision their own local SLM box; cloud backend routes per-tenant to the right endpoint. Each tenant's inference cost is their hardware; the SaaS layer scales with ordinary web infrastructure.
3. **Grows fast (LLM path):** flip tenants over to a cloud LLM endpoint by changing the inference endpoint config on the organization record. Faster to onboard, higher per-request cost, but easier to scale operationally. Same backend code throughout.

The per-organization `inference_endpoint` + `model_config` pattern is what makes all three futures reachable without a rewrite.

## Tech stack

- **Framework:** Next.js 16 (App Router, Turbopack default), TypeScript end-to-end. Node.js 22+.
- **Styling:** Tailwind + shadcn/ui
- **Database:** Postgres on Neon (use the *pooled* connection string from Next.js). pgvector extension for RAG embeddings.
- **ORM:** Drizzle, with Drizzle migrations from day one — no auto-sync schemas
- **Auth:** NextAuth/Auth.js (or Clerk if we hit friction). Multi-tenant from the start.
- **Inference:** Ollama (OpenAI-compatible API at `http://host:11434/v1`) on the tenant's hardware
- **Tunnel:** Tailscale (free tier for personal use; stable URLs via Funnel for the backend-to-Ollama path)
- **AI SDK:** Vercel AI SDK for streaming (works with Ollama's OpenAI-compatible endpoint)
- **Email:** Resend (transactional only)
- **Hosting:** Vercel for app, Neon for DB. BAA-tier upgrade required before handling real client data.

## Development phases (laptop + inference evolution)

**Phase A — Dev stub on Sam's 8 GB RAM laptop (now):**
- Build the full stack with a tiny SLM as a stub for integration testing
- Model: `qwen3:1.7b` at Q4 (~1.5-2 GB RAM), or `gemma3:1b` if tighter
- Ollama runs on the host OS, not in Docker (Docker space is limited to 8 GB; Ollama models live in `~/.ollama/models` on the system drive)
- Purpose: exercise the end-to-end path (UI → cloud backend → tunnel → local SLM → DB → UI). Response quality does not matter in this phase.

**Phase B — Dedicated inference machine (next):**
- A machine (likely the practice owner's) whose purpose is running the real SLM stack
- Model: `qwen3:8b` at Q4 as the worker (~6 GB RAM), with the full three-pass ladder when needed
- Methodology prompt iteration begins here with real synthetic test cases
- Same cloud backend; only the tenant's `inference_endpoint` and `model_config` change

**Phase C — Production for one tenant:**
- Full three-pass ladder + RAG + iterated methodology prompt
- BAA-tier Neon and Vercel in place
- Real (not synthetic) client data flows through the system

## LLM/SLM: model selection

**All inference is local SLM via Ollama** on the tenant's hardware. The cloud backend never calls a cloud LLM for report generation.

**Dev-stub phase (Sam's laptop):**
- `qwen3:1.7b` (Q4) — primary dev stub; coherent short responses, Spanish+English, ~1.5-2 GB RAM
- `gemma3:1b` (Q4) as fallback if memory is tight

**Production SLM ladder (per the project's SLM spec):**
1. **Filter model** (`qwen3:1.7b` or `gemma3:4b`, Q4): classifies incoming input (which template applies, is input sufficient, flags sensitive content). Milliseconds.
2. **Worker model** (`qwen3:8b`, Q4): handles 90%+ of cases. Extracts structured fields and generates report sections from methodology + RAG context.
3. **Heavy model** (`Qwen3 30B-A3B` MoE, Q4): escalation for edge cases only. MoE gives "memory of a 30B, speed of a 3B."

**Why qwen3:8b as the worker:**
- Strong Spanish and English (important for RI practice context)
- Right size for the sweet-spot (16 GB RAM machine, 6 GB model + context)
- Clean fit for LoRA fine-tuning once methodology stabilizes and real counselor-edited reports accumulate as training data
- Consistent, predictable output — exactly what a methodology-driven product needs

**Design-constraints from SLM-first (handle these in architecture, not by escalating to cloud):**
- Scope each model to one job (don't make the worker also classify)
- Knowledge gaps: inject via RAG, not model memory (methodology, examples, prior sessions)
- Weaker multi-step reasoning: split into sequential narrow prompts/passes
- Long contexts degrade small models: chunk inputs, retrieve only what's relevant
- Hard cases: step up the local ladder (worker → heavy), never out to cloud

**Explicit anti-recommendation: do NOT add a silent cloud LLM fallback.** A fallback that fires 2% of the time is 100% of the compliance burden triggered 2% of the time. It also masks SLM failures that should drive customization-ladder improvements (prompt → few-shot → RAG → LoRA). The cloud-LLM future is a deliberate configuration switch per tenant, not an invisible failover.

**Model config lives in one place:** `lib/ai/models.ts` holds model string constants. Never hardcode model IDs in feature code. Per-tenant overrides live on the organization row.

## LLM call architecture

**v1: synchronous.** Backend route receives input, calls the tenant's local SLM over the tunnel, returns the response. Fast enough with local inference (~1-5s per section) that async isn't needed yet.

**v2 (when needed): async via `jobs` table.** Only add when sync timing hurts.

**Three-pass pipeline (Phase B+):**
1. Filter — classify template, check input sufficiency, flag sensitive content
2. Extract — pull structured fields from raw notes (observations, test scores, quotes, family context)
3. Generate — write prose sections using methodology prompt + RAG + extracted structured data

**Dev-stub mode (Phase A):** the inference wrapper (`lib/ai/inference.ts`) exposes a `mode` parameter. `stub` runs the tiny model with a single trivial prompt; `real` runs the full pipeline. Env-var toggled. Lets Sam develop features that need "an LLM response" on his laptop without running the full stack.

**Streaming:** Vercel AI SDK over Ollama's OpenAI-compatible streaming endpoint. UX needs it even when local inference is fast — perceived responsiveness.

## RAG (promoted to v1 architecture)

Because SLMs are small, we inject knowledge via RAG rather than relying on model memory. Stored in pgvector on Neon.

**What's indexed:**
- The methodology document (chunked by section)
- Example report input/output pairs
- Per-client prior session notes and prior reports (for continuity across evaluations)
- Any regulation references the methodology relies on (IDEA requirements, state special-ed regs)

**What's retrieved per generation:**
- The relevant methodology sections for the report type being generated
- 2-3 most similar historical examples
- Prior reports/sessions for the same client, if any
- Regulation snippets if the section requires them

**Embeddings:** start with a small local embedding model via Ollama (nomic-embed-text) or an open embedding model — do not call a cloud embedding API.

## Data model

Tenant hierarchy: **Organization (practice) → Users (psychologists, staff) → Clients → Reports**.

All domain tables include `organization_id`, `created_at`, `updated_at`, and `deleted_at` (where applicable).

- **organizations** — the practice. Fields: name, type, state, inference_endpoint, model_config (JSON), data_retention_days, baa_signed_at. v1: exactly one row.
- **users** — practice owner / associate / admin roles. Belong to one organization. `password_hash` (bcrypt).
- **clients** — the children/clients being evaluated. `external_id` optional (if the practice has their own ID system). Minimum PII required.
- **client_history** — longitudinal threads per client: prior evaluations, re-eval cadence (IDEA requires 3-year re-evals), notes between sessions.
- **report_templates** — section structure as `jsonb`. `active_methodology_prompt_id` points at the one active prompt version (composite FK keeps it within the same template and org). v1 scope: psychoeducational evaluation template.
- **methodology_prompts** — *immutable*, versioned. New version = new row; never updated or deleted (DB triggers + grants). Activating a version moves the template's `active_methodology_prompt_id` pointer, so exactly one is active per template. Tracks `created_by` and change `notes`.
- **reports** — references `methodology_prompt_id`, `template_id`, `client_id`. Status: draft | generating | generated | finalized | error.
- **report_versions** — one row per section edit, insert-only (DB triggers + grants); the current text of a section is its highest `version_number`. `edit_type`: `ai_generated` | `human_edit` | `ai_regenerated_section`. `llm_metadata` for model/tokens/latency/cost (zero cost for SLM, but still useful for debugging).
- **report_sections** — stable identity of a section within a report (`section_key`, `section_type` prose | structured, `position`). Content lives in `report_versions.content` (`jsonb`, shape chosen by `section_type`).
- **rag_documents** / **rag_chunks** / **rag_embeddings** — pgvector-backed. Scoped by organization.
- **audit_log** — append-only (the app role has SELECT/INSERT only; triggers block UPDATE/DELETE/TRUNCATE for everyone). No foreign keys, so purges never touch it. Indexes on `(organization_id, resource_type, resource_id, created_at)`.
- **jobs** — for async work when we need it. Not used in v1.

UUIDs throughout, not auto-incrementing integers.

## Methodology prompt structure

Every methodology prompt has these sections:

1. **Role and context** — psychologist is the professional, SLM is the articulation tool.
2. **Methodology** — the practice owner's actual framework for the report type. For psychoeducational evaluations: how observations are structured, how test scores are interpreted, what language conventions apply, what frameworks are used (e.g., CHC theory for cognitive assessment).
3. **Report structure** — section-by-section guidance. For a psychoed eval: Reason for Referral, Background Information, Behavioral Observations, Assessment Results (per instrument), Summary and Impressions, Recommendations.
4. **Constraints and prohibitions** — never invent details; never assign diagnoses the psychologist didn't; never recommend medications; never use stigmatizing terms; flag missing input rather than guessing; mark uncertain interpretations clearly.
5. **Output format** — JSON with one key per section. Each section is `{content, flags}` where `flags` includes `insufficient_input`, `sensitive_content_detected`, `low_confidence_interpretation`, etc.
6. **Examples** — two or three full input → output examples. Highest-leverage part of the prompt for an SLM.

Iteration workflow: practice owner provides 5–10 hand-written reports + corresponding inputs (synthetic or de-identified). Reverse-engineer the prompt from those pairs, generate, compare, mark up, iterate. Expect 50–100 rounds before quality is real.

Every prompt change is a new `methodology_prompts` row with notes on what changed and why.

**Structure the prompt + RAG for stability:** the methodology block is stable (versioned, rarely changed); the per-request context (retrieved examples, extracted fields, client history) changes each call. Keep them in separate sections of the final prompt sent to the SLM.

## Compliance posture

**Primary framework: HIPAA.** The practice is a HIPAA covered entity if the psychologist bills insurance electronically (defaulting to "yes" unless confirmed otherwise). This project is a Business Associate.

**Secondary framework: FERPA.** Some records may also be education records when they go back to schools (e.g., IEEs that end up in a student's cumulative file). HIPAA posture is stricter and covers both — build to HIPAA.

**Hard rules:**
- Phase A/B development uses synthetic data only. No real client data flows through the system until Phase C with BAAs in place.
- Before Phase C: BAA signed with Neon (Business tier), Vercel (Enterprise tier), and any other vendor touching PHI. Local SLM dissolves the Ollama/cloud-model subprocessor chain, which is a win.
- Per-organization data isolation enforced at the data layer. Every query filters by `organization_id`, and Postgres row-level security is the second layer underneath.
- Encryption at rest (Neon handles) and in transit (HTTPS everywhere, Tailscale tunnel for backend ↔ SLM is encrypted).
- Hard deletion on request, propagated to all derived data (report versions, RAG embeddings, audit log retention per policy).
- Scrub PHI from error tracking (Sentry config matters — no full request bodies).
- Audit log retention per HIPAA (6 years minimum for most records).
- Get a healthcare-privacy-specialized lawyer to review the first client contract and BAA before Phase C.

**Explicit non-goal:** this product does not try to be HITRUST-certified or SOC2-certified at v1. Those come when enterprise sales demand them.

## Audit logging

Application-level, written explicitly by route handlers. Not an ORM hook or DB trigger.

**Log:**
- Auth events (login, logout, failed login, password change)
- Sensitive reads (viewing client record, viewing report)
- All writes on clients/reports/users/templates
- Exports (PDF/DOCX downloads)
- Admin actions
- SLM generation events (model, tokens, latency — cost is zero but keep the field for consistency)

**Don't log:**
- Client PHI content inside the audit log itself
- Passwords, tokens, API keys (no full request bodies)
- Health-check noise

**Implementation:** small `lib/audit.ts` helper. Called explicitly from each route handler. Append-only at the DB permission level. Audit failure logs to Sentry but doesn't block user action (except deletes — TBD).

## Development sequence

1. **Weeks 1–2 (Phase A on laptop):** Scaffold Next.js 16 + Tailwind + shadcn/ui + Drizzle + Neon. Wire up `qwen3:1.7b` via Ollama on the host. Build the end-to-end dev-stub loop — form → backend → local SLM → DB → UI. Response quality is irrelevant; the plumbing is the point.
2. **Weeks 3–4:** Auth (multi-tenant from the start), org/user/client CRUD, basic report shell, versioning. Still Phase A. Still synthetic data.
3. **Weeks 5–6 (Phase B begins):** Practice owner's inference machine comes online. Swap model config to `qwen3:8b`. Begin methodology prompt iteration with practice owner on psychoeducational evaluation template.
4. **Weeks 7–8:** Three-pass pipeline + RAG for methodology injection. Section-by-section edit, regenerate-this-section, version history, PDF/DOCX export.
5. **Weeks 9–10:** Polish, add Tailscale tunnel for cloud→local path, deploy cloud to Vercel/Neon (standard tier, synthetic data only). Practice owner uses it for real work with synthetic cases.
6. **Later (Phase C):** BAA tier upgrades, lawyer review of contracts, then real client data.

## Roles and authorization

Roles (on `users`): **owner** (practice owner, full access in their organization), **associate** (psychologist, access to assigned clients/reports), **admin** (staff, practice administration, no clinical content unless granted). Exact permission matrix is a Plan Mode item before auth is built.

**All permission checks happen server-side only.** The frontend hides things for UX; it never enforces anything.

**Authorization chain (layered gates):**
1. Edge/proxy check (Next.js `proxy`/middleware): redirects unauthenticated users. Convenience only, never the sole gate.
2. Layout-level check: server layout resolves the session and organization; renders nothing for the wrong role.
3. Every page, server action, and route handler re-checks session, role, and organization itself.
4. Data functions enforce ownership inside the query: every query on a multi-tenant table filters by `organization_id` (query-level guard), and by client/report assignment where roles require it.

## API security rules

- Never trust the frontend: re-validate identity, role, organization, and input on the server for every request.
- Broken access control is the top risk: test that user A in org 1 cannot read or write org 2's rows, and that an associate cannot reach clients they aren't assigned.
- Validate the whole business flow, not just single fields (for example, a report can only be finalized from `generated` status).
- Validate responses from external APIs and from the SLM (parse the JSON output against a schema; never pass model output into queries or the DOM unchecked).
- Rate-limit auth endpoints and generation endpoints.
- Server-side input validation (schema validation on every handler).
- Return minimal response data: no password hashes, internal ids you don't need, other tenants' fields.
- SSRF prevention: `inference_endpoint` is set by an admin action only, validated against an allow-list pattern (Tailscale/Cloudflare tunnel hosts), never taken from request input.
- Every route and server action is documented in `API.md`; no orphan test routes.
- No debug mode, default credentials, or verbose error bodies in production.

## Project structure (planned; scaffold not yet created)

```
app/                 Next.js App Router (server components by default)
lib/ai/              models.ts (model IDs), inference.ts (stub/real modes), pipeline, prompts loader
lib/db/              Drizzle schema, migrations, tenant-scoped query helpers
lib/audit.ts         explicit audit log helper
lib/auth/            session, role checks
components/          UI (shadcn/ui based), one component per file
drizzle/             committed migrations
```

## Dev commands

Node >= 22 (developed on Node 24), npm.

- `npm run dev`: dev server on localhost:3000 (Turbopack).
- `npm run lint` / `npm run typecheck` / `npm test`: ESLint, `next typegen && tsc --noEmit`, Vitest (`npm run test:watch` to watch).
- `npm run build` / `npm start`: production build and server.
- Environment: copy `.env.example` to `.env.local` (or run `neon link` against the dev branch). `lib/env.ts` validates it at server start and fails with the variable name, never the value.
- Ollama (host, not Docker): `brew services start ollama`, model `qwen3:1.7b` for the dev stub.
- Database: `npm run db:generate` (new migration from schema changes; `npx drizzle-kit generate --custom --name=<slug>` for hand-written SQL), `npm run db:migrate` (applies to the database in `DATABASE_URL_UNPOOLED`; currently the Neon `dev` branch), `npm run db:check` (migration consistency, no DB connection). Commit the generated files in `drizzle/`. Data access goes through `tenantDb(ctx)` in `lib/db/tenant.ts` (ESLint bans the raw client elsewhere); every call runs in a transaction that sets `app.organization_id`, and Postgres row-level security policies (migration 0004) on every tenant table match against it, so raw SQL without a filter still sees one tenant only and no tenant means no rows. Hard deletion of a client is `purge_client()` only. DB integration tests (`lib/db/integration.test.ts`) run against a scratch Neon branch using `TEST_DATABASE_URL` and `TEST_APP_ROLE_PASSWORD` in the gitignored `.env.test.local`, and skip when those are absent. The app should connect as a login role that is a member of `app_runtime` (see `docs/RUNBOOK.md`).

**Next.js 16 notes:** `AGENTS.md` (written by Next) says this version differs from older training data; read `node_modules/next/dist/docs/` before writing framework code. Cache Components is on, so caching is opt-in via `use cache`. Never use `use cache` on tenant-scoped or PHI data.

## CI and deploy

- CI runs on every PR: lint, typecheck, tests, Drizzle migration check, build.
- `main` is branch-protected on the checks job; merging to `main` deploys to Vercel.
- Migrations are forward-only and backward-compatible with the previous deploy. Rollback reverts code, not schema.
- Standard Vercel/Neon tiers with synthetic data only until Phase C BAA upgrades are done.

## Working method and project docs

- `ORCHESTRATION.md`: how work is done (branches, plan mode, two-pass UI, stop-and-ask triggers).
- `PROGRESS.md`: source of truth for state, decisions, open questions, pre-launch checklist.
- `audit-prompts/`: 15 pass/fail checklists that define done per domain.
- `.claude/agents/`: seven builder agents plus `supervising-agent.md`.
- `design/` and `DESIGN.md`: design system (not yet chosen; see PROGRESS.md).
- `API.md`: inventory of every endpoint and server action.
- `docs/RUNBOOK.md`: failure scenarios, rollback, backup drills.

## Conventions

- **Naming:** snake_case in DB columns, camelCase in TS. Drizzle handles the mapping.
- **Server vs client components:** default to server. Client only when interactivity demands it.
- **Secrets:** environment variables only, never committed. Separate keys per environment.
- **Errors:** structured logging via Sentry, configured to scrub PHI. Application logs ≠ audit logs; keep separate.
- **Migrations:** every schema change is a Drizzle migration committed to the repo. No `db push` against shared databases.
- **Tests:** add when something has been bug-bitten twice or has tricky edge cases (auth, multi-tenancy enforcement, methodology prompt regression, tunnel reconnection). Don't aim for coverage targets early.
- **Model config:** all model IDs in `lib/ai/models.ts`. Per-tenant overrides on the organization row.
- **Terminology:** "client" (not "student" or "patient"). "Practice" (not "school" or "district"). "Psychologist" or "psych" (not "counselor") where it refers to the user role.

## What not to do

- Don't query without `organization_id` filter on multi-tenant tables. Add a query-level guard.
- Don't store client PHI you don't strictly need.
- Don't use the direct (unpooled) Neon connection string in serverless code.
- Don't hardcode the methodology prompt in TS files — it lives in `methodology_prompts` table.
- Don't hardcode model IDs in feature code — they live in `lib/ai/models.ts`.
- Don't overwrite `report_versions` rows; always insert new ones.
- Don't add a silent cloud LLM fallback (see the LLM selection section for why).
- Don't log full request bodies in error tracking.
- Don't run Ollama inside Docker on the dev laptop (host it, Docker space is limited).
- The GitHub repo is public: never commit methodology prompt text, the practice owner's example reports, or any client-derived data. They live in the database and local files only.
- Don't skip the dev-stub mode — Phase A productivity depends on not running real inference for every feature test.
- Don't downgrade multi-tenancy to "one user, we can add org_id later." The "one user today, enterprise shape" principle is load-bearing.

## Open questions / decisions deferred

- NextAuth vs Clerk vs Supabase Auth
- Stripe billing integration timing — not v1
- PDF/DOCX export library choice — pick when export work begins (likely a Node library server-side)
- Tailscale vs Cloudflare Tunnel for the backend-to-SLM path — Tailscale first unless a specific need emerges
- Which embedding model for RAG — start with `nomic-embed-text` via Ollama; validate on real retrieval
- Specific scope confirmation: psychoeducational evaluations as v1 is the default assumption; practice owner may redirect to a different report type
- Confirm the practice bills insurance electronically (confirms HIPAA covered-entity status)
- Phase C hosting migration path if standard Vercel/Neon doesn't support BAA at acceptable cost
