import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findLockfileViolations } from "./check-lockfile-registry.mjs";
import {
  compareToAllowlist,
  lockfileInstallScriptPackages,
  packageNameFromLockPath,
  scanInstalled,
} from "./check-install-scripts.mjs";
import {
  RESET_SQL,
  ROLE_PATTERN,
  checkHost,
  compareMigrations,
  expectedMigrationHashes,
  redact,
  resetDatabase,
  resetProblems,
} from "./reset-ci-database.mjs";

const REG = "https://registry.npmjs.org";
const ok = (name: string, extra: Record<string, unknown> = {}) => ({
  version: "1.0.0",
  resolved: `${REG}/${name}/-/${name}-1.0.0.tgz`,
  integrity: "sha512-abc",
  ...extra,
});

describe("lockfile registry check", () => {
  it("passes a clean lockfile, including bundled entries that have no resolved URL", () => {
    const lock = {
      packages: {
        "": { name: "app" },
        "node_modules/a": ok("a"),
        "node_modules/@s/b": ok("b"),
        "node_modules/a/node_modules/c": { version: "1.0.0", inBundle: true },
      },
    };
    expect(findLockfileViolations(lock)).toEqual([]);
  });

  it.each([
    ["a git dependency", "git+ssh://git@github.com/x/y.git#abc123"],
    ["a plain http registry", "http://registry.npmjs.org/a/-/a-1.0.0.tgz"],
    ["another registry", "https://registry.example.com/a/-/a-1.0.0.tgz"],
    ["a lookalike host", "https://registry.npmjs.org.evil.example/a/-/a-1.0.0.tgz"],
    ["a userinfo trick", "https://registry.npmjs.org@evil.example/a/-/a-1.0.0.tgz"],
    ["a local file", "file:../vendored/a.tgz"],
  ])("fails %s", (_label, resolved) => {
    const v = findLockfileViolations({ packages: { "": {}, "node_modules/a": ok("a", { resolved }) } });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("node_modules/a");
  });

  it("fails an entry with no integrity hash", () => {
    const v = findLockfileViolations({ packages: { "": {}, "node_modules/a": ok("a", { integrity: undefined }) } });
    expect(v).toEqual(["node_modules/a: no integrity hash"]);
  });

  it("fails an unbundled entry with no resolved URL, and a linked package", () => {
    const v = findLockfileViolations({
      packages: { "": {}, "node_modules/a": { version: "1.0.0" }, "node_modules/b": { link: true, resolved: "../b" } },
    });
    expect(v).toHaveLength(2);
  });

  it("never prints a token that is embedded in a bad URL's path or query", () => {
    const secret = "ghp_SECRETTOKEN123";
    const v = findLockfileViolations({
      packages: { "": {}, "node_modules/a": ok("a", { resolved: `https://git.example.com/x/y/tarball/main?token=${secret}` }) },
    });
    expect(v.join("\n")).toContain("https://git.example.com");
    expect(v.join("\n")).not.toContain(secret);
  });
});

describe("install-script allowlist (lockfile mode)", () => {
  it("derives the package name from nested lockfile paths", () => {
    expect(packageNameFromLockPath("node_modules/esbuild")).toBe("esbuild");
    expect(packageNameFromLockPath("node_modules/a/node_modules/@s/b")).toBe("@s/b");
  });

  const lock = {
    packages: {
      "": {},
      "node_modules/esbuild": { version: "0.28.2", hasInstallScript: true },
      "node_modules/x/node_modules/esbuild": { version: "0.18.20", hasInstallScript: true },
      "node_modules/plain": { version: "1.0.0" },
      "node_modules/newcomer": { version: "2.0.0", hasInstallScript: true },
    },
  };

  it("collects every version of a package that has an install script", () => {
    const found = lockfileInstallScriptPackages(lock);
    expect([...found.keys()].sort()).toEqual(["esbuild", "newcomer"]);
    expect(found.get("esbuild")).toEqual(["0.28.2", "0.18.20"]);
  });

  it("flags a package that is not on the allowlist, warns on a stale entry, and requires a reason", () => {
    const found = lockfileInstallScriptPackages(lock);
    const r = compareToAllowlist(found, {
      esbuild: { reason: "downloads and verifies its platform binary" },
      "gone-package": { reason: "was removed from the lockfile" },
      lazy: { reason: "" },
    });
    expect(r.unlisted).toEqual(["newcomer"]);
    expect(r.stale).toEqual(["gone-package", "lazy"]);
    expect(r.noReason).toEqual(["lazy"]);
  });
});

