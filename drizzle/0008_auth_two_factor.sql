CREATE TABLE "auth_two_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_two_factors_user_uq" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_two_factors" ADD CONSTRAINT "auth_two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Privileges for the new table, same split as migration 0006: auth_runtime only, app_runtime
-- nothing. No DELETE: no HTTP endpoint removes an enrollment (there is no self-service
-- "turn MFA off"); an owner-run reset is a break-glass script using the owner credential.
REVOKE ALL ON auth_two_factors FROM PUBLIC, app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON auth_two_factors TO auth_runtime;
--> statement-breakpoint
-- The MFA flag is flipped by the auth layer only. app_runtime's column grants (0006) do not list
-- it, so feature code can neither enable nor disable MFA for anyone.
GRANT UPDATE (two_factor_enabled) ON users TO auth_runtime;
