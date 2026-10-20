-- A practice must always keep at least one active owner (feat/auth-admin, user management).
-- The route layer refuses the obvious cases (nobody changes their own role or deactivates
-- themselves, and an admin cannot touch an owner), which already leaves the acting owner in
-- place. This trigger is the backstop for the one case code cannot see: two owners demoting or
-- deactivating each other at the same moment, each checking while the other still looks like an
-- owner. The advisory lock makes those two changes take turns per organization, so the second
-- one sees the first one's result and is refused.
--
-- Runs as the invoking role (not SECURITY DEFINER): app_runtime reads users under its own
-- row-level security, which is the same organization, so the check needs no extra privilege.
CREATE OR REPLACE FUNCTION users_keep_an_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.role = 'owner' AND OLD.deleted_at IS NULL
     AND (NEW.role <> 'owner' OR NEW.deleted_at IS NOT NULL) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('owners:' || OLD.organization_id::text, 0));
    IF NOT EXISTS (
      SELECT 1 FROM users u
      WHERE u.organization_id = OLD.organization_id
        AND u.id <> OLD.id
        AND u.role = 'owner'
        AND u.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'an organization must keep at least one active owner'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER users_keep_an_owner BEFORE UPDATE OF role, deleted_at ON users
  FOR EACH ROW EXECUTE FUNCTION users_keep_an_owner();