describe("install-script scan (installed mode)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nm-scan-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const pkg = (dir: string, json: Record<string, unknown>, files: string[] = []) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "package.json"), JSON.stringify(json));
    for (const f of files) fs.writeFileSync(path.join(root, dir, f), "");
  };

  it("finds install hooks, implicit node-gyp builds, scoped and nested packages; ignores harmless ones and symlinks", () => {
    pkg("hooked", { name: "hooked", version: "1.0.0", scripts: { postinstall: "node x.js" } });
    pkg("harmless", { name: "harmless", version: "1.0.0", scripts: { test: "vitest", build: "tsc" } });
    pkg("native", { name: "native", version: "1.0.0" }, ["binding.gyp"]);
    pkg("@s/scoped", { name: "@s/scoped", version: "2.0.0", scripts: { install: "node y.js" } });
    pkg("outer/node_modules/inner", { name: "inner", version: "3.0.0", scripts: { preinstall: "node z.js" } });
    pkg("outer", { name: "outer", version: "1.0.0" });
    fs.symlinkSync(path.join(root, "hooked"), path.join(root, "linked"));
    fs.mkdirSync(path.join(root, ".bin"));

    const found = scanInstalled(root);
    expect([...found.keys()].sort()).toEqual(["@s/scoped", "hooked", "inner", "native"]);
  });
});

// ---------------------------------------------------------------------------------------------
// CI database reset (scripts/ci/reset-ci-database.mjs)
// ---------------------------------------------------------------------------------------------

const CI_HOST = "ep-ci-example-123456.c-6.us-east-2.aws.neon.tech";
const ciUrl = (host: string, pw = "s3cr3t-pw-value") => `postgresql://neondb_owner:${pw}@${host}/neondb?sslmode=require`;

describe("reset guard: host allow-list", () => {
  it("accepts exactly the allow-listed host (case-insensitive)", () => {
    expect(checkHost(ciUrl(CI_HOST), CI_HOST)).toEqual({ ok: true });
    expect(checkHost(ciUrl(CI_HOST.toUpperCase()), CI_HOST)).toEqual({ ok: true });
  });

  it.each([
    ["another project's host (dev)", ciUrl("ep-dev-example-999999.c-6.us-east-2.aws.neon.tech")],
    ["a lookalike suffix", ciUrl(`${CI_HOST}.evil.example`)],
    ["a lookalike prefix", ciUrl(`x${CI_HOST}`)],
    ["a userinfo trick", `postgresql://${CI_HOST}:pw@evil.example/neondb`],
    ["the pooled form of the right host", ciUrl(CI_HOST.replace("ep-ci-example-123456", "ep-ci-example-123456-pooler"))],
    ["localhost", ciUrl("localhost")],
  ])("refuses %s", (_label, url) => {
    expect(checkHost(url, CI_HOST).ok).toBe(false);
  });

  it("refuses when either value is missing, empty, or not a postgres URL", () => {
    expect(checkHost(undefined, CI_HOST).ok).toBe(false);
    expect(checkHost("", CI_HOST).ok).toBe(false);
    expect(checkHost(ciUrl(CI_HOST), undefined).ok).toBe(false);
    expect(checkHost(ciUrl(CI_HOST), "  ").ok).toBe(false);
    expect(checkHost("not a url", CI_HOST).ok).toBe(false);
    expect(checkHost(`https://${CI_HOST}/`, CI_HOST).ok).toBe(false);
  });

  it("explains a refusal without echoing the host, user or password", () => {
    const wrong = ciUrl("ep-dev-example-999999.c-6.us-east-2.aws.neon.tech", "hunter2-hunter2");
    const v = checkHost(wrong, CI_HOST);
    expect(v.ok).toBe(false);
    const text = JSON.stringify(v);
    for (const secret of ["hunter2-hunter2", "ep-dev-example-999999", "neondb_owner", CI_HOST]) expect(text).not.toContain(secret);
  });
});

