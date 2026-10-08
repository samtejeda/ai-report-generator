# RUNBOOK.md

Step-by-step failure recovery. Stub for now; fill each section as the infrastructure lands, and record the date it was last drilled. Anything not yet drilled is **unverified**.

## Rollback a bad deploy

_TODO when Vercel is connected._ Expected: promote the previous Vercel deployment (or `vercel rollback`), then revert the PR on a `fix/` branch. Rollback reverts code, not schema; migrations are forward-only and backward-compatible with the previous deploy.

## Database restore (Neon)

_TODO._ Expected: Neon point-in-time restore / branch from a timestamp, validate, repoint the pooled connection string. Last drilled: never (**unverified**).

## Backup drill

_TODO._ Perform a restore into a Neon branch once, record the date and result here before Phase C.

## Inference endpoint down (Ollama / tunnel)

_TODO._ Expected: the health endpoint reports the org's endpoint as unavailable; generation returns a clear error; **no silent cloud LLM fallback**. Steps: check Ollama on the host, check Tailscale status, check endpoint registered on the organization record.

## Failed migration

_TODO._ Expected: stop deploys, restore from Neon branch/PITR if data was affected, ship a forward-fix migration.

## Leaked secret

_TODO._ Expected: rotate the secret in the provider, update Vercel env, redeploy, scan git history, record in PROGRESS.md.

## Suspected PHI exposure

_TODO._ Escalate to Sam immediately; this is a stop-and-ask item and likely a legal/BAA matter.
