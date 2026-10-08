# Audit: Inference and Methodology Pipeline

**Owning agent:** `inference-builder`

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions. It was added after the original 13 when the `inference-builder` agent was split out of `backend-builder`.

For each item, tell me pass or fail with a specific example.

1. All inference goes through `lib/ai/inference.ts`, with a `mode` parameter (`stub` / `real`) toggled by env var; stub mode works on the dev laptop with `qwen3:1.7b`.
2. Model IDs live only in `lib/ai/models.ts`; per-tenant overrides come from the organization row (`inference_endpoint`, `model_config`). No model ID is hardcoded in feature code.
3. No silent cloud LLM fallback anywhere; an unreachable or failing endpoint returns a clear error.
4. The methodology prompt is loaded from `methodology_prompts` (active version for the template), never hardcoded in TS; each generation records the `methodology_prompt_id` used.
5. The final prompt keeps the stable methodology block separate from the per-request context (retrieved examples, extracted fields, client history).
6. Each model is scoped to one job (filter, extract, generate); steps are sequential narrow passes, not one large prompt.
7. SLM output is parsed and validated against the per-section schema (`{content, flags}`); malformed output is retried or surfaced, never passed through unchecked.
8. Insufficient input produces `[Please provide]` and an `insufficient_input` flag instead of invented details; verified with a test case that omits required input.
9. RAG: embeddings come from a local model (no cloud embedding API), retrieval is scoped by `organization_id`, and only relevant chunks are injected.
10. Generation events (model, tokens, latency) are recorded in `llm_metadata` and the audit log, with no PHI content; per-organization concurrency cap is respected.
11. Prompt-regression cases exist for methodology changes (synthetic inputs only), and every prompt change is a new `methodology_prompts` row with notes.

Give me an overall score out of 11 and list the top 3 things to fix first.
