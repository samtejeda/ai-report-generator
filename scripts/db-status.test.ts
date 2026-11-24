import { describe, expect, it } from "vitest";
import {
  analyze,
  checkNeonUrl,
  checkStatus,
  classifyError,
  expectedMigrations,
  readApplied,
  report,
  runCli,
  warningLines,
  type AppliedMigration,
  type StatusClient,
} from "./db-status.mjs";

// No database anywhere in this file: the client is a fake and the journal is the real drizzle/ folder.
const expected = expectedMigrations("drizzle");
const N = expected.length;
const asApplied = (list: typeof expected): AppliedMigration[] => list.map((e) => ({ hash: e.hash, createdAt: e.when }));

const USER = "ownerx";
const PASSWORD = "p%40ss-secret-9";
const TOKEN = "tok123";
const URL_OK = `postgresql://${USER}:${PASSWORD}@ep-dark-cake-b4i1tg5a.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require&token=${TOKEN}`;
const ENDPOINT = "ep-dark-cake-b4i1tg5a.***";
const SECRETS = [USER, PASSWORD, "p@ss-secret-9", TOKEN, "neon.tech", "c-6", "us-east-2", "aws", "neondb"];

function fakeClient(opts: { applied?: AppliedMigration[]; hasJournal?: boolean; fail?: unknown; hang?: boolean }) {
  const queries: string[] = [];
  let ended = false;
  const client: StatusClient & { queries: string[]; ended: () => boolean } = {
    queries,
    ended: () => ended,
    async query(sql: string) {
      queries.push(sql);
      if (opts.hang) return new Promise(() => {});
      if (opts.fail) throw opts.fail;
      if (/to_regclass/.test(sql)) return { rows: [{ has_journal: opts.hasJournal ?? true }] };
      return { rows: (opts.applied ?? []).map((a) => ({ hash: a.hash, created_at: String(a.createdAt) })) };
    },
    end() {
      ended = true;
    },
  };
  return client;
}

async function run(url: string | undefined, client: StatusClient, argv: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({
    argv,
    env: { DATABASE_URL_UNPOOLED: url },
    makeClient: async () => client,
    log: (s) => out.push(s),
    err: (s) => err.push(s),
    timeoutMs: 200,
  });
  return { code, out, err, all: [...out, ...err].join("\n") };
}

describe("the comparison", () => {
  it("all applied: ok", () => {
    const r = analyze(expected, asApplied(expected));
    expect(r.kind).toBe("ok");
    expect(r.missing).toEqual([]);
    expect(r.ahead).toBe(0);
  });

  it("one missing (the newest): missing, and db:migrate can apply it", () => {
    const r = analyze(expected, asApplied(expected.slice(0, -1)));
    expect(r.kind).toBe("missing");
    expect(r.missing.map((m) => m.tag)).toEqual([expected.at(-1)!.tag]);
    expect(r.blocked).toEqual([]);
  });

  it("several missing: all listed in journal order", () => {
    const r = analyze(expected, asApplied(expected.slice(0, -3)));
    expect(r.kind).toBe("missing");
    expect(r.missing.map((m) => m.tag)).toEqual(expected.slice(-3).map((m) => m.tag));
  });

  it("an applied row that is not in the journal is counted as ahead, not as a problem", () => {
    const r = analyze(expected, [...asApplied(expected), { hash: "f".repeat(64), createdAt: Date.now() }]);
    expect(r.kind).toBe("ok");
    expect(r.ahead).toBe(1);
  });

  it("empty database: everything missing, nothing blocked", () => {
    const r = analyze(expected, []);
    expect(r.kind).toBe("missing");
    expect(r.missing).toHaveLength(N);
    expect(r.blocked).toEqual([]);
  });

  it("a missing migration older than the newest applied one is BLOCKED: drizzle would skip it", () => {
    const hole = expected.filter((_, i) => i !== 3);
    const r = analyze(expected, asApplied(hole));
    expect(r.kind).toBe("blocked");
    expect(r.blocked.map((m) => m.tag)).toEqual([expected[3].tag]);
  });

  it("a missing migration with the same timestamp as the newest applied one is also blocked (drizzle needs strictly newer)", () => {
    const last = expected.at(-1)!;
    const r = analyze(
      [...expected, { tag: "9999_same_when", hash: "a".repeat(64), when: last.when }],
      asApplied(expected),
    );
    expect(r.kind).toBe("blocked");
  });
});

