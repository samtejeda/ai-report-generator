// Break-glass MFA reset. Run by Sam (the person holding the database owner credential) when a
// psychologist, or the owner, has lost the phone AND the backup codes.
//
//   node scripts/mfa-reset.mjs person@example.com           dry run: shows who it would reset
//   node scripts/mfa-reset.mjs person@example.com --apply   does it
//
// What it does, in one transaction: removes the person's authenticator enrollment, turns their
// MFA flag off, signs out every session, revokes every trusted device (and any pending link),
// and writes an audit row. Their password is untouched, so on the next sign-in they are sent
// to set up a new phone. It never prints a secret, a code or a password hash.
//
// It uses DATABASE_URL_UNPOOLED (the owner credential, from .env.local), so run it only on a
// machine you trust, and check the host name it prints before using --apply. The in-app owner
// reset button arrives with the admin screens (feat/auth-admin).

export async function resetMfa(pool, rawEmail, { apply }) {
  const email = String(rawEmail ?? "").trim().toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const found = await client.query(
      "select id, organization_id, role, two_factor_enabled, deleted_at from users where email = $1",
      [email],
    );
    const user = found.rows[0];
    if (!user) {
      await client.query("rollback");
      return { status: "not_found" };
    }
    const summary = { userId: user.id, organizationId: user.organization_id, role: user.role, mfaWasEnabled: user.two_factor_enabled };
    if (!apply) {
      await client.query("rollback");
      return { status: "dry_run", ...summary };
    }
    await client.query("delete from auth_two_factors where user_id = $1", [user.id]);
    await client.query("update users set two_factor_enabled = false, updated_at = now() where id = $1", [user.id]);
    await client.query("delete from auth_sessions where user_id = $1", [user.id]);
    // Trusted devices are rows here (value = user id); this also clears any pending reset link.
    await client.query("delete from auth_verifications where value = $1", [user.id]);
    await client.query(
      `insert into audit_log (organization_id, actor_user_id, action, resource_type, resource_id, outcome, metadata)
       values ($1, null, 'auth.mfa_reset', 'users', $2, 'success', $3::jsonb)`,
      [user.organization_id, user.id, JSON.stringify({ method: "break_glass_script" })],
    );
    await client.query("commit");
    return { status: "reset", ...summary };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const [email, flag] = process.argv.slice(2);
  if (!email || (flag !== undefined && flag !== "--apply")) {
    console.error("usage: node scripts/mfa-reset.mjs <email> [--apply]");
    process.exit(2);
  }
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Variables may already be set in the shell.
  }
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) {
    console.error("DATABASE_URL_UNPOOLED is not set (the owner credential in .env.local).");
    process.exit(2);
  }
  const { Pool } = await import("@neondatabase/serverless");
  console.log(`Database host: ${new URL(url).hostname}`);
  const pool = new Pool({ connectionString: url });
  try {
    const result = await resetMfa(pool, email, { apply: flag === "--apply" });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "dry_run") console.log("Nothing changed. Add --apply to reset this person.");
    if (result.status === "not_found") process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
