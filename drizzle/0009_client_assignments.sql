CREATE TABLE "client_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"assigned_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "client_assignments_org_id_uq" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_client_fk" FOREIGN KEY ("organization_id","client_id") REFERENCES "public"."clients"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_assigned_by_fk" FOREIGN KEY ("organization_id","assigned_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_assignments_active_uq" ON "client_assignments" USING btree ("organization_id","client_id","user_id") WHERE "client_assignments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "client_assignments_org_user_client_idx" ON "client_assignments" USING btree ("organization_id","user_id","client_id");--> statement-breakpoint
CREATE INDEX "client_assignments_org_assigned_by_idx" ON "client_assignments" USING btree ("organization_id","assigned_by_user_id");--> statement-breakpoint

-- Integrity, row-level security and privileges, the same set every other tenant table has
-- (0003 triggers, 0004 policy, 0003 grants). Hand-written; drizzle-kit does not generate these.
CREATE TRIGGER client_assignments_set_updated_at BEFORE UPDATE ON client_assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER client_assignments_forbid_org_change BEFORE UPDATE ON client_assignments FOR EACH ROW EXECUTE FUNCTION forbid_org_change();
--> statement-breakpoint
ALTER TABLE "client_assignments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "client_assignments" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
-- No DELETE (a client purge removes rows through the FK cascade). UPDATE only on the two
-- columns an "end this assignment" needs, so feature code cannot re-point a row at another
-- client or user: it ends the row and inserts a new one.
REVOKE ALL ON client_assignments FROM PUBLIC, app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON client_assignments TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (deleted_at, updated_at) ON client_assignments TO app_runtime;
