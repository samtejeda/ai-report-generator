-- Separate database role for authentication, and the privilege split that goes with it.
-- Written by hand (drizzle-kit generate --custom). Contains no passwords and no data.
--
-- Two roles, two jobs:
--   app_runtime   feature code (tenantDb). Tenant data only, behind row-level security.
--                 Gets NO access to credentials, sessions or reset tokens.
--   auth_runtime  Better Auth only (AUTH_DATABASE_URL). The auth tables plus the identity
--                 columns of `users`. Gets NO access to clients, reports, templates, RAG
--                 data, organizations, audit_log or purge_client().
-- So a bug in feature code cannot read a password hash or session token, and a bug in the
-- auth layer cannot read clinical content.
--
-- Like app_runtime, auth_runtime is a NOLOGIN group role. The login role the app connects
-- as is created out-of-band with a generated password (never in a migration or the repo):
--   CREATE ROLE <login> LOGIN PASSWORD '...' IN ROLE auth_runtime;   (see docs/RUNBOOK.md)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_runtime') THEN
    CREATE ROLE auth_runtime NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO auth_runtime;
--> statement-breakpoint

-- 1. Auth tables: auth_runtime only. Explicit revokes make the intent visible and keep
-- the result right even if a default privilege ever grants more.
REVOKE ALL ON auth_accounts, auth_sessions, auth_verifications, auth_rate_limits FROM PUBLIC, app_runtime;
--> statement-breakpoint
-- Credentials are never deleted by the app (they go with the user via the FK cascade).
GRANT SELECT, INSERT, UPDATE ON auth_accounts TO auth_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_sessions, auth_verifications, auth_rate_limits TO auth_runtime;
--> statement-breakpoint

-- 2. users: auth must find a user by email before any tenant is known, so it gets a
-- policy that spans tenants, but only SELECT, and UPDATE of the verification flag. It
-- cannot create, delete or re-role users, and users holds no clinical data.
GRANT SELECT ON users TO auth_runtime;
--> statement-breakpoint
GRANT UPDATE (email_verified, updated_at) ON users TO auth_runtime;
--> statement-breakpoint
CREATE POLICY "auth_read_identity" ON "users" AS PERMISSIVE FOR SELECT TO auth_runtime USING (true);
--> statement-breakpoint
CREATE POLICY "auth_verify_email" ON "users" AS PERMISSIVE FOR UPDATE TO auth_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint

-- 3. Feature code can no longer mark an email verified. It may still create and edit users
-- (invites, display name, role, deactivation) through every other column. Changing the
-- verification flag is the auth layer's job.
REVOKE INSERT, UPDATE ON users FROM app_runtime;
--> statement-breakpoint
GRANT INSERT (id, organization_id, email, display_name, role, created_at, updated_at, deleted_at) ON users TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (organization_id, email, display_name, role, updated_at, deleted_at) ON users TO app_runtime;
