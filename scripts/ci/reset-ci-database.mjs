// CI-only: put the CI integration database back to "exactly the migrations on this branch".
//
// Why: the `integration` job shares ONE Neon project, and migrations are forward-only, so a PR's
// migration would otherwise stay in the database after its run (PROGRESS.md, Next up CI item 5:
// #39's run applied 0013 and then #40, with main's tests, failed on it).
//
//   node scripts/ci/reset-ci-database.mjs reset      drop everything the migrations create, then
//                                                    report the before/after state
//   node scripts/ci/reset-ci-database.mjs verify     after `npm run db:migrate`: the database holds
//                                                    exactly the migrations in drizzle/
//   node scripts/ci/reset-ci-database.mjs print-sql  print the reset SQL; connects to nothing
//
// reset and verify read the CI database's owner URL from CI_DATABASE_URL and the one host they
// may talk to from CI_DATABASE_HOST (a repository variable, not a secret). They REFUSE to run
// when the URL's host is not exactly that host (so never the dev project or its `test` branch,
// which have other hosts), when it is a pooled host, or when either value is missing.
//
// It never prints the URL, the host from the URL, the user or the password: every message is
// redacted before it is shown. It only ever touches the `public` and `drizzle` schemas and the
// roles whose names match ROLE_PATTERN. Synthetic data only; never point it at anything else.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Roles the migrations (app_runtime, auth_runtime) and the integration suites
 * (app_runtime_<suite>, auth_runtime_<suite>) create. Roles belong to the whole Postgres
 * cluster, not to a schema, so dropping the schema alone would leave them, with their
 * memberships and any role-level settings, for the next run to inherit.
 * New suites must name their roles app_runtime_<x> / auth_runtime_<x> (docs/RUNBOOK.md).
 */
export const ROLE_PATTERN = "^(app|auth)_runtime(_[a-z0-9]+)?$";

/**
 * One block, so it is atomic: if anything inside fails, nothing is dropped. The same text is
 * used by `print-sql` and by the local rehearsal, so what was rehearsed is what runs.
 */
export const RESET_SQL = `
DO $reset$
DECLARE
  r record;
  before_owner text;
  before_acl text;
  after_owner text;
  after_acl text;
BEGIN
  SELECT nspowner::regrole::text, nspacl::text INTO before_owner, before_acl
    FROM pg_namespace WHERE nspname = 'public';

  -- Tables, functions, triggers, policies, grants on them, the vector extension, and drizzle's
  -- migration journal all live in these two schemas.
  DROP SCHEMA IF EXISTS drizzle CASCADE;
  DROP SCHEMA IF EXISTS public CASCADE;

  -- Recreate public the way a fresh Postgres 15+ database has it.
  CREATE SCHEMA public AUTHORIZATION pg_database_owner;
  GRANT USAGE ON SCHEMA public TO PUBLIC;
  COMMENT ON SCHEMA public IS 'standard public schema';

  FOR r IN SELECT rolname FROM pg_roles WHERE rolname ~ '${ROLE_PATTERN}' ORDER BY rolname LOOP
    EXECUTE format('DROP ROLE %I', r.rolname);
  END LOOP;

  SELECT nspowner::regrole::text, nspacl::text INTO after_owner, after_acl
    FROM pg_namespace WHERE nspname = 'public';
  IF before_owner IS DISTINCT FROM after_owner OR before_acl IS DISTINCT FROM after_acl THEN
    RAISE EXCEPTION 'public schema differs after reset: owner % -> %, acl % -> %',
      before_owner, after_owner, before_acl, after_acl;
  END IF;
END
$reset$;
`;

const STATE_SQL = `
SELECT
  (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public') AS public_tables,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public') AS public_functions,
  (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname ~ '${ROLE_PATTERN}') AS runtime_roles,
  (SELECT count(*)::int FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
     WHERE r.rolname ~ '${ROLE_PATTERN}') AS runtime_role_settings,
  (SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension) AS extensions,
  (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'public') AS public_owner,
  (SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public') AS public_acl,
  CASE WHEN to_regclass('drizzle.__drizzle_migrations') IS NULL THEN NULL
       ELSE (SELECT count(*)::int FROM drizzle.__drizzle_migrations) END AS migrations_applied
`;

// ---------------------------------------------------------------------------------------------
// Guards and redaction (pure; unit-tested in ci-guards.test.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Is it safe to run against this URL? Returns a reason code only, never the values: a CI log on
 * a public repo must not learn which host (or what else) was wrong.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkHost(rawUrl, allowedHost) {
  if (!allowedHost || !allowedHost.trim()) return { ok: false, reason: "allowed host (CI_DATABASE_HOST) is not set" };
  if (!rawUrl) return { ok: false, reason: "database URL (CI_DATABASE_URL) is not set" };
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "database URL does not parse" };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return { ok: false, reason: "database URL is not a postgres URL" };
  }
  const host = url.hostname.toLowerCase();
  if (host.includes("-pooler")) return { ok: false, reason: "database host is a pooled host; the reset needs the direct one" };
  if (host !== allowedHost.trim().toLowerCase()) return { ok: false, reason: "database host is not the allow-listed CI host" };
  return { ok: true };
}

