import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INFERENCE_ENDPOINT_PATTERN } from "@/lib/db/schema/organizations";
import { INFERENCE_ENDPOINT_MAX_LENGTH, inferenceBaseUrl, validateInferenceEndpoint } from "./inference-endpoint";

// Audit 04 item 8: only an allow-listed Tailscale address may be stored as a practice's
// inference endpoint. Synthetic names only.

const ACCEPTED = [
  "https://studio-mac.tail1234.ts.net",
  "https://studio-mac.tail1234.ts.net/v1",
  "https://studio-mac.tail1234.ts.net:443",
  "https://studio-mac.tail1234.ts.net:8443/v1",
  "https://studio-mac.tail1234.ts.net:10000",
  "https://a.b.ts.net",
  "https://a1.b-2.c3.ts.net/v1",
  "https://x.y.z.w.ts.net",
];

const REFUSED: [string, string][] = [
  ["plain http", "http://studio-mac.tail1234.ts.net"],
  ["http with the Ollama port", "http://studio-mac.tail1234.ts.net:11434/v1"],
  ["localhost", "https://localhost"],
  ["localhost with port", "http://localhost:11434/v1"],
  ["loopback address", "https://127.0.0.1"],
  ["loopback with port", "http://127.0.0.1:11434"],
  ["private address", "https://10.0.0.5"],
  ["private address 192", "https://192.168.1.10/v1"],
  ["cloud metadata address", "http://169.254.169.254/latest/meta-data"],
  ["cloud metadata over https", "https://169.254.169.254"],
  ["Tailscale CGNAT address", "https://100.101.102.103"],
  ["IPv6 loopback", "https://[::1]"],
  ["IPv6 literal", "https://[fd7a:115c:a1e0::1]"],
  ["decimal IP", "https://2130706433"],
  ["hex IP", "https://0x7f000001"],
  ["user info before the host", "https://user@studio-mac.tail1234.ts.net"],
  ["user info with a look-alike", "https://studio-mac.tail1234.ts.net@evil.example"],
  ["user info trick", "https://evil.example@studio-mac.tail1234.ts.net"],
  ["suffix attack", "https://studio-mac.tail1234.ts.net.evil.example"],
  ["suffix as a path", "https://evil.example/.ts.net"],
  ["suffix as a path, deeper", "https://evil.example/a.b.ts.net"],
  ["suffix in a fragment", "https://evil.example#.a.b.ts.net"],
  ["suffix in a query", "https://evil.example?x=a.b.ts.net"],
  ["look-alike domain", "https://studio-mac.tail1234.ts.net-evil.example"],
  ["look-alike TLD", "https://studio-mac.tail1234.tsxnet"],
  ["wrong suffix", "https://studio-mac.tail1234.example.com"],
  ["bare suffix", "https://ts.net"],
  ["one label before the suffix", "https://studio-mac.ts.net"],
  ["upper case host", "https://Studio-Mac.tail1234.ts.net"],
  ["upper case scheme", "HTTPS://studio-mac.tail1234.ts.net"],
  ["trailing dot", "https://studio-mac.tail1234.ts.net."],
  ["punycode label", "https://xn--studio-mac.tail1234.ts.net"],
  ["punycode second label", "https://studio-mac.xn--tail.ts.net"],
  ["non-ASCII host", "https://stüdio.tail1234.ts.net"],
  ["percent-encoded dot", "https://studio-mac%2etail1234.ts.net"],
  ["percent-encoded host", "https://studio%2Dmac.tail1234.ts.net"],
  ["backslash", "https://evil.example\\@studio-mac.tail1234.ts.net"],
  ["other port", "https://studio-mac.tail1234.ts.net:11434"],
  ["port 80", "https://studio-mac.tail1234.ts.net:80"],
  ["port zero", "https://studio-mac.tail1234.ts.net:0"],
  ["empty port", "https://studio-mac.tail1234.ts.net:"],
  ["other path", "https://studio-mac.tail1234.ts.net/admin"],
  ["deeper path", "https://studio-mac.tail1234.ts.net/v1/chat/completions"],
  ["path traversal", "https://studio-mac.tail1234.ts.net/v1/../../etc/passwd"],
  ["trailing slash", "https://studio-mac.tail1234.ts.net/"],
  ["double slash path", "https://studio-mac.tail1234.ts.net//v1"],
  ["query string", "https://studio-mac.tail1234.ts.net/v1?x=1"],
  ["fragment", "https://studio-mac.tail1234.ts.net/v1#x"],
  ["scheme-relative", "//studio-mac.tail1234.ts.net"],
  ["no scheme", "studio-mac.tail1234.ts.net"],
  ["other scheme", "ftp://studio-mac.tail1234.ts.net"],
  ["file scheme", "file:///etc/passwd"],
  ["javascript scheme", "javascript:alert(1)"],
  ["a label that starts with a hyphen", "https://-studio.tail1234.ts.net"],
  ["a label that ends with a hyphen", "https://studio-.tail1234.ts.net"],
  ["an empty label", "https://studio-mac..ts.net"],
  ["an over-long label", `https://${"a".repeat(64)}.tail1234.ts.net`],
  ["embedded newline", "https://studio-mac.tail1234.ts.net\nhttps://evil.example"],
  ["embedded space", "https://studio-mac.tail1234.ts.net /v1"],
  ["embedded tab", "https://studio-mac.tail1234.ts.net\t/v1"],
  ["null byte", "https://studio-mac.tail1234.ts.net\u0000.evil.example"],
];