describe("reading the database", () => {
  it("asks the first question alone; with no journal it never queries the journal table", async () => {
    const client = fakeClient({ hasJournal: false });
    expect(await readApplied(client)).toEqual([]);
    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]).toMatch(/to_regclass/);
  });

  it("reads hash and created_at as numbers", async () => {
    const client = fakeClient({ applied: asApplied(expected) });
    const rows = await readApplied(client);
    expect(rows).toHaveLength(N);
    expect(typeof rows[0].createdAt).toBe("number");
    expect(client.queries).toHaveLength(2);
    expect(client.queries.every((q) => /^SELECT /.test(q))).toBe(true); // read-only: SELECTs only
  });
});

describe("the output", () => {
  it("OK is one plain line, exit 0", async () => {
    const r = await run(URL_OK, fakeClient({ applied: asApplied(expected) }));
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`OK: all ${N} migrations applied to ${ENDPOINT}`]);
  });

  it("MISSING names the first missing migration, how many more, and the command; exit 1", async () => {
    const r = await run(URL_OK, fakeClient({ applied: asApplied(expected.slice(0, -2)) }));
    expect(r.code).toBe(1);
    expect(r.out[0]).toBe(`MISSING: ${expected.at(-2)!.tag} (and 1 more) on ${ENDPOINT}. Run: npm run db:migrate`);
    expect(r.out.slice(1)).toEqual(expected.slice(-2).map((m) => `  - ${m.tag} (not applied)`));
  });

  it("one missing has no 'and K more'", async () => {
    const r = await run(URL_OK, fakeClient({ applied: asApplied(expected.slice(0, -1)) }));
    expect(r.out[0]).toBe(`MISSING: ${expected.at(-1)!.tag} on ${ENDPOINT}. Run: npm run db:migrate`);
  });

  it("an empty database (no drizzle schema) is MISSING with all of them", async () => {
    const r = await run(URL_OK, fakeClient({ hasJournal: false }));
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(new RegExp(`^MISSING: ${expected[0].tag} \\(and ${N - 1} more\\)`));
  });

  it("BLOCKED says db:migrate will not fix it and does not tell the person to run it as the cure; exit 1", async () => {
    const r = await run(URL_OK, fakeClient({ applied: asApplied(expected.filter((_, i) => i !== 3)) }));
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^BLOCKED: npm run db:migrate will SKIP /);
    expect(r.out[0]).not.toMatch(/Run: npm run db:migrate/);
    expect(r.out[1]).toBe(`  - ${expected[3].tag} (would be skipped by db:migrate)`);
  });

  it("a database that is ahead is still OK (exit 0) with a NOTE line", async () => {
    const r = await run(URL_OK, fakeClient({ applied: [...asApplied(expected), { hash: "e".repeat(64), createdAt: Date.now() }] }));
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(`OK: all ${N} migrations applied to ${ENDPOINT}`);
    expect(r.out[1]).toMatch(/^NOTE: the database also has 1 migration\(s\) this checkout does not have/);
  });

  it("report() on its own: first line first", () => {
    const { lines } = report(analyze(expected, asApplied(expected.slice(0, -1))), ENDPOINT);
    expect(lines[0].startsWith("MISSING:")).toBe(true);
  });
});

describe("drift: a migration applied from a different version of its file", () => {
  // What the real scratch branch showed: same count of rows, same timestamps, two different hashes.
  const edited = (idx: number[]) =>
    asApplied(expected).map((a, i) => (idx.includes(i) ? { ...a, hash: `${i}`.padStart(64, "d") } : a));

  it("analyze: same timestamp, different hash is changed, not missing, not blocked, and not 'ahead'", () => {
    const r = analyze(expected, edited([3]));
    expect(r.kind).toBe("drift");
    expect(r.changed.map((m) => m.tag)).toEqual([expected[3].tag]);
    expect(r.missing).toEqual([]);
    expect(r.blocked).toEqual([]);
    expect(r.ahead).toBe(0);
  });

  it("db:status: DRIFT first line, exit 1, and no 'Run: npm run db:migrate' (it would change nothing)", async () => {
    const r = await run(URL_OK, fakeClient({ applied: edited([3, 5]) }));
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(new RegExp(`^DRIFT: ${expected[3].tag} \\(and 1 more\\) on ${ENDPOINT.replace(/\*/g, "\\*")}: applied from a different version`));
    expect(r.out[0]).not.toMatch(/Run: npm run db:migrate/);
    expect(r.out.slice(1)).toEqual([expected[3], expected[5]].map((m) => `  - ${m.tag} (applied from a different version of the file)`));
  });

  it("a truly missing migration outranks drift, and both are listed with their own label", async () => {
    const applied = edited([3]).slice(0, -1);
    const r = await run(URL_OK, fakeClient({ applied }));
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^MISSING: /);
    expect(r.out).toContain(`  - ${expected.at(-1)!.tag} (not applied)`);
    expect(r.out).toContain(`  - ${expected[3].tag} (applied from a different version of the file)`);
  });

  it("a rows-not-in-journal count still works next to drift (a newer migration from another branch)", () => {
    const r = analyze(expected, [...edited([3]), { hash: "9".repeat(64), createdAt: Date.now() }]);
    expect(r.kind).toBe("drift");
    expect(r.ahead).toBe(1);
  });

  it("--warn stays silent on drift (db:migrate cannot clear it) and exits 0", async () => {
    const r = await run(URL_OK, fakeClient({ applied: edited([3]) }), ["--warn"]);
    expect(r.code).toBe(0);
    expect(r.all).toBe("");
  });

  it("no secret in the drift output", async () => {
    const r = await run(URL_OK, fakeClient({ applied: edited([3]) }));
    for (const s of SECRETS) expect(r.all).not.toContain(s);
  });
});

