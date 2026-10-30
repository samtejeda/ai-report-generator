CREATE TABLE "read_limit_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "read_limit_counters_person_key_uq" UNIQUE("organization_id","user_id","key"),
	CONSTRAINT "read_limit_counters_key_valid" CHECK ("read_limit_counters"."key" in ('report_state')),
	CONSTRAINT "read_limit_counters_count_nonneg" CHECK ("read_limit_counters"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "read_limit_counters" ADD CONSTRAINT "read_limit_counters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_limit_counters" ADD CONSTRAINT "read_limit_counters_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Integrity, row-level security and privileges, the same set every other tenant table has
-- (0003 triggers, 0004 policy, 0003 grants). Hand-written; drizzle-kit does not generate these.
-- Forward-only and backward-compatible: a new table that the previous deploy never touches.
CREATE TRIGGER read_limit_counters_set_updated_at BEFORE UPDATE ON read_limit_counters FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER read_limit_counters_forbid_org_change BEFORE UPDATE ON read_limit_counters FOR EACH ROW EXECUTE FUNCTION forbid_org_change();
--> statement-breakpoint
ALTER TABLE "read_limit_counters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "read_limit_counters" AS PERMISSIVE FOR ALL TO app_runtime
  USING ("organization_id" = (SELECT app_current_org()))
  WITH CHECK ("organization_id" = (SELECT app_current_org()));
--> statement-breakpoint
-- No DELETE (one row per person and key, reused for ever). UPDATE only on the counting columns
-- (plus updated_at, which the trigger stamps), so feature code cannot re-point a row at another
-- person, practice or key.
REVOKE ALL ON read_limit_counters FROM PUBLIC, app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON read_limit_counters TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (window_start, count, updated_at) ON read_limit_counters TO app_runtime;
