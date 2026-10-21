/**
 * The allow-list for a practice's `inference_endpoint` (audit 04 item 8, CLAUDE.md "SSRF
 * prevention"). The backend sends model traffic to this address, so a value that points anywhere
 * else (an internal address, a cloud metadata service, a look-alike host) would turn the
 * inference call into a request-forgery tool.
 *
 * One pattern, used twice: the database CHECK constraint on `organizations` (migration 0010)
 * and `validateInferenceEndpoint()` below. The constant lives in lib/db/schema/organizations.ts
 * so the schema and this validator cannot drift apart; a test compares them against the SQL.
 *
 * Allowed today (Sam, 2026-10-20: Tailscale only): `https://<machine>.<tailnet>.ts.net`, an
 * optional Funnel port (443, 8443 or 10000) and an optional `/v1` path. Everything else is
 * refused: plain http, IP addresses, localhost, user info, query strings, fragments, upper case,
 * a trailing dot, punycode names, other ports, other paths. Adding a host (for example a
 * Cloudflare Tunnel domain) is a migration, on purpose, and needs Sam to name the domain.
 *
 * The local-development stub does not use this: it reads OLLAMA_BASE_URL from the environment.
 */
import { INFERENCE_ENDPOINT_PATTERN } from "@/lib/db/schema/organizations";

export const INFERENCE_ENDPOINT_MAX_LENGTH = 253;

export type EndpointCheck = { ok: true; endpoint: string } | { ok: false; reason: "empty" | "too_long" | "not_allowed" };

const pattern = new RegExp(INFERENCE_ENDPOINT_PATTERN);

/**
 * Returns the endpoint exactly as it would be stored, or a fixed reason. The reason never
 * echoes the input. Surrounding whitespace is trimmed; nothing else is rewritten, so a value
 * that is accepted here is byte-for-byte what the database constraint sees.
 */
export function validateInferenceEndpoint(input: string): EndpointCheck {
  const value = input.trim();
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > INFERENCE_ENDPOINT_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (!pattern.test(value)) return { ok: false, reason: "not_allowed" };
  // Belt and braces: the platform's own URL parser must agree about scheme and host.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "not_allowed" };
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return { ok: false, reason: "not_allowed" };
  }
  if (!url.hostname.endsWith(".ts.net")) return { ok: false, reason: "not_allowed" };
  return { ok: true, endpoint: value };
}

/**
 * The address model requests go to, from the value stored on the organization. The stored value
 * is checked again here (the database CHECK is the first line, this is the second), then given
 * the `/v1` path Ollama's OpenAI-compatible API lives under if it does not have it. A value that
 * fails the allow-list yields no address at all: there is no default to fall back to.
 */
export function inferenceBaseUrl(stored: string | null | undefined): { ok: true; baseUrl: string } | { ok: false } {
  if (typeof stored !== "string") return { ok: false };
  const checked = validateInferenceEndpoint(stored);
  if (!checked.ok) return { ok: false };
  return { ok: true, baseUrl: checked.endpoint.endsWith("/v1") ? checked.endpoint : `${checked.endpoint}/v1` };
}
