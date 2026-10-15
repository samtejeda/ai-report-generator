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