describe("validateInferenceEndpoint", () => {
  it.each(ACCEPTED)("accepts %s exactly as given", (value) => {
    expect(validateInferenceEndpoint(value)).toEqual({ ok: true, endpoint: value });
  });

  it.each(REFUSED)("refuses %s", (_label, value) => {
    const result = validateInferenceEndpoint(value);
    expect(result.ok).toBe(false);
  });

  it("covers a meaningful number of hostile inputs", () => {
    expect(REFUSED.length).toBeGreaterThanOrEqual(40);
  });

  it("trims surrounding whitespace and nothing else", () => {
    expect(validateInferenceEndpoint("  https://a.b.ts.net/v1\n")).toEqual({ ok: true, endpoint: "https://a.b.ts.net/v1" });
  });

  it("refuses empty and over-long values with a fixed reason that never echoes the input", () => {
    expect(validateInferenceEndpoint("")).toEqual({ ok: false, reason: "empty" });
    expect(validateInferenceEndpoint("   ")).toEqual({ ok: false, reason: "empty" });
    const long = `https://${"a".repeat(INFERENCE_ENDPOINT_MAX_LENGTH)}.b.ts.net`;
    expect(validateInferenceEndpoint(long)).toEqual({ ok: false, reason: "too_long" });
    const secret = "https://169.254.169.254/secret-token-abc";
    expect(JSON.stringify(validateInferenceEndpoint(secret))).not.toContain("secret-token-abc");
  });
});

describe("the allow-list has one definition", () => {
  const schemaSource = readFileSync("lib/db/schema/organizations.ts", "utf8");
  const migration = readFileSync("drizzle/0010_org_settings_hardening.sql", "utf8");

  it("the schema CHECK, the migration and the validator use the same pattern text", () => {
    // Appears once as the exported constant and once inside the CHECK.
    expect(schemaSource.split(INFERENCE_ENDPOINT_PATTERN).length - 1).toBe(2);
    expect(migration).toContain(`~ '${INFERENCE_ENDPOINT_PATTERN}'`);
  });

  it("the constraint also caps the length at the same number as the validator", () => {
    expect(migration).toContain(`<= ${INFERENCE_ENDPOINT_MAX_LENGTH}`);
  });

  it("the pattern has no backslashes (identical meaning in JavaScript and Postgres)", () => {
    expect(INFERENCE_ENDPOINT_PATTERN).not.toContain("\\");
  });
});

describe("inferenceBaseUrl (the address a generation request goes to)", () => {
  it("adds /v1 when it is missing and keeps it when present", () => {
    expect(inferenceBaseUrl("https://studio-mac.tail1234.ts.net")).toEqual({ ok: true, baseUrl: "https://studio-mac.tail1234.ts.net/v1" });
    expect(inferenceBaseUrl("https://studio-mac.tail1234.ts.net:8443")).toEqual({ ok: true, baseUrl: "https://studio-mac.tail1234.ts.net:8443/v1" });
    expect(inferenceBaseUrl("https://studio-mac.tail1234.ts.net/v1")).toEqual({ ok: true, baseUrl: "https://studio-mac.tail1234.ts.net/v1" });
  });

  it("gives no address at all for anything outside the allow-list, a missing value included (no default)", () => {
    for (const bad of [null, undefined, "", "   ", "http://localhost:11434/v1", "https://api.openai.com/v1", "https://127.0.0.1", "https://evil.example.com/v1", "https://a.ts.net.evil.com", "https://a.b.ts.net/v2", "https://user:pw@a.b.ts.net"]) {
      expect(inferenceBaseUrl(bad), String(bad)).toEqual({ ok: false });
    }
  });
});
