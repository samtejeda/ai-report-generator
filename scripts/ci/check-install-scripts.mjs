// CI guard (audit 15 item 2): the build fails if a package outside the recorded
// allowlist has an install script (preinstall / install / postinstall, or a native
// build via binding.gyp). Install scripts run arbitrary code on the machine that runs
// `npm ci`, so a new one is a decision, not an accident.
//
// Two modes, run at two points in CI:
//   lockfile   BEFORE `npm ci`: reads the hasInstallScript flags in package-lock.json,
//              so an unlisted package fails before any install script has run.
//   installed  AFTER `npm ci`: reads the real node_modules/**/package.json, which catches
//              a lockfile whose flag does not match the package. This one is detection,
//              not prevention (the script already ran), which is why the first mode exists.
//
// The allowlist is scripts/ci/install-script-allowlist.json: one entry per package name
// with the reason it is legitimate (also recorded in PROGRESS.md).
// Plain Node, no dependencies.
// Usage: node scripts/ci/check-install-scripts.mjs lockfile|installed [--allowlist file]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];

/** "node_modules/a/node_modules/@s/b" -> "@s/b" */
export function packageNameFromLockPath(lockPath) {
  const marker = "node_modules/";
  return lockPath.slice(lockPath.lastIndexOf(marker) + marker.length);
}

/** @returns {Map<string, string[]>} package name -> versions that have an install script, from the lockfile flags */
export function lockfileInstallScriptPackages(lock) {
  const found = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === "" || !entry.hasInstallScript) continue;
    const name = packageNameFromLockPath(key);
    found.set(name, [...(found.get(name) ?? []), entry.version ?? "?"]);
  }
  return found;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Walks an installed node_modules tree (not following symlinks) and reports packages that
 * would run an install step: an install hook in package.json, `gypfile: true`, or a
 * binding.gyp (npm runs node-gyp implicitly when one is present).
 * @returns {Map<string, string[]>} package name -> versions
 */
export function scanInstalled(nodeModulesDir) {
  const found = new Map();
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.isSymbolicLink() || !e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name.startsWith("@")) {
        visit(full); // scope directory: its children are the packages
        continue;
      }
      const pkg = readJson(path.join(full, "package.json"));
      if (pkg) {
        const hasHook = INSTALL_HOOKS.some((h) => pkg.scripts?.[h]);
        const hasGyp = pkg.gypfile === true || fs.existsSync(path.join(full, "binding.gyp"));
        if (hasHook || hasGyp) {
          const name = pkg.name ?? path.relative(nodeModulesDir, full);
          found.set(name, [...(found.get(name) ?? []), pkg.version ?? "?"]);
        }
      }
      visit(path.join(full, "node_modules"));
    }
  };
  visit(nodeModulesDir);
  return found;
}

/**
 * @param {Map<string, string[]>} found packages that have install scripts
 * @param {Record<string, {reason: string}>} allowed the allowlist's `packages` object
 * @returns {{unlisted: string[], stale: string[], noReason: string[]}}
 */
export function compareToAllowlist(found, allowed) {
  return {
    unlisted: [...found.keys()].filter((n) => !(n in allowed)).sort(),
    stale: Object.keys(allowed).filter((n) => !found.has(n)).sort(),
    noReason: Object.entries(allowed)
      .filter(([, v]) => typeof v?.reason !== "string" || v.reason.trim().length < 10)
      .map(([n]) => n)
      .sort(),
  };
}

function main() {
  const mode = process.argv[2];
  if (mode !== "lockfile" && mode !== "installed") {
    console.error("usage: check-install-scripts.mjs lockfile|installed [--allowlist file]");
    process.exit(2);
  }
  const ai = process.argv.indexOf("--allowlist");
  const allowlistFile = ai > -1 ? process.argv[ai + 1] : "scripts/ci/install-script-allowlist.json";
  const allowed = JSON.parse(fs.readFileSync(allowlistFile, "utf8")).packages ?? {};

  const found =
    mode === "lockfile"
      ? lockfileInstallScriptPackages(JSON.parse(fs.readFileSync("package-lock.json", "utf8")))
      : scanInstalled("node_modules");
  const { unlisted, stale, noReason } = compareToAllowlist(found, allowed);

  // Only in lockfile mode: platform-specific packages (fsevents is macOS-only) are legitimately
  // absent from a Linux node_modules, so "not installed" does not mean "stale" there.
  for (const n of mode === "lockfile" ? stale : []) {
    // A warning, not a failure: removing a dependency should not force an allowlist edit in the same breath.
    console.warn(`warning: "${n}" is in the allowlist but no package in the lockfile has an install script now; remove it from ${allowlistFile}.`);
  }
  if (unlisted.length || noReason.length) {
    console.error(`Install-script check FAILED (${mode}):`);
    for (const n of unlisted) {
      console.error(`  - ${n}@${found.get(n).join(", ")} has an install script and is not in ${allowlistFile}`);
    }
    for (const n of noReason) {
      console.error(`  - allowlist entry "${n}" has no reason (write why it is legitimate)`);
    }
    console.error(
      "An install script runs arbitrary code during `npm ci`. If this one is legitimate, add it to the allowlist\n" +
        "with a reason (and record it in PROGRESS.md) in the same PR; otherwise remove or replace the dependency.",
    );
    process.exit(1);
  }
  console.log(
    `Install-script check passed (${mode}): ${found.size} package(s) with install scripts, all on the allowlist: ${[...found.keys()].sort().join(", ") || "(none)"}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
