-- Accepting an invitation (feat/invitations): the one narrow door that turns an emailed, single-use
-- token into an account.
--
-- Why a function: the person has no session and no practice yet, so neither runtime role can do this
-- alone. auth_runtime deliberately cannot INSERT into users (0006: it "cannot create, delete or
-- re-role users"), and app_runtime cannot set email_verified and works inside one practice at a time.
-- Widening auth_runtime to insert users would let any future bug in the auth layer mint accounts, so
-- the same pattern as reset_user_mfa (0012) is used: a SECURITY DEFINER function that runs as the table
-- owner, is executable by auth_runtime only, and does exactly this one thing:
--
--   * looks the invitation up by the SHA-256 of the token (the raw token never reaches the database)
--     and locks that row FOR UPDATE, so two simultaneous accepts take turns and the second finds it used;
--   * refuses (and says only 'refused' or 'unknown' to the caller) when the invitation is unknown,
--     already accepted, revoked, expired, its practice is gone, or the address already has an account
--     (users.email is globally unique: this is the last line of defense against a second user);
--   * otherwise, in the same transaction: inserts the user (role ALWAYS 'associate', practice from the
--     invitation, email_verified true because the link proves the mailbox: only this auth-layer function
--     sets that for a person, like the bootstrap script does for the first owner), inserts the credential
--     row with the scrypt hash the caller computed (the password itself never reaches the database),
--     marks the invitation accepted, and writes the audit rows. A refusal of a KNOWN invitation writes
--     one audit row in that practice with a reason from a closed list; an unknown token has no practice
--     to write to and the caller logs it instead.
--
-- It creates no session: the person signs in normally and is sent to authenticator setup like everyone.
-- Returns 'accepted', 'refused' or 'unknown'. The caller shows ONE answer for both refusals.
CREATE OR REPLACE FUNCTION accept_invitation(p_token_hash text, p_display_name text, p_password_hash text, p_ip text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_inv invitations%ROWTYPE;
  v_reason text;
  v_user uuid;
  v_meta jsonb;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN 'unknown';
  END IF;
  -- Defense in depth: the route validates these too, and a caller that skips it must not be able to
  -- create a nameless account or one without a credential.
  IF p_display_name IS NULL OR char_length(btrim(p_display_name)) NOT BETWEEN 1 AND 200 OR p_display_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'accept_invitation: invalid name' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_password_hash IS NULL OR char_length(p_password_hash) < 20 THEN
    RAISE EXCEPTION 'accept_invitation: invalid credential' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The address as received, only if it looks like one (the same rule as the application's clientIp()).
  v_meta := CASE WHEN p_ip ~ '^[0-9a-fA-F:.]{3,45}$' THEN jsonb_build_object('ip', p_ip) ELSE '{}'::jsonb END;

  SELECT * INTO v_inv FROM invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'unknown';
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    v_reason := 'used';
  ELSIF v_inv.revoked_at IS NOT NULL THEN
    v_reason := 'revoked';
  ELSIF v_inv.expires_at <= now() THEN
    v_reason := 'expired';
  ELSIF EXISTS (SELECT 1 FROM organizations WHERE id = v_inv.organization_id AND deleted_at IS NOT NULL) THEN
    v_reason := 'revoked';
  ELSIF EXISTS (SELECT 1 FROM users WHERE email = v_inv.email) THEN
    v_reason := 'address_in_use';
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO audit_log (organization_id, actor_user_id, action, resource_type, resource_id, outcome, metadata)
      VALUES (v_inv.organization_id, NULL, 'invitation.accept_refused', 'invitation', v_inv.id, 'denied', v_meta || jsonb_build_object('reason', v_reason));
    RETURN 'refused';
  END IF;

  -- Two different invitations (two practices) for one address can be accepted at the same moment: each
  -- passes the check above, and users_email_uq lets exactly one insert through. The other is not an error
  -- for the caller, it is the same refusal as an address that has an account.
  BEGIN
    INSERT INTO users (organization_id, email, display_name, role, email_verified)
      VALUES (v_inv.organization_id, v_inv.email, btrim(p_display_name), 'associate', true)
      RETURNING id INTO v_user;
  EXCEPTION WHEN unique_violation THEN
    v_reason := 'address_in_use';
  END;
  IF v_reason IS NOT NULL THEN
    INSERT INTO audit_log (organization_id, actor_user_id, action, resource_type, resource_id, outcome, metadata)
      VALUES (v_inv.organization_id, NULL, 'invitation.accept_refused', 'invitation', v_inv.id, 'denied', v_meta || jsonb_build_object('reason', v_reason));
    RETURN 'refused';
  END IF;
  INSERT INTO auth_accounts (user_id, account_id, provider_id, password)
    VALUES (v_user, v_user::text, 'credential', p_password_hash);
  UPDATE invitations SET accepted_at = now() WHERE id = v_inv.id;

  INSERT INTO audit_log (organization_id, actor_user_id, action, resource_type, resource_id, outcome, metadata)
    VALUES (v_inv.organization_id, v_user, 'invitation.accepted', 'invitation', v_inv.id, 'success', v_meta || jsonb_build_object('role', 'associate'));
  INSERT INTO audit_log (organization_id, actor_user_id, action, resource_type, resource_id, outcome, metadata)
    VALUES (v_inv.organization_id, v_inv.invited_by, 'user.created', 'users', v_user, 'success', jsonb_build_object('method', 'invitation', 'role', 'associate'));
  RETURN 'accepted';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION accept_invitation(text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION accept_invitation(text, text, text, text) TO auth_runtime;
