// Is this database up to date with the migrations in this checkout? READ-ONLY.
//
//   npm run db:status                 one plain first line (OK / MISSING / BLOCKED / UNREADABLE), then the list
//   node scripts/db-status.mjs --warn the same check for `npm run dev` (predev): prints only when migrations are
//                                     missing, is silent otherwise, and ALWAYS exits 0 (never blocks `dev`)
//
// Why: `npm run db:migrate` (drizzle-kit) prints almost nothing, whether it applied something or found nothing
// to apply, so nobody can tell. Three times (0017, then 0018 twice) merged code ran against the `dev` database
// without its migration. This answers the question in one line and exits non-zero when the answer is no.
//
// What "applied" means: drizzle does NOT decide by hash. `migrate` applies a migration only when its journal
// `when` is newer than the newest `created_at` already in drizzle.__drizzle_migrations. So a missing migration
// whose `when` is not newer than that would be skipped by `db:migrate` forever; that is reported as BLOCKED,
// not MISSING, because "Run: npm run db:migrate" would be a lie. A journal entry whose timestamp IS in the
// database but with a different hash was applied from a different version of its file (edited after it was
// applied): drizzle counts it as applied and `db:migrate` will never change it, so that is DRIFT.
//
// Reads DATABASE_URL_UNPOOLED (the owner credential in .env.local; the app role cannot read the drizzle
// schema). It never prints a URL, user, password, token or full host: only the endpoint name (the first
// label of a Neon host, `ep-...`) with the rest masked. It refuses any host that is not a Neon host.
// Synthetic data only; the only statements it runs are two SELECTs.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectedMigrationHashes } from "./ci/reset-ci-database.mjs";

export const WARN_TIMEOUT_MS = 5000;
export const STATUS_TIMEOUT_MS = 15000;

/** What this checkout expects, in journal order: tag, drizzle's hash, and the journal `when` drizzle compares. */
export function expectedMigrations(drizzleDir) {
  const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"));
  return expectedMigrationHashes(drizzleDir).map((e, i) => ({ ...e, when: Number(journal.entries[i].when) }));
}

/**
 * Is it safe to talk to this URL? Reason codes only, never values.
 * @returns {{ ok: true, endpoint: string } | { ok: false, reason: string }}
 */
export function checkNeonUrl(rawUrl) {
  if (!rawUrl) return { ok: false, reason: "no_url" };
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "url_unparseable" };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return { ok: false, reason: "not_postgres_url" };
  const host = url.hostname.toLowerCase();
  const labels = host.split(".");
  // A Neon host is ep-<name>-<id>[-pooler].<region>.<provider>.neon.tech
  if (labels.length < 3 || labels.slice(-2).join(".") !== "neon.tech" || !/^ep-[a-z0-9-]+$/.test(labels[0])) {
    return { ok: false, reason: "not_neon_host" };
  }
  return { ok: true, endpoint: `${labels[0]}.***` };
}

/**
 * Read what the database has. Two queries: Postgres resolves a table name at parse time, so one query that
 * names drizzle.__drizzle_migrations fails when the journal does not exist (an empty database).
 * @returns {Promise<{ hash: string, createdAt: number }[]>} empty when there is no journal
 */
export async function readApplied(client) {
  const probe = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS has_journal");
  if (!probe.rows[0]?.has_journal) return [];
  const { rows } = await client.query("SELECT hash, created_at FROM drizzle.__drizzle_migrations");
  return rows.map((r) => ({ hash: String(r.hash), createdAt: Number(r.created_at) }));
}

/**
 * Pure comparison. `applied` is [{ hash, createdAt }]; `expected` is expectedMigrations().
 * missing: not in the database at all. blocked: the part of missing that db:migrate would skip. changed: the
 * timestamp is in the database but the hash differs (applied from another version of the file).
 * @returns {{ kind: "ok" | "missing" | "blocked" | "drift", total: number, missing: object[], blocked: object[], changed: object[], ahead: number }}
 */
