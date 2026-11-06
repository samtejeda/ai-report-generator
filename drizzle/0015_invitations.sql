CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'associate' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "invitations_token_hash_uq" UNIQUE("token_hash"),
	CONSTRAINT "invitations_email_lowercase" CHECK ("invitations"."email" = lower("invitations"."email")),
	CONSTRAINT "invitations_role_valid" CHECK ("invitations"."role" = 'associate'),
	CONSTRAINT "invitations_token_hash_shape" CHECK ("invitations"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_fk" FOREIGN KEY ("organization_id","invited_by") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_pending_uq" ON "invitations" USING btree ("organization_id","email") WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "invitations_org_created_idx" ON "invitations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "invitations_org_invited_by_idx" ON "invitations" USING btree ("organization_id","invited_by");--> statement-breakpoint

-- Integrity, row-level security and privileges, the same set every other tenant table has
-- (0003 triggers, 0004 policy, 0003 grants). Hand-written; drizzle-kit does not generate these.
CREATE TRIGGER invitations_set_updated_at BEFORE UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER invitations_forbid_org_change BEFORE UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION forbid_org_change();
--> statement-breakpoint
-- Single use, enforced where nobody can forget it: an invitation that was accepted or revoked is
-- final. It cannot be re-armed (new token, new expiry) or un-revoked by any role, the app included.
CREATE FUNCTION invitations_closed_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'an accepted or revoked invitation cannot change' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invitations_closed_is_final BEFORE UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION invitations_closed_is_final();
--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invitations" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
-- No DELETE. UPDATE only on what "send a new link" and "revoke" need; `accepted_at` is deliberately
-- absent: only accept_invitation() (0016, runs as the table owner) can mark an invitation accepted.
-- auth_runtime gets nothing here; that function is its only way in.
REVOKE ALL ON invitations FROM PUBLIC, app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON invitations TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (token_hash, expires_at, revoked_at, invited_by, updated_at) ON invitations TO app_runtime;
