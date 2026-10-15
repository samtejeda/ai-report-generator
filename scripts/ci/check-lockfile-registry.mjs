// CI guard (audit 15 item 3): every package in package-lock.json must come from
// registry.npmjs.org and carry an integrity hash. `npm ci` verifies the hashes; this
// closes the other half: a lockfile entry pointing at a git repo, a tarball URL, a
// lookalike host or a local path would be installed without any registry involvement.
//
// Plain Node, no dependencies. Usage: node scripts/ci/check-lockfile-registry.mjs [package-lock.json]
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const REGISTRY_PREFIX = "https://registry.npmjs.org/";

// Print where a bad URL points (scheme + host) but never the path or query: a git or
// tarball URL can carry a token, and CI logs on a public repo are public.
function describeSource(resolved) {
  try {
    const u = new URL(resolved);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(unparseable URL)";
  }
}

/** @returns {string[]} one human-readable line per violation; empty means the lockfile is clean */
export function findLockfileViolations(lock) {
  const violations = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === "") continue; // the root project
    if (entry.link) {
      violations.push(`${key}: linked local package (link: true)`);
      continue;
    }
    if (!entry.resolved) {
      // Bundled dependencies ship inside their parent's tarball, which is itself hash-checked.
      if (entry.inBundle) continue;
      violations.push(`${key}: no resolved URL`);
      continue;
    }
    // The trailing slash matters: it rejects "https://registry.npmjs.org.evil.example/"
    // and "https://registry.npmjs.org@evil.example/".
    if (!entry.resolved.startsWith(REGISTRY_PREFIX)) {
      violations.push(`${key}: resolved outside registry.npmjs.org (${describeSource(entry.resolved)})`);
    }
    if (!entry.integrity) {
      violations.push(`${key}: no integrity hash`);
    }
  }
  return violations;
}

function main() {
  const file = process.argv[2] ?? "package-lock.json";
  const lock = JSON.parse(fs.readFileSync(file, "utf8"));
  const violations = findLockfileViolations(lock);
  const count = Object.keys(lock.packages ?? {}).length - 1;
  if (violations.length) {
    console.error(`Lockfile check FAILED: ${violations.length} problem(s) in ${file}:`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error("Every package must resolve from https://registry.npmjs.org/ with an integrity hash.");
    process.exit(1);
  }
  console.log(`Lockfile check passed: ${count} entries, all from registry.npmjs.org with integrity hashes.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