export function analyze(expected, applied) {
  const have = new Set(applied.map((a) => a.hash));
  const known = new Set(expected.map((e) => e.hash));
  // Timestamps of applied rows that match no journal entry: only those can be "this migration, from an older
  // or edited file". A timestamp held by a row that IS another journal entry is a collision, not an edit.
  const strayStamps = new Set(applied.filter((a) => !known.has(a.hash)).map((a) => a.createdAt));
  const notFound = expected.filter((e) => !have.has(e.hash));
  const changed = notFound.filter((e) => strayStamps.has(e.when));
  const missing = notFound.filter((e) => !strayStamps.has(e.when));
  const newest = applied.reduce((max, a) => Math.max(max, a.createdAt), -Infinity);
  // drizzle-orm pg-core dialect: apply only when lastDbMigration.created_at < migration.folderMillis
  const blocked = missing.filter((m) => !(newest < m.when));
  // The applied rows that stand for a changed migration are not "ahead"; they are the same migration.
  const changedStamps = new Set(changed.map((e) => e.when));
  const ahead = applied.filter((a) => !known.has(a.hash) && !changedStamps.has(a.createdAt)).length;
  const kind = blocked.length ? "blocked" : missing.length ? "missing" : changed.length ? "drift" : "ok";
  return { kind, total: expected.length, missing, blocked, changed, ahead };
}

const HINTS = {
  no_url: "DATABASE_URL_UNPOOLED is not set (the owner credential in .env.local)",
  url_unparseable: "DATABASE_URL_UNPOOLED is not a valid URL",
  not_postgres_url: "DATABASE_URL_UNPOOLED is not a postgres URL",
  not_neon_host: "DATABASE_URL_UNPOOLED does not point at a Neon host; refusing to connect",
  permission_denied: "the credential cannot read the drizzle schema; DATABASE_URL_UNPOOLED must be the owner credential, not the app role",
  login_failed: "the database refused the login; check DATABASE_URL_UNPOOLED",
  timeout: "the database did not answer in time",
  cannot_connect: "could not connect to the database",
  failed: "the check failed",
};

/** Map any error to a reason code. The error text is never shown: it can carry a host or a user name. */
export function classifyError(error) {
  const e = /** @type {{ code?: string, message?: string }} */ (error ?? {});
  if (e.code === "42501") return "permission_denied";
  if (typeof e.code === "string" && /^28/.test(e.code)) return "login_failed";
  if (e.code === "STATUS_TIMEOUT" || /timeout|timed out/i.test(String(e.message))) return "timeout";
  if (typeof e.code === "string" && /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)$/.test(e.code)) return "cannot_connect";
  if (/connect|websocket|getaddrinfo|fetch failed/i.test(String(e.message))) return "cannot_connect";
  return "failed";
}

/** The lines to print and the exit code, for one result. First line is the plain answer. */
export function report(result, endpoint) {
  if (result.kind === "unreadable") {
    return { exitCode: 2, lines: [`UNREADABLE: ${result.reason} (${HINTS[result.reason] ?? HINTS.failed})`] };
  }
  const more = (list) => (list.length > 1 ? ` (and ${list.length - 1} more)` : "");
  const lines = [];
  if (result.kind === "ok") {
    lines.push(`OK: all ${result.total} migrations applied to ${endpoint}`);
  } else if (result.kind === "blocked") {
    lines.push(
      `BLOCKED: npm run db:migrate will SKIP ${result.blocked[0].tag}${more(result.blocked)} on ${endpoint}: its journal timestamp is not newer than the newest applied migration. The migration must be regenerated with a newer timestamp (ask database-builder); running db:migrate will not fix it.`,
    );
  } else if (result.kind === "missing") {
    lines.push(`MISSING: ${result.missing[0].tag}${more(result.missing)} on ${endpoint}. Run: npm run db:migrate`);
  } else {
    lines.push(
      `DRIFT: ${result.changed[0].tag}${more(result.changed)} on ${endpoint}: applied from a different version of its file (same timestamp, different content). db:migrate will not change this; check that the database matches the file (ask database-builder).`,
    );
  }
  const blockedTags = new Set(result.blocked.map((b) => b.tag));
  for (const m of result.missing) lines.push(`  - ${m.tag} ${blockedTags.has(m.tag) ? "(would be skipped by db:migrate)" : "(not applied)"}`);
  for (const m of result.changed) lines.push(`  - ${m.tag} (applied from a different version of the file)`);
  if (result.ahead) {
    lines.push(
      `NOTE: the database also has ${result.ahead} migration(s) this checkout does not have (a newer branch was applied, or you have not pulled main).`,
    );
  }
  return { exitCode: result.kind === "ok" ? 0 : 1, lines };
}

