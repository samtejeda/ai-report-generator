ALTER TABLE "reports" ADD COLUMN "status_before_generation" text;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_status_before_generation_valid" CHECK ("reports"."status_before_generation" is null or ("reports"."status" = 'generating' and "reports"."status_before_generation" in ('draft','error','generated')));--> statement-breakpoint

-- Regenerate (feat/status-regenerate). After a report is `generated` it must be able to start
-- generating again: to fill another empty section, and to regenerate a section that has text.
-- Exactly one transition is added to the 0013 table:  generated -> generating.
-- Everything else is unchanged: a finalized report never changes status or closing time again,
-- draft cannot jump to generated, and the error rules are as before. (The same table is
-- lib/reports/status.ts; lib/reports/status.test.ts keeps the two equal.)
--
-- status_before_generation (above) remembers the status a generation claimed the report from, so
-- the NEXT change (not this one) can send a failed or abandoned regenerate back to `generated`
-- instead of `error`. The trigger below sets it when a report enters `generating` and clears it
-- on any other status change, so it can never disagree with the status: the app role needs no
-- UPDATE grant on it (0013's column list stays as it is) and the previous deploy, which neither
-- reads nor writes it, behaves exactly as before.
--
-- Backward-compatible with the previous deploy: the column is nullable with no default, and the
-- old code simply never takes the new step.

CREATE OR REPLACE FUNCTION reports_enforce_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- The closing time of a finalized report is part of the record: it never moves.
  IF OLD.status = 'finalized' AND NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
    RAISE EXCEPTION 'the finalization time of a finalized report cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status, NEW.status) IN (
       ('draft', 'generating'),
       ('generating', 'generated'),
       ('generating', 'error'),
       ('error', 'generating'),
       ('generated', 'generating'),
       ('generated', 'finalized')
     ) THEN
    NEW.status_before_generation := CASE WHEN NEW.status = 'generating' THEN OLD.status ELSE NULL END;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'report status cannot change from % to %', OLD.status, NEW.status
    USING ERRCODE = 'restrict_violation';
END
$$;
