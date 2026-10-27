-- THROWAWAY: proof migration for the per-run CI database reset (PR A). Never merge.
-- It leaves four kinds of leftovers that a reset must remove: a table, a grant, a role that
-- matches the reset's naming rule, and a role-level setting on a migration-created role.
CREATE TABLE "ci_reset_probe" ("id" integer PRIMARY KEY);
--> statement-breakpoint
GRANT SELECT ON "ci_reset_probe" TO app_runtime;
--> statement-breakpoint
CREATE ROLE app_runtime_probe NOLOGIN;
--> statement-breakpoint
ALTER ROLE app_runtime SET application_name = 'ci_reset_probe';
