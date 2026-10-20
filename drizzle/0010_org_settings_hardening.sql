ALTER TABLE "organizations" ADD CONSTRAINT "organizations_inference_endpoint_allowlist" CHECK ("organizations"."inference_endpoint" is null or (length("organizations"."inference_endpoint") <= 253 and "organizations"."inference_endpoint" ~ '^https://(?!xn--)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.](?!xn--)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+[.]ts[.]net(:(443|8443|10000))?(/v1)?$'));--> statement-breakpoint

-- Audit 04 item 8: nothing but the allow-listed admin action may change where inference
-- traffic goes. Until now app_runtime could UPDATE the whole organizations row (0003), so the
-- protection was a TypeScript helper only. From here the database enforces it:
--   * app_runtime may update only name, type, state (and the updated_at the trigger sets);
--     inference_endpoint, model_config and the retention / BAA columns are not writable by it;
--   * the endpoint changes only through set_inference_endpoint() below, and the CHECK
--     constraint above refuses any value outside the allow-list, whoever writes it.
REVOKE UPDATE ON organizations FROM app_runtime;
--> statement-breakpoint
GRANT UPDATE (name, type, state, updated_at) ON organizations TO app_runtime;
--> statement-breakpoint

-- Same pattern as purge_client(): runs as the table owner, so the tenant is enforced inside it.
-- The organization argument must be the one this transaction was opened for (tenantDb sets
-- app.organization_id); without that, any caller could name another practice. Whether the
-- caller may do this at all (owner, signed in recently) is decided by the route, which is the
-- only caller; the value itself is checked by the CHECK constraint, not trusted from the route.
CREATE OR REPLACE FUNCTION set_inference_endpoint(p_org uuid, p_endpoint text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_org IS DISTINCT FROM app_current_org() THEN
    RAISE EXCEPTION 'set_inference_endpoint: organization does not match the session tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE organizations SET inference_endpoint = p_endpoint WHERE id = p_org AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'no_data_found';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION set_inference_endpoint(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION set_inference_endpoint(uuid, text) TO app_runtime;
