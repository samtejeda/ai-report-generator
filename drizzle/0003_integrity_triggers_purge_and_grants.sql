-- Data integrity that Drizzle's schema DSL cannot express:
--   1. updated_at maintenance
--   2. tenant column is immutable once a row exists
--   3. immutability / append-only for methodology_prompts, report_versions, audit_log
--   4. purge_client(): the ONLY path to a hard delete of client data
--   5. app_runtime role and least-privilege grants
-- Written by hand (drizzle-kit generate --custom). Contains no passwords and no data.

-- 1. updated_at ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organizations_set_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER clients_set_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER client_history_set_updated_at BEFORE UPDATE ON client_history FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER report_templates_set_updated_at BEFORE UPDATE ON report_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER reports_set_updated_at BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER report_sections_set_updated_at BEFORE UPDATE ON report_sections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER rag_documents_set_updated_at BEFORE UPDATE ON rag_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER jobs_set_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- 2. organization_id can never change on an existing row -----------------------------
CREATE OR REPLACE FUNCTION forbid_org_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'organization_id is immutable on %', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_forbid_org_change BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION forbid_org_change();
--> statement-breakpoint
CREATE TRIGGER clients_forbid_org_change BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION forbid_org_change();
--> statement-breakpoint
CREATE TRIGGER client_history_forbid_org_change BEFORE UPDATE ON client_history FOR EACH ROW EXECUTE FUNCTION forbid_org_change();
--> statement-breakpoint
CREATE TRIGGER report_templates_forbid_org_change BEFORE UPDATE ON report_templates FOR EACH ROW EXECUTE FUNCTION forbid_org_change();
--> statement-breakpoint
CREATE TRIGGER reports_forbid_org_change BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION forbid_org_change();
--> statement-breakpoint
CREATE TRIGGER report_sections_forbid_org_change BEFORE UPDATE ON report_sections FOR EACH ROW EXECUTE FUNCTION forbid_org_change();
--> statement-breakpoint
CREATE TRIGGER rag_documents_forbid_org_change BEFORE UPDATE ON rag_documents FOR EACH ROW EXECUTE FUNCTION forbid_org_change();
--> statement-breakpoint
CREATE TRIGGER jobs_forbid_org_change BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION forbid_org_change();
--> statement-breakpoint

-- 3. immutability and append-only ----------------------------------------------------
-- These fire for every role, including the table owner.
CREATE OR REPLACE FUNCTION forbid_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: rows are never updated', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
-- Never deletable (methodology_prompts, audit_log).
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows are never deleted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
-- Deletable only inside purge_client() (hard-deletion request). Row triggers also fire
-- for FK cascades, which would otherwise bypass table privileges.
CREATE OR REPLACE FUNCTION forbid_delete_unless_purge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.purge', true), 'off') <> 'on' THEN
    RAISE EXCEPTION '% is insert-only: rows are deleted only by purge_client()', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forbid_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE is not allowed on %', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER methodology_prompts_no_update BEFORE UPDATE ON methodology_prompts FOR EACH ROW EXECUTE FUNCTION forbid_update();
--> statement-breakpoint
CREATE TRIGGER methodology_prompts_no_delete BEFORE DELETE ON methodology_prompts FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER methodology_prompts_no_truncate BEFORE TRUNCATE ON methodology_prompts FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
--> statement-breakpoint
CREATE TRIGGER report_versions_no_update BEFORE UPDATE ON report_versions FOR EACH ROW EXECUTE FUNCTION forbid_update();
--> statement-breakpoint
CREATE TRIGGER report_versions_no_delete BEFORE DELETE ON report_versions FOR EACH ROW EXECUTE FUNCTION forbid_delete_unless_purge();
--> statement-breakpoint
CREATE TRIGGER report_versions_no_truncate BEFORE TRUNCATE ON report_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_update();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
--> statement-breakpoint

-- 4. Hard deletion of a client and everything derived from it --------------------------
-- Cascades (FKs) remove client_history, reports, report_sections, report_versions,
-- rag_documents, rag_chunks and rag_embeddings. Jobs have no FK, so they are deleted
-- here. audit_log is deliberately untouched (no FKs, UUIDs only, retention is policy).
-- Returns per-table row counts and no content, so the caller can write the audit event.
-- NOT wired to any route. Running it on real data requires Sam's explicit approval.
CREATE OR REPLACE FUNCTION purge_client(p_org uuid, p_client uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n_history int; n_reports int; n_sections int; n_versions int;
  n_documents int; n_chunks int; n_embeddings int; n_jobs int;
BEGIN
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_client(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

-- 5. Runtime role and grants -----------------------------------------------------------
-- app_runtime is a NOLOGIN group role. The login role the app connects as is created
-- out-of-band with a generated password (never in a migration or the repo) and made a
-- member: CREATE ROLE <login> LOGIN PASSWORD '...' IN ROLE app_runtime; (see RUNBOOK).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_runtime;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_runtime;
--> statement-breakpoint
-- Explicit per-table grants (no default privileges): a new table gets nothing until a
-- migration grants it on purpose. No role gets DELETE on a clinical table; hard deletes
-- go through purge_client().
GRANT SELECT, UPDATE ON organizations TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON users, clients, client_history, report_templates, reports, report_sections TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON methodology_prompts, report_versions, audit_log TO app_runtime;
--> statement-breakpoint
-- Derived / regenerable data: re-indexing replaces chunks and vectors.
GRANT SELECT, INSERT, UPDATE, DELETE ON rag_documents, jobs TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON rag_chunks, rag_embeddings TO app_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_client(uuid, uuid) TO app_runtime;
