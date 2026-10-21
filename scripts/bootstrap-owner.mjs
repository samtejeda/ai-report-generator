// Creates a practice and its first owner. Run by Sam (the person holding the database owner
// credential) to bring up organization #1, and later each new tenant. It is the one way an
// organization and an owner come to exist: there is no sign-up in the app (`disableSignUp`), and
// the app's database role cannot create organizations.
//
//   node scripts/bootstrap-owner.mjs --org "Practice name" --email owner@example.com --name "Display Name"
//        dry run: shows the database host, what exists, and what it would create
//   node scripts/bootstrap-owner.mjs ... --apply        does it
//        optional: --state RI   (two letters)
//
// What it does, in ONE transaction: creates the organization; creates the owner (email marked
// verified, because the person holding the owner credential is vouching for the address); gives the
// owner a one-time password (hashed with the same scrypt Better Auth uses); writes two audit rows.
// It prints the one-time password ONCE and stores only its hash. Hand it to the owner privately
// (not by email, not in chat with other people). At the first sign-in the owner is sent to set up an
// authenticator app (MFA is required), and should then replace the password with the "Change
// password" form on /account. (If the one-time password is lost first, "Forgot password" on /login
// works too; in development the emailed link is printed in the server log.)
//
// It refuses (and changes nothing) if the email already has an account, or an organization with the
// same name exists. It never prints a hash or any secret except that one-time password.
//
// It uses DATABASE_URL_UNPOOLED (the owner credential, from .env.local), so run it only on a machine
// you trust, and check the host name it prints before using --apply. SYNTHETIC DATA ONLY until
// Phase C: do not put a real practice's details in a development database.

import { randomInt } from "node:crypto";
import { hashPassword } from "better-auth/crypto";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// No 0/O/1/l/I look-alikes, so a password read aloud or copied by eye survives.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** 5 groups of 5 characters, about 120 bits. Long enough for PASSWORD_MIN_LENGTH (12) with room. */
export function generateTemporaryPassword() {
  return Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")).join("-");
}

function clean(input) {
  const org = String(input.org ?? "").trim();
  const email = String(input.email ?? "").trim().toLowerCase();
  const name = String(input.name ?? "").trim();
  const state = input.state === undefined ? null : String(input.state).trim().toUpperCase();
  if (!org || org.length > 200) return { error: "invalid_org" };
  if (!EMAIL.test(email) || email.length > 254) return { error: "invalid_email" };
  if (!name || name.length > 200) return { error: "invalid_name" };
  if (state !== null && !/^[A-Z]{2}$/.test(state)) return { error: "invalid_state" };
  return { org, email, name, state };
}

export async function bootstrapOwner(pool, input, { apply }) {
  const v = clean(input);
  if (v.error) return { status: v.error };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const dupEmail = await client.query("select 1 from users where email = $1", [v.email]);
    if (dupEmail.rows.length) {
      await client.query("rollback");
      return { status: "email_exists" };
    }
    const dupOrg = await client.query("select 1 from organizations where lower(name) = lower($1) and deleted_at is null", [v.org]);
    if (dupOrg.rows.length) {
      await client.query("rollback");
      return { status: "org_exists" };
    }
    const existing = {
      organizations: (await client.query("select count(*)::int n from organizations where deleted_at is null")).rows[0].n,
      users: (await client.query("select count(*)::int n from users")).rows[0].n,
    };
    if (!apply) {
      await client.query("rollback");
      return { status: "dry_run", wouldCreate: { organization: v.org, state: v.state, ownerEmail: v.email, ownerName: v.name }, existing };
    }

    const org = (await client.query("insert into organizations (name, state) values ($1, $2) returning id", [v.org, v.state])).rows[0];
    const user = (
      await client.query(
        "insert into users (organization_id, email, display_name, role, email_verified) values ($1, $2, $3, 'owner', true) returning id",
        [org.id, v.email, v.name],
      )
    ).rows[0];
    const temporaryPassword = generateTemporaryPassword();
    await client.query("insert into auth_accounts (user_id, account_id, provider_id, password) values ($1, $2, 'credential', $3)", [
      user.id,
      user.id,
      await hashPassword(temporaryPassword),
    ]);
    const meta = JSON.stringify({ method: "bootstrap_script" });
    await client.query(
      `insert into audit_log (organization_id, actor_user_id, action, resource_type, resource_id, outcome, metadata)
       values ($1, null, 'org.created', 'organizations', $1, 'success', $2::jsonb),
              ($1, null, 'user.created', 'users', $3, 'success', $4::jsonb)`,
      [org.id, meta, user.id, JSON.stringify({ method: "bootstrap_script", role: "owner" })],
    );
    await client.query("commit");
    return { status: "created", organizationId: org.id, userId: user.id, email: v.email, temporaryPassword };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    // A race with another creator of the same address: report it like the pre-check does.
    if (error && typeof error === "object" && error.code === "23505") return { status: "email_exists" };
    throw error;
  } finally {
    client.release();
  }
}

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (["--org", "--email", "--name", "--state"].includes(a)) out[a.slice(2)] = argv[++i];
    else return null;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args || args.org === undefined || args.email === undefined || args.name === undefined) {
    console.error('usage: node scripts/bootstrap-owner.mjs --org "Practice name" --email <email> --name "Display Name" [--state RI] [--apply]');
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
    const { temporaryPassword, ...rest } = await bootstrapOwner(pool, args, { apply: args.apply });
    console.log(JSON.stringify(rest, null, 2));
    if (rest.status === "dry_run") console.log("Nothing changed. Add --apply to create the practice and its owner.");
    else if (rest.status === "created") {
      console.log("\nOne-time password (shown once, not stored; give it to the owner privately):");
      console.log(`  ${temporaryPassword}`);
      console.log("\nThe owner signs in and sets up an authenticator app when asked, then replaces this password with the \"Change password\" form on /account.");
    } else process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