/** Replace every secret-ish value in text, in every form it might appear. */
export function redact(text, rawUrl) {
  let out = String(text ?? "");
  const needles = new Set();
  if (rawUrl) {
    needles.add(rawUrl);
    try {
      const u = new URL(rawUrl);
      for (const v of [u.password, decodeURIComponent(u.password), u.username, decodeURIComponent(u.username), u.hostname]) {
        if (v && v.length >= 3) needles.add(v);
      }
    } catch {
      // unparseable: the whole-URL needle still applies
    }
  }
  for (const n of [...needles].sort((a, b) => b.length - a.length)) out = out.split(n).join("[redacted]");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Migrations the branch expects (pure given a folder; unit-tested)
// ---------------------------------------------------------------------------------------------

/** What drizzle stores per applied migration: sha256 of the .sql file text (drizzle-orm/migrator). */
export function expectedMigrationHashes(drizzleDir) {
  const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"));
  return journal.entries.map((e) => ({
    tag: e.tag,
    hash: crypto.createHash("sha256").update(fs.readFileSync(path.join(drizzleDir, `${e.tag}.sql`)).toString()).digest("hex"),
  }));
}

/** @returns {string[]} problems; empty means the database has exactly the expected migrations */
export function compareMigrations(expected, appliedHashes) {
  const problems = [];
  const have = new Map();
  for (const h of appliedHashes) have.set(h, (have.get(h) ?? 0) + 1);
  for (const { tag, hash } of expected) {
    if (!have.has(hash)) problems.push(`migration ${tag} is in drizzle/ but not applied`);
    else if (have.get(hash) > 1) problems.push(`migration ${tag} is applied ${have.get(hash)} times`);
  }
  const known = new Set(expected.map((e) => e.hash));
  const extra = appliedHashes.filter((h) => !known.has(h)).length;
  if (extra) problems.push(`${extra} applied migration(s) are not in drizzle/ (state left over from another branch)`);
  return problems;
}

/** @returns {string[]} problems; empty means the database is in the freshly reset state */
export function resetProblems(state) {
  const problems = [];
  if (state.public_tables !== 0) problems.push(`public still has ${state.public_tables} table(s)`);
  if (state.public_functions !== 0) problems.push(`public still has ${state.public_functions} function(s)`);
  if (state.runtime_roles) problems.push(`runtime roles remain: ${state.runtime_roles}`);
  if (state.runtime_role_settings !== 0) problems.push(`${state.runtime_role_settings} role-level setting(s) remain`);
  if (state.migrations_applied !== null) problems.push("drizzle's migration journal still exists");
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Database work (needs a connection)
// ---------------------------------------------------------------------------------------------

export async function readState(client) {
  const { rows } = await client.query(STATE_SQL);
  return rows[0];
}

export async function resetDatabase(client, log = console.log) {
  log(`before: ${JSON.stringify(await readState(client))}`);
  await client.query(RESET_SQL);
  const after = await readState(client);
  log(`after:  ${JSON.stringify(after)}`);
  const problems = resetProblems(after);
  if (problems.length) throw new Error(`reset did not leave a clean database: ${problems.join("; ")}`);
}

export async function verifyMigrations(client, drizzleDir, log = console.log) {
  const expected = expectedMigrationHashes(drizzleDir);
  const { rows } = await client.query("SELECT hash FROM drizzle.__drizzle_migrations");
  const problems = compareMigrations(expected, rows.map((r) => r.hash));
  if (problems.length) throw new Error(problems.join("; "));
  log(`verify: ${rows.length} migrations applied, identical to the ${expected.length} in drizzle/ (last: ${expected.at(-1)?.tag})`);
}

async function main() {
  const mode = process.argv[2];
  if (mode === "print-sql") {
    console.log(RESET_SQL.trim());
    return;
  }
  if (mode !== "reset" && mode !== "verify") {
    console.error("usage: node scripts/ci/reset-ci-database.mjs reset|verify|print-sql");
    process.exit(2);
  }
  const url = process.env.CI_DATABASE_URL;
  const verdict = checkHost(url, process.env.CI_DATABASE_HOST);
  if (!verdict.ok) {
    console.error(`REFUSING to run: ${verdict.reason}. Nothing was touched.`);
    process.exit(1);
  }
  console.log("Database host matches the allow-listed CI host.");
  const { Pool } = await import("@neondatabase/serverless");
  const pool = new Pool({ connectionString: url });
  try {
    if (mode === "reset") await resetDatabase(pool);
    else await verifyMigrations(pool, "drizzle");
  } catch (error) {
    const e = /** @type {{ code?: string, message?: string, detail?: string }} */ (error);
    console.error(`${mode} FAILED${e.code ? ` (${e.code})` : ""}: ${redact(e.message, url)}`);
    if (e.detail) console.error(`detail: ${redact(e.detail, url)}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
