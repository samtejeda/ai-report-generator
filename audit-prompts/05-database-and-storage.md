# Audit: Database and Storage

**Owning agent:** `database-builder`

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. Sensible schema, types, required fields, and naming (snake_case columns, UUID primary keys, `organization_id`, `created_at`, `updated_at`, `deleted_at` where applicable).
2. Foreign keys with defined delete behavior, including how hard deletion propagates to report versions, RAG chunks/embeddings, and other derived data.
3. Unique constraints wherever duplicates are wrong (for example one active methodology prompt per template).
4. Indexes on searched/filtered columns, including `(organization_id, ...)` access paths, the `audit_log` composite index, and the pgvector index.
5. Files and exports live in object storage or are generated on demand, not stored as blobs in Postgres.
6. Automated backups with a tested restore (Neon PITR/branch restore drilled once; recorded in `docs/RUNBOOK.md`).
7. (Added) Immutability: `methodology_prompts` rows are never updated in place and `report_versions` rows are insert-only.
8. (Added) Versioned Drizzle migrations only; no `db push`; the app uses the pooled Neon connection string.

Give me an overall score out of 8 and list the top 3 things to fix first.
