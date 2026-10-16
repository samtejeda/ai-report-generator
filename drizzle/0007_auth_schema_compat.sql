ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD COLUMN "access_token" text;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD COLUMN "refresh_token" text;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD COLUMN "id_token" text;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD COLUMN "access_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD COLUMN "refresh_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD COLUMN "scope" text;