describe("reset guard: redaction", () => {
  it("removes the URL, password (plain and percent-encoded), user and host from any message", () => {
    const url = "postgresql://neondb_owner:p%40ss%2Fword99@ep-x-1.c-6.us-east-2.aws.neon.tech/neondb";
    const msg = `connect failed for ${url}: password p@ss/word99 rejected for neondb_owner at ep-x-1.c-6.us-east-2.aws.neon.tech`;
    const out = redact(msg, url);
    for (const secret of ["p%40ss%2Fword99", "p@ss/word99", "neondb_owner", "ep-x-1.c-6", url]) expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("leaves a message alone when there is nothing to hide", () => {
    expect(redact("syntax error at or near DROP", undefined)).toBe("syntax error at or near DROP");
  });
});

describe("reset SQL", () => {
  const dropped = [...RESET_SQL.matchAll(/DROP\s+(\w+)\s+(?:IF EXISTS\s+)?([^\s;%]+)/gi)].map((m) => `${m[1]} ${m[2]}`.toUpperCase());

  it("drops only the drizzle and public schemas, plus roles chosen by the role pattern", () => {
    expect(dropped.sort()).toEqual(["SCHEMA DRIZZLE", "SCHEMA PUBLIC"]);
    // The only role drop is inside the loop over roles selected by the pattern.
    expect(RESET_SQL.match(/DROP ROLE/g)).toHaveLength(1);
    expect(RESET_SQL).toContain(
      `FOR r IN SELECT rolname FROM pg_roles WHERE rolname ~ '${ROLE_PATTERN}' ORDER BY rolname LOOP\n    EXECUTE format('DROP ROLE %I', r.rolname);`,
    );
    for (const forbidden of [/DROP\s+DATABASE/i, /TRUNCATE/i, /DROP\s+OWNED/i, /DROP\s+EXTENSION/i, /ALTER\s+SYSTEM/i]) {
      expect(RESET_SQL).not.toMatch(forbidden);
    }
  });

  it("is one atomic block (a single DO) and fails if the public schema comes back different", () => {
    expect(RESET_SQL.match(/\$reset\$/g)).toHaveLength(2);
    expect(RESET_SQL).toMatch(/RAISE EXCEPTION 'public schema differs after reset/);
  });

  it("the role pattern matches the migration and suite roles and nothing else", () => {
    const re = new RegExp(ROLE_PATTERN);
    for (const ok of ["app_runtime", "auth_runtime", "app_runtime_test", "auth_runtime_authz", "app_runtime_authtest"]) expect(re.test(ok)).toBe(true);
    for (const no of ["neondb_owner", "neon_superuser", "cloud_admin", "pg_read_all_data", "app_runtime_", "app_runtime-x", "my_app_runtime", "app_runtime_a_b", "authenticated", "app_runtimeX"]) expect(re.test(no)).toBe(false);
  });

  it("every role name the real integration suites create matches the pattern", () => {
    // A suite that names a role differently would leak it past the reset; fail here instead.
    const re = new RegExp(ROLE_PATTERN);
    const files = [
      "lib/db/integration.test.ts",
      "lib/auth/integration-harness.ts",
      ...fs.readdirSync("lib/auth").filter((f) => f.endsWith(".integration.test.ts")).map((f) => `lib/auth/${f}`),
    ];
    const names = new Set<string>();
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:APP_ROLE|AUTH_ROLE)\s*=\s*"([^"]+)"/g)) names.add(m[1]);
      for (const m of text.matchAll(/(?:appRole|authRole):\s*"([^"]+)"/g)) names.add(m[1]);
    }
    expect(names.size).toBeGreaterThanOrEqual(10);
    for (const n of names) expect(re.test(n), `role "${n}" would not be dropped by the reset`).toBe(true);
  });
});

describe("migration comparison", () => {
  it("reads one hash per journal entry from the real drizzle folder", () => {
    const expected = expectedMigrationHashes("drizzle");
    const journal = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8"));
    expect(expected).toHaveLength(journal.entries.length);
    expect(expected[0].tag).toBe("0000_enable_pgvector");
    expect(new Set(expected.map((e) => e.hash)).size).toBe(expected.length);
  });

  const expected = [
    { tag: "0000_a", hash: "h0" },
    { tag: "0001_b", hash: "h1" },
  ];
  it("passes when the database holds exactly the expected migrations", () => {
    expect(compareMigrations(expected, ["h1", "h0"])).toEqual([]);
  });
  it("reports a missing, an extra (leftover from another branch) and a duplicated migration", () => {
    expect(compareMigrations(expected, ["h0"])).toEqual(["migration 0001_b is in drizzle/ but not applied"]);
    expect(compareMigrations(expected, ["h0", "h1", "hX"])[0]).toContain("not in drizzle/");
    expect(compareMigrations(expected, ["h0", "h1", "h1"])).toEqual(["migration 0001_b is applied 2 times"]);
  });
});

describe("reset flow (fake client)", () => {
  const clean = { public_tables: 0, public_functions: 0, runtime_roles: null, runtime_role_settings: 0, migrations_applied: null };
  const dirty = { public_tables: 12, public_functions: 3, runtime_roles: "app_runtime,app_runtime_test", runtime_role_settings: 1, migrations_applied: 15 };

  function fakeClient(states: Record<string, unknown>[]) {
    const executed: string[] = [];
    let i = 0;
    return {
      executed,
      async query(text: string) {
        executed.push(text);
        return text === RESET_SQL ? { rows: [] } : { rows: [states[Math.min(i++, states.length - 1)]] };
      },
    };
  }

  it("reads the state, runs the reset block once, reads the state again, and logs both", async () => {
    const c = fakeClient([dirty, clean]);
    const lines: string[] = [];
    await resetDatabase(c, (l: string) => lines.push(l));
    expect(c.executed.filter((t) => t === RESET_SQL)).toHaveLength(1);
    expect(lines[0]).toContain("before:");
    expect(lines[0]).toContain("app_runtime_test");
    expect(lines[1]).toContain("after:");
  });

  it("fails when anything is left behind", async () => {
    await expect(resetDatabase(fakeClient([dirty, dirty]), () => {})).rejects.toThrow(/did not leave a clean database/);
    expect(resetProblems({ ...clean, runtime_role_settings: 1 })).toEqual(["1 role-level setting(s) remain"]);
    expect(resetProblems(clean)).toEqual([]);
  });
});
