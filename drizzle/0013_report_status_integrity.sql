-- Report shell (feat/report-shell): the database holds the rules the app promises.
--
--   1. A report's status can only move along the transitions below. In particular a report
--      becomes `finalized` only from `generated`, and a finalized report never changes status
--      again. (The same table is lib/reports/status.ts; a test keeps the two equal.)
--   2. A finalized report gets no new section versions. The trigger takes a FOR SHARE lock on
--      the report row, so an edit and a finalize that happen at the same moment take turns:
--      whichever commits second sees the other's result.
--   3. Least privilege: app_runtime may change only status, finalized_at, deleted_at and
--      updated_at on reports, and only updated_at on report_sections. It can no longer re-point
--      a report at another client, template or prompt version, or rename a section.
--
-- Additive for the previous deploy: nothing it does writes any of the columns that lose UPDATE.

CREATE OR REPLACE FUNCTION reports_enforce_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status, NEW.status) IN (
       ('draft', 'generating'),
       ('generating', 'generated'),
       ('generating', 'error'),
       ('error', 'generating'),
       ('generated', 'finalized')
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'report status cannot change from % to %', OLD.status, NEW.status
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER reports_enforce_status BEFORE UPDATE OF status ON reports
  FOR EACH ROW EXECUTE FUNCTION reports_enforce_status();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION report_versions_report_not_finalized() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  current_status text;
BEGIN
  SELECT r.status INTO current_status
    FROM reports r
    WHERE r.organization_id = NEW.organization_id AND r.id = NEW.report_id
    FOR SHARE;
  IF current_status = 'finalized' THEN
    RAISE EXCEPTION 'a finalized report accepts no new versions'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER report_versions_report_not_finalized BEFORE INSERT ON report_versions
  FOR EACH ROW EXECUTE FUNCTION report_versions_report_not_finalized();
--> statement-breakpoint

REVOKE UPDATE ON reports FROM app_runtime;
--> statement-breakpoint
GRANT UPDATE (status, finalized_at, deleted_at, updated_at) ON reports TO app_runtime;
--> statement-breakpoint
REVOKE UPDATE ON report_sections FROM app_runtime;
--> statement-breakpoint
GRANT UPDATE (updated_at) ON report_sections TO app_runtime;
