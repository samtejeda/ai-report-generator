-- Row-level security: the database-level second layer under tenantDb (audit 04 item 1).
--
-- How it works
--   * tenantDb opens a transaction and runs set_config('app.organization_id', <uuid>, true)
--     before any statement. The setting lives only for that transaction.
--   * Every tenant table has a policy that matches organization_id against that setting.
--     No setting (or an empty one) matches nothing, so the system fails closed.
--   * Policies are scoped TO app_runtime, the role feature code uses. The table owner
--     (used for migrations only) is not forced through RLS, so migrations keep working;
--     the app never connects as the owner.
--   * Grants and triggers from 0003 still apply first: a missing privilege (42501) is
--     reported before RLS is consulted, and RLS then limits which rows a granted
--     operation can see or touch.
-- Verified before writing this: a non-owner, non-BYPASSRLS login role on Neon's pooled
-- WebSocket pool honors per-transaction settings, nothing leaks across reused
-- connections, and concurrent mixed-tenant requests stay separated (see PROGRESS.md).

-- 1. The tenant the current transaction was opened for (NULL when unset or empty).
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.organization_id', true), '')::uuid
$$;
--> statement-breakpoint
-- 2. organizations: a tenant sees and updates only its own row (id is the tenant).
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organizations" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("id" = (SELECT app_current_org()))
  WITH CHECK ("id" = (SELECT app_current_org()));
--> statement-breakpoint

-- 3. Every table that carries organization_id. The wrapped SELECT lets Postgres evaluate
-- the setting once per statement instead of once per row.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "users" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "clients" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
ALTER TABLE "client_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "client_history" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
ALTER TABLE "report_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "report_templates" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reports" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
ALTER TABLE "report_sections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "report_sections" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
ALTER TABLE "methodology_prompts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "methodology_prompts" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
ALTER TABLE "report_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "report_versions" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
ALTER TABLE "rag_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "rag_documents" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
ALTER TABLE "rag_chunks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "rag_chunks" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
ALTER TABLE "rag_embeddings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "rag_embeddings" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "jobs" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_log" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint

-- 4. purge_client(): same body as 0003, plus the tenant guard described above.
-- NOT wired to any route. Running it on real data requires Sam's explicit approval.
CREATE OR REPLACE FUNCTION purge_client(p_org uuid, p_client uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n_history int; n_reports int; n_sections int; n_versions int;
  n_documents int; n_chunks int; n_embeddings int; n_jobs int;
BEGIN
  -- This function runs as the table owner (SECURITY DEFINER), who is not bound by the
  -- policies, so the tenant is enforced here: the organization argument must be the one
  -- the caller's transaction was opened for (tenantDb sets app.organization_id). Without
  -- this, any caller could name another organization.
  IF p_org IS DISTINCT FROM app_current_org() THEN
    RAISE EXCEPTION 'purge_client: organization does not match the session tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM clients WHERE organization_id = p_org AND id = p_client) THEN
    RAISE EXCEPTION 'client not found in organization' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT count(*) INTO n_history FROM client_history WHERE organization_id = p_org AND client_id = p_client;
  SELECT count(*) INTO n_reports FROM reports WHERE organization_id = p_org AND client_id = p_client;
  SELECT count(*) INTO n_sections FROM report_sections s
    WHERE s.organization_id = p_org
      AND s.report_id IN (SELECT id FROM reports WHERE organization_id = p_org AND client_id = p_client);
  SELECT count(*) INTO n_versions FROM report_versions v
    WHERE v.organization_id = p_org
      AND v.report_id IN (SELECT id FROM reports WHERE organization_id = p_org AND client_id = p_client);
  SELECT count(*) INTO n_documents FROM rag_documents WHERE organization_id = p_org AND client_id = p_client;
  SELECT count(*) INTO n_chunks FROM rag_chunks c
    WHERE c.organization_id = p_org
      AND c.document_id IN (SELECT id FROM rag_documents WHERE organization_id = p_org AND client_id = p_client);
  SELECT count(*) INTO n_embeddings FROM rag_embeddings e
    WHERE e.organization_id = p_org
      AND e.chunk_id IN (
        SELECT c.id FROM rag_chunks c
        WHERE c.organization_id = p_org
          AND c.document_id IN (SELECT id FROM rag_documents WHERE organization_id = p_org AND client_id = p_client));

  PERFORM set_config('app.purge', 'on', true);

  -- Another client's history entry may link to one of this client's reports.
  UPDATE client_history SET report_id = NULL
    WHERE organization_id = p_org AND client_id <> p_client
      AND report_id IN (SELECT id FROM reports WHERE organization_id = p_org AND client_id = p_client);

  DELETE FROM jobs
    WHERE organization_id = p_org
      AND ((resource_type = 'client' AND resource_id = p_client)
        OR (resource_type = 'report'
            AND resource_id IN (SELECT id FROM reports WHERE organization_id = p_org AND client_id = p_client)));
  GET DIAGNOSTICS n_jobs = ROW_COUNT;

  DELETE FROM clients WHERE organization_id = p_org AND id = p_client;

  PERFORM set_config('app.purge', 'off', true);

  RETURN jsonb_build_object(
    'client_history', n_history, 'reports', n_reports, 'report_sections', n_sections,
    'report_versions', n_versions, 'rag_documents', n_documents, 'rag_chunks', n_chunks,
    'rag_embeddings', n_embeddings, 'jobs', n_jobs, 'clients', 1);
END;
$$;
