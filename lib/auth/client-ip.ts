import { isIP } from "node:net";
import { getTrustedProxyHops } from "@/lib/env";
import { FORWARDED_FOR_HEADER, RESOLVED_CLIENT_IP_HEADER } from "./config";

/**
 * The one place a client address is worked out from request headers.
 *
 * `x-forwarded-for` is a list: every proxy appends the address it received the request from, and keeps
 * whatever the caller sent. So the FIRST entry is the caller's own claim and can be anything; only the
 * entries our own proxies appended, counted from the RIGHT, can be believed. `hops` is how many proxies
 * of ours append to the list (an AWS Application Load Balancer is 1; a CDN in front of it makes 2). The
 * client address is the entry `hops` places from the end. Everything to its left is ignored.
 *
 * Fails closed: with `hops` 0 (the default; also local development, which has no proxy) the header is not
 * read at all; a header with fewer entries than `hops`, an empty or unparsable entry, or a header over
 * 2 KB gives `undefined`, which rate limits count in one shared bucket and audit rows record as no address.
 * The address returned is the one received (port and brackets removed), never a masked form.
 */

const MAX_HEADER_LENGTH = 2048;
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const BRACKETED_IPV6 = /^\[([^\]]+)\](?::\d{1,5})?$/;

/** One list entry as an address: an IPv4 or IPv6 address, optionally `ip:port` or `[ipv6]:port`; anything else undefined. */
export function parseForwardedEntry(entry: string): string | undefined {
  const value = entry.trim();
  if (!value) return undefined;
  const candidate = IPV4_WITH_PORT.exec(value)?.[1] ?? BRACKETED_IPV6.exec(value)?.[1] ?? value;
  // A zone id ("fe80::1%eth0") is a local-link label, not an address a client can be told apart by.
  if (candidate.includes("%")) return undefined;
  return isIP(candidate) === 0 ? undefined : candidate;
}

export function resolveClientIp(headers: Headers | undefined | null, hops: number): string | undefined {
  if (!Number.isInteger(hops) || hops < 1) return undefined;
  const raw = headers?.get(FORWARDED_FOR_HEADER);
  if (!raw || raw.length > MAX_HEADER_LENGTH) return undefined;
  // Empty entries are kept so a stray comma cannot shift which entry counts as ours.
  const entries = raw.split(",");
  if (entries.length < hops) return undefined;
  return parseForwardedEntry(entries[entries.length - hops]);
}

/** The client address for rate limits and audit rows, with the deployment's trusted hop count (TRUSTED_PROXY_HOPS). */
export function clientIp(headers: Headers | undefined | null): string | undefined {
  return resolveClientIp(headers, getTrustedProxyHops());
}

/**
 * The request as Better Auth should see it: the private header always set from `clientIp` (or absent), so
 * Better Auth's own limiter and the session row agree with our limits and audit rows. Any copy of the
 * private header the caller sent is removed first. The body, if any, moves to the returned request.
 */
export function withResolvedClientIp(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(RESOLVED_CLIENT_IP_HEADER);
  const ip = clientIp(request.headers);
  if (ip) headers.set(RESOLVED_CLIENT_IP_HEADER, ip);
  return new Request(request, { headers });
}
