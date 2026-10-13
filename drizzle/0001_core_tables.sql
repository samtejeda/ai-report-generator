CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'private_practice' NOT NULL,
	"state" char(2),
	"inference_endpoint" text,
	"model_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data_retention_days" integer,
	"baa_signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "organizations_retention_positive" CHECK ("organizations"."data_retention_days" is null or "organizations"."data_retention_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "users_role_valid" CHECK ("users"."role" in ('owner','associate','admin'))
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"external_id" text,
	"display_name" text NOT NULL,
	"date_of_birth" date,
	"grade_level" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "clients_org_id_uq" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "client_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"occurred_on" date NOT NULL,
	"due_on" date,
	"summary" text,
	"report_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "client_history_entry_type_valid" CHECK ("client_history"."entry_type" in ('prior_evaluation','reeval_due','note'))
);
--> statement-breakpoint
CREATE TABLE "methodology_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"content" jsonb NOT NULL,
	"notes" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "methodology_prompts_org_template_id_uq" UNIQUE("organization_id","template_id","id"),
	CONSTRAINT "methodology_prompts_template_version_uq" UNIQUE("template_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "report_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"structure" jsonb NOT NULL,
	"active_methodology_prompt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "report_templates_org_id_uq" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "report_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"section_type" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_sections_org_report_id_uq" UNIQUE("organization_id","report_id","id"),
	CONSTRAINT "report_sections_report_key_uq" UNIQUE("report_id","section_key"),
	CONSTRAINT "report_sections_type_valid" CHECK ("report_sections"."section_type" in ('prose','structured'))
);
--> statement-breakpoint
CREATE TABLE "report_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"edit_type" text NOT NULL,
	"content" jsonb NOT NULL,
	"llm_metadata" jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_versions_section_version_uq" UNIQUE("section_id","version_number"),
	CONSTRAINT "report_versions_edit_type_valid" CHECK ("report_versions"."edit_type" in ('ai_generated','human_edit','ai_regenerated_section')),
	CONSTRAINT "report_versions_human_edit_has_author" CHECK ("report_versions"."edit_type" <> 'human_edit' or "report_versions"."created_by_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"methodology_prompt_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "reports_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "reports_status_valid" CHECK ("reports"."status" in ('draft','generating','generated','finalized','error')),
	CONSTRAINT "reports_finalized_consistent" CHECK (("reports"."status" = 'finalized') = ("reports"."finalized_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_history" ADD CONSTRAINT "client_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_history" ADD CONSTRAINT "client_history_client_fk" FOREIGN KEY ("organization_id","client_id") REFERENCES "public"."clients"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_history" ADD CONSTRAINT "client_history_report_fk" FOREIGN KEY ("organization_id","report_id") REFERENCES "public"."reports"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_history" ADD CONSTRAINT "client_history_created_by_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_prompts" ADD CONSTRAINT "methodology_prompts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_prompts" ADD CONSTRAINT "methodology_prompts_template_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."report_templates"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "methodology_prompts" ADD CONSTRAINT "methodology_prompts_created_by_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_active_prompt_fk" FOREIGN KEY ("organization_id","id","active_methodology_prompt_id") REFERENCES "public"."methodology_prompts"("organization_id","template_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sections" ADD CONSTRAINT "report_sections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sections" ADD CONSTRAINT "report_sections_report_fk" FOREIGN KEY ("organization_id","report_id") REFERENCES "public"."reports"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_section_fk" FOREIGN KEY ("organization_id","report_id","section_id") REFERENCES "public"."report_sections"("organization_id","report_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_created_by_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_client_fk" FOREIGN KEY ("organization_id","client_id") REFERENCES "public"."clients"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_template_prompt_fk" FOREIGN KEY ("organization_id","template_id","methodology_prompt_id") REFERENCES "public"."methodology_prompts"("organization_id","template_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email_active_uq" ON "users" USING btree ("organization_id",lower("email")) WHERE "users"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_org_external_id_active_uq" ON "clients" USING btree ("organization_id","external_id") WHERE "clients"."external_id" is not null and "clients"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "clients_org_created_idx" ON "clients" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "client_history_org_client_occurred_idx" ON "client_history" USING btree ("organization_id","client_id","occurred_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "client_history_org_report_idx" ON "client_history" USING btree ("organization_id","report_id");--> statement-breakpoint
CREATE INDEX "client_history_org_created_by_idx" ON "client_history" USING btree ("organization_id","created_by_user_id");--> statement-breakpoint
CREATE INDEX "methodology_prompts_org_created_by_idx" ON "methodology_prompts" USING btree ("organization_id","created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_templates_org_slug_active_uq" ON "report_templates" USING btree ("organization_id","slug") WHERE "report_templates"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "report_sections_org_report_position_idx" ON "report_sections" USING btree ("organization_id","report_id","position");--> statement-breakpoint
CREATE INDEX "report_versions_org_report_created_idx" ON "report_versions" USING btree ("organization_id","report_id","created_at");--> statement-breakpoint
CREATE INDEX "report_versions_org_created_by_idx" ON "report_versions" USING btree ("organization_id","created_by_user_id");--> statement-breakpoint
CREATE INDEX "reports_org_client_created_idx" ON "reports" USING btree ("organization_id","client_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reports_org_status_idx" ON "reports" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "reports_org_template_prompt_idx" ON "reports" USING btree ("organization_id","template_id","methodology_prompt_id");--> statement-breakpoint
CREATE INDEX "reports_org_created_by_idx" ON "reports" USING btree ("organization_id","created_by_user_id");