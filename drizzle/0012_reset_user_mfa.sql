-- Owner-run MFA reset from inside the app (feat/auth-admin; replaces the need for the break-glass
-- script when a psychologist or an admin loses the phone and the backup codes).
--
-- Why a function: auth_runtime deliberately has no DELETE on auth_two_factors (0008), so that a bug
-- or an attack on the auth layer cannot switch a person's second factor off. This function is the
-- one narrow door: it runs as the table owner, is executable by auth_runtime only, and refuses
-- everything but the exact case it exists for. A caller cannot turn it into a general delete.
--
--   * the actor must be an ACTIVE OWNER (checked here, from the table, not trusted from the caller);
--   * the target must be in the SAME organization, active, not the actor, and not an owner (an owner
--     who loses everything still uses scripts/mfa-reset.mjs with the database owner credential);
--   * in one transaction: the enrollment is removed, the MFA flag is cleared, every session and every
--     trusted device / pending link of the target is deleted, and the audit row is written. If any
--     step fails, nothing happens, including the audit row (a reset is never silent).
--
-- The person keeps their password, so their next sign-in sends them to set up a new phone.
-- The route (POST /api/admin/users/{id}/reset-mfa) additionally requires a recent sign-in.
CREATE OR REPLACE FUNCTION reset_user_mfa(p_actor uuid, p_target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor_org uuid;
  v_actor_role text;
  v_actor_deleted timestamptz;
  v_target_org uuid;
  v_target_role text;
  v_target_deleted timestamptz;
BEGIN
  SELECT organization_id, role, deleted_at INTO v_actor_org, v_actor_role, v_actor_deleted
    FROM users WHERE id = p_actor;
  IF NOT FOUND OR v_actor_role <> 'owner' OR v_actor_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'reset_user_mfa: only an active owner may reset a second factor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT organization_id, role, deleted_at INTO v_target_org, v_target_role, v_target_deleted
    FROM users WHERE id = p_target;
  -- Another practice's person looks exactly like one that does not exist.
  IF NOT FOUND OR v_target_org <> v_actor_org THEN
    RAISE EXCEPTION 'reset_user_mfa: user not found in organization' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_target = p_actor OR v_target_role = 'owner' THEN
    RAISE EXCEPTION 'reset_user_mfa: an owner''s second factor is reset with the break-glass script'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_target_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'reset_user_mfa: user is deactivated' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  DELETE FROM auth_two_factors WHERE user_id = p_target;
  UPDATE users SET two_factor_enabled = false, updated_at = now() WHERE id = p_target;
  DELETE FROM auth_sessions WHERE user_id = p_target;
  -- Trusted devices are rows here (value = user id); this also clears any pending reset link.
  DELETE FROM auth_verifications WHERE value = p_target::text;
  INSERT INTO audit_log (organization_id, actor_user_id, action, resource_type, resource_id, outcome, metadata)
    VALUES (v_actor_org, p_actor, 'auth.mfa_reset', 'users', p_target, 'success', jsonb_build_object('method', 'owner_reset'));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reset_user_mfa(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reset_user_mfa(uuid, uuid) TO auth_runtime;
