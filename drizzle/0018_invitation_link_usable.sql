-- Is this emailed link still usable? (feat/invitation-link-usable)
--
-- The accept page needs to know, before it shows a password form, whether the link can still be
-- used, without spending it. This is one new function; nothing existing changes and the previous
-- deploy never calls it.
--
-- It returns true only when a row with that token hash exists, is not accepted, is not revoked, has
-- not expired, its practice is not deleted, and its address has no account yet: exactly the
-- conditions accept_invitation() (0016) refuses on, in the same terms. It answers a bare boolean,
-- never a reason, a practice or an address, so every unusable link looks the same. A malformed or
-- NULL hash is false. It contains no write, so it cannot consume the invitation or write an audit row.
--
-- It is a read at one moment, not a reservation: accept_invitation() stays the authority (it takes
-- the row lock), so a link that is usable here can still be refused a moment later.
--
-- Same door as accept_invitation(): SECURITY DEFINER (the person has no session; auth_runtime has no
-- privilege on invitations), executable by auth_runtime only, so app_runtime cannot call it.
CREATE FUNCTION invitation_link_usable(p_token_hash text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(
    p_token_hash ~ '^[0-9a-f]{64}$'
    AND EXISTS (
      SELECT 1 FROM invitations i
      WHERE i.token_hash = p_token_hash
        AND i.accepted_at IS NULL
        AND i.revoked_at IS NULL
        AND i.expires_at > now()
        AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = i.organization_id AND o.deleted_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = i.email)
    ),
    false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION invitation_link_usable(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION invitation_link_usable(text) TO auth_runtime;