describe("unreadable: reason codes, exit 2, never the driver's text", () => {
  const cases: [string, unknown, string][] = [
    ["permission denied for schema drizzle", Object.assign(new Error(`permission denied for schema drizzle (${USER}@ep-dark-cake-b4i1tg5a.c-6.us-east-2.aws.neon.tech)`), { code: "42501" }), "permission_denied"],
    ["bad password", Object.assign(new Error(`password authentication failed for user "${USER}"`), { code: "28P01" }), "login_failed"],
    ["connection refused", Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" }), "cannot_connect"],
    ["websocket", new Error("WebSocket connection failed"), "cannot_connect"],
    ["something else", new Error(`boom ${PASSWORD}`), "failed"],
  ];
  for (const [name, error, reason] of cases) {
    it(`${name} -> ${reason}`, async () => {
      expect(classifyError(error)).toBe(reason);
      const r = await run(URL_OK, fakeClient({ fail: error }));
      expect(r.code).toBe(2);
      expect(r.err[0]).toMatch(new RegExp(`^UNREADABLE: ${reason} \\(`));
      for (const s of SECRETS) expect(r.all).not.toContain(s);
    });
  }

  it("a database that never answers: timeout", async () => {
    const client = fakeClient({ hang: true });
    const r = await run(URL_OK, client);
    expect(r.code).toBe(2);
    expect(r.err[0]).toMatch(/^UNREADABLE: timeout \(/);
  });

  it("closes the client, also after a failure", async () => {
    const client = fakeClient({ fail: new Error("x") });
    await run(URL_OK, client);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.ended()).toBe(true);
  });
});

describe("masking and the host check", () => {
  it("shows the endpoint name only", () => {
    expect(checkNeonUrl(URL_OK)).toEqual({ ok: true, endpoint: ENDPOINT });
  });

  it("a pooled Neon host is accepted (this is read-only) and keeps its own label", () => {
    const r = checkNeonUrl("postgresql://u:p@ep-dark-cake-b4i1tg5a-pooler.c-6.us-east-2.aws.neon.tech/db");
    expect(r).toEqual({ ok: true, endpoint: "ep-dark-cake-b4i1tg5a-pooler.***" });
  });

  const refused: [string, string | undefined, string][] = [
    ["no url", undefined, "no_url"],
    ["garbage", "not a url", "url_unparseable"],
    ["http url", "https://ep-x-1.c-6.us-east-2.aws.neon.tech/", "not_postgres_url"],
    ["localhost", `postgresql://${USER}:${PASSWORD}@localhost:5432/db`, "not_neon_host"],
    ["another cloud", `postgresql://${USER}:${PASSWORD}@db.example.com/db`, "not_neon_host"],
    ["lookalike suffix", `postgresql://${USER}:${PASSWORD}@ep-x-1.neon.tech.evil.com/db`, "not_neon_host"],
    ["lookalike prefix", `postgresql://${USER}:${PASSWORD}@evil-neon.tech/db`, "not_neon_host"],
    ["neon host without an endpoint label", `postgresql://${USER}:${PASSWORD}@console.neon.tech/db`, "not_neon_host"],
  ];
  for (const [name, url, reason] of refused) {
    it(`refuses ${name} and prints no secret`, async () => {
      const client = fakeClient({ applied: asApplied(expected) });
      const r = await run(url, client);
      expect(r.code).toBe(2);
      expect(r.err[0]).toMatch(new RegExp(`^UNREADABLE: ${reason} \\(`));
      expect(client.queries).toEqual([]); // never connected
      for (const s of SECRETS.filter((x) => !["aws", "neondb", "c-6", "us-east-2", "neon.tech"].includes(x))) expect(r.all).not.toContain(s);
      expect(r.all).not.toContain("db.example.com");
      expect(r.all).not.toContain("evil");
    });
  }

  it("no output of any kind contains the user, the password, the token or the rest of the host", async () => {
    const scenarios = [
      fakeClient({ applied: asApplied(expected) }),
      fakeClient({ applied: asApplied(expected.slice(0, -2)) }),
      fakeClient({ applied: asApplied(expected.filter((_, i) => i !== 3)) }),
      fakeClient({ hasJournal: false }),
      fakeClient({ fail: Object.assign(new Error(`bad ${URL_OK}`), { code: "28P01" }) }),
    ];
    for (const client of scenarios) {
      for (const argv of [[], ["--warn"]]) {
        const r = await run(URL_OK, client, argv);
        for (const s of SECRETS) expect(r.all).not.toContain(s);
      }
    }
  });
});

describe("--warn (what npm run dev runs): never blocks, quiet unless behind", () => {
  it("silent and 0 when everything is applied", async () => {
    const r = await run(URL_OK, fakeClient({ applied: asApplied(expected) }), ["--warn"]);
    expect(r.code).toBe(0);
    expect(r.all).toBe("");
  });

  it("silent and 0 when the database is ahead", async () => {
    const r = await run(URL_OK, fakeClient({ applied: [...asApplied(expected), { hash: "e".repeat(64), createdAt: Date.now() }] }), ["--warn"]);
    expect(r.code).toBe(0);
    expect(r.all).toBe("");
  });

  it("silent and 0 without an owner URL, and never connects", async () => {
    const client = fakeClient({});
    const r = await run(undefined, client, ["--warn"]);
    expect(r.code).toBe(0);
    expect(r.all).toBe("");
    expect(client.queries).toEqual([]);
  });

  it("silent and 0 on a host that is not Neon", async () => {
    const client = fakeClient({});
    const r = await run(`postgresql://u:p@localhost/db`, client, ["--warn"]);
    expect(r.code).toBe(0);
    expect(r.all).toBe("");
    expect(client.queries).toEqual([]);
  });

  it("silent and 0 on a timeout", async () => {
    const r = await run(URL_OK, fakeClient({ hang: true }), ["--warn"]);
    expect(r.code).toBe(0);
    expect(r.all).toBe("");
  });

  it("silent and 0 when the database cannot be read", async () => {
    const r = await run(URL_OK, fakeClient({ fail: Object.assign(new Error("x"), { code: "28P01" }) }), ["--warn"]);
    expect(r.code).toBe(0);
    expect(r.all).toBe("");
  });

  it("silent and 0 even when building the client throws", async () => {
    const out: string[] = [];
    const code = await runCli({
      argv: ["--warn"],
      env: { DATABASE_URL_UNPOOLED: URL_OK },
      makeClient: async () => {
        throw new Error("driver exploded");
      },
      log: (s) => out.push(s),
      err: (s) => out.push(s),
      timeoutMs: 200,
    });
    expect(code).toBe(0);
    expect(out).toEqual([]);
  });

  it("prints a prominent MISSING block and still exits 0", async () => {
    const r = await run(URL_OK, fakeClient({ applied: asApplied(expected.slice(0, -1)) }), ["--warn"]);
    expect(r.code).toBe(0);
    expect(r.err[0]).toMatch(/^={20,}$/);
    expect(r.err.join("\n")).toContain("DATABASE IS BEHIND THIS CODE");
    expect(r.err.join("\n")).toContain(`MISSING: ${expected.at(-1)!.tag} on ${ENDPOINT}. Run: npm run db:migrate`);
    expect(r.err.join("\n")).toContain("npm run db:status");
  });

  it("prints the BLOCKED block too", async () => {
    const r = await run(URL_OK, fakeClient({ applied: asApplied(expected.filter((_, i) => i !== 3)) }), ["--warn"]);
    expect(r.code).toBe(0);
    expect(r.err.join("\n")).toContain("BLOCKED:");
  });

  it("warningLines never carries more than the one plain line", () => {
    const lines = warningLines(analyze(expected, asApplied(expected.slice(0, -3))), ENDPOINT);
    expect(lines.filter((l) => l.includes("MISSING:"))).toHaveLength(1);
    expect(lines.length).toBeLessThanOrEqual(5);
  });
});

describe("checkStatus", () => {
  it("never throws when the client factory rejects", async () => {
    const { result } = await checkStatus({ url: URL_OK, makeClient: async () => Promise.reject(new Error("nope")), timeoutMs: 100 });
    expect(result).toEqual({ kind: "unreadable", reason: "failed" });
  });

  it("uses the real journal: the expected list has one entry per journal row and strictly increasing timestamps", () => {
    expect(N).toBeGreaterThan(10);
    const whens = expected.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(expected.map((e) => e.hash)).size).toBe(N);
  });
});