/**
 * The whole check, with the database injected. Never throws.
 * @param {{ url?: string, drizzleDir?: string, makeClient: (url: string) => Promise<{ query: Function, end?: Function }>, timeoutMs?: number }} options
 * @returns {Promise<{ result: object, endpoint?: string }>}
 */
export async function checkStatus({ url, drizzleDir = "drizzle", makeClient, timeoutMs = STATUS_TIMEOUT_MS }) {
  const verdict = checkNeonUrl(url);
  if (!verdict.ok) return { result: { kind: "unreadable", reason: verdict.reason } };
  let client;
  let timer;
  try {
    const work = (async () => {
      client = await makeClient(/** @type {string} */ (url));
      return analyze(expectedMigrations(drizzleDir), await readApplied(client));
    })();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "STATUS_TIMEOUT" })), timeoutMs);
    });
    // A late rejection of `work` after the deadline must not become an unhandled rejection.
    work.catch(() => {});
    const result = await Promise.race([work, deadline]);
    return { result, endpoint: verdict.endpoint };
  } catch (error) {
    return { result: { kind: "unreadable", reason: classifyError(error) }, endpoint: verdict.endpoint };
  } finally {
    clearTimeout(timer);
    // Best effort and not awaited: a hung connection must not hang the caller.
    Promise.resolve()
      .then(() => client?.end?.())
      .catch(() => {});
  }
}

/** The text `npm run dev` shows when the database is behind. Prominent on purpose. */
export function warningLines(result, endpoint) {
  const first = report(result, endpoint).lines[0];
  const bar = "=".repeat(78);
  return [bar, "  DATABASE IS BEHIND THIS CODE. The pages that need the missing migrations will fail.", `  ${first}`, "  Details: npm run db:status", bar];
}

/**
 * The command line, with everything injected so it is testable. Returns the exit code.
 * @param {{ argv: string[], env: Record<string, string | undefined>, makeClient: (url: string) => Promise<{ query: Function, end?: Function }>, log?: (s: string) => void, err?: (s: string) => void, drizzleDir?: string, timeoutMs?: number }} io
 */
export async function runCli({ argv, env, makeClient, log = console.log, err = console.error, drizzleDir = "drizzle", timeoutMs }) {
  const warn = argv.includes("--warn");
  const url = env.DATABASE_URL_UNPOOLED;
  try {
    if (warn) {
      // Silent without an owner URL (CI and deployed environments hold the runtime variables only) or on a host
      // that is not Neon. Never blocks: every path below returns 0. Only MISSING and BLOCKED are shown: DRIFT is a
      // rarer, slower problem that db:migrate cannot clear, so repeating it at every start would only train
      // people to ignore the warning; `npm run db:status` still reports it.
      if (!checkNeonUrl(url).ok) return 0;
      const { result, endpoint } = await checkStatus({ url, drizzleDir, makeClient, timeoutMs: timeoutMs ?? WARN_TIMEOUT_MS });
      if (result.kind === "missing" || result.kind === "blocked") for (const l of warningLines(result, endpoint)) err(l);
      return 0;
    }
    const { result, endpoint } = await checkStatus({ url, drizzleDir, makeClient, timeoutMs });
    const { lines, exitCode } = report(result, endpoint);
    for (const l of lines) (result.kind === "unreadable" ? err : log)(l);
    return exitCode;
  } catch {
    if (warn) return 0;
    err(`UNREADABLE: failed (${HINTS.failed})`);
    return 2;
  }
}

async function main() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Variables may already be set in the shell.
  }
  const code = await runCli({
    argv: process.argv.slice(2),
    env: process.env,
    makeClient: async (url) => {
      const { Pool } = await import("@neondatabase/serverless");
      const pool = new Pool({ connectionString: url });
      pool.on?.("error", () => {});
      return pool;
    },
  });
  // Exit explicitly: an open pool or a timed-out connection must not keep the process (or `npm run dev`) waiting.
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
