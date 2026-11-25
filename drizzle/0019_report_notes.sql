CREATE TABLE "report_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"content" text NOT NULL,
	"extracted" jsonb,
	"extracted_key" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_notes_org_report_uq" UNIQUE("organization_id","report_id"),
	CONSTRAINT "report_notes_content_cap" CHECK (char_length("report_notes"."content") <= 20000),
	CONSTRAINT "report_notes_extraction_pair" CHECK (("report_notes"."extracted" is null) = ("report_notes"."extracted_key" is null)),
	CONSTRAINT "report_notes_extracted_key_shape" CHECK ("report_notes"."extracted_key" is null or "report_notes"."extracted_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "report_notes_extracted_shape" CHECK ("report_notes"."extracted" is null or (jsonb_typeof("report_notes"."extracted") = 'object' and char_length("report_notes"."extracted"::text) <= 100000))
);
--> statement-breakpoint
ALTER TABLE "report_notes" ADD CONSTRAINT "report_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_notes" ADD CONSTRAINT "report_notes_report_fk" FOREIGN KEY ("organization_id","report_id") REFERENCES "public"."reports"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_notes" ADD CONSTRAINT "report_notes_created_by_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_notes_org_created_by_idx" ON "report_notes" USING btree ("organization_id","created_by_user_id");--> statement-breakpoint

-- Session notes kept per report (feat/report-notes; Sam, 2026-11-25, reversing "notes are never stored").
-- The table above is raw clinical content, so the database holds the rules, not only the app:
--
--   1. Row-level security like every tenant table; app_runtime can read, insert, delete, and update
--      only the text, the extraction, its key and updated_at (never report_id or the author). No
--      TRUNCATE, no other role.
--   2. Changing `content` clears the extraction and its key (trigger): a stale extraction can never be
--      stored next to new text. An update that leaves the text as it was keeps the cache.
--   3. A finalized or soft-deleted report accepts no notes. The insert/update takes a FOR SHARE lock on
--      the report row (like report_versions), so a save and a finalize at the same moment take turns.
--   4. The notes row is deleted in the same transaction in which its report becomes `finalized` or is
--      soft-deleted (trigger on reports), so no code path can finalize and forget. A client purge
--      removes the rows through the report's ON DELETE CASCADE; purge_client() is unchanged. A client
--      that is only soft-deleted keeps its reports' notes until the purge (Sam, 2026-11-25).
--
-- Additive for the previous deploy: a new table nothing reads, and a trigger on reports that finds
-- nothing to delete.

CREATE TRIGGER report_notes_set_updated_at BEFORE UPDATE ON report_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER report_notes_forbid_org_change BEFORE UPDATE ON report_notes FOR EACH ROW EXECUTE FUNCTION forbid_org_change();
--> statement-breakpoint

CREATE FUNCTION report_notes_clear_stale_extraction() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content THEN
    NEW.extracted := NULL;
    NEW.extracted_key := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER report_notes_clear_stale_extraction BEFORE UPDATE OF content ON report_notes
  FOR EACH ROW EXECUTE FUNCTION report_notes_clear_stale_extraction();
--> statement-breakpoint

CREATE FUNCTION report_notes_report_is_open() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  r_status text;
  r_deleted timestamptz;
BEGIN
  SELECT r.status, r.deleted_at INTO r_status, r_deleted
    FROM reports r
    WHERE r.organization_id = NEW.organization_id AND r.id = NEW.report_id
    FOR SHARE;
  IF r_status = 'finalized' OR r_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'a finalized or deleted report keeps no notes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER report_notes_report_is_open BEFORE INSERT OR UPDATE ON report_notes
  FOR EACH ROW EXECUTE FUNCTION report_notes_report_is_open();
--> statement-breakpoint

-- SECURITY DEFINER so the delete does not depend on the caller's grants or policies: it is keyed by the
-- updated report's own organization and id, nothing else.
CREATE FUNCTION reports_delete_notes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM report_notes WHERE organization_id = NEW.organization_id AND report_id = NEW.id;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reports_delete_notes() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER reports_delete_notes AFTER UPDATE OF status, deleted_at ON reports
  FOR EACH ROW
  WHEN ((NEW.status = 'finalized' AND OLD.status IS DISTINCT FROM 'finalized')
     OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL))
  EXECUTE FUNCTION reports_delete_notes();
--> statement-breakpoint

ALTER TABLE "report_notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "report_notes" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
REVOKE ALL ON report_notes FROM PUBLIC, app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON report_notes TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (content, extracted, extracted_key, updated_at) ON report_notes TO app_runtime;
