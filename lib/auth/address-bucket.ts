/**
 * The key a per-address rate limit counts under, the way Better Auth groups addresses for its own
 * limiter: IPv4 as is (an IPv4-mapped IPv6 address as the IPv4 it carries), IPv6 reduced to its /64
 * (one household or one rented host can hold billions of addresses; counting each separately would
 * make the limit meaningless), and no usable address at all one shared bucket, which fails closed
 * (everyone then shares the limit) instead of open.
 *
 * This is a grouping key for a limit, never the address recorded in an audit row (that is the address
 * as received; see `record()` in lib/auth/auth.ts).
 */
export const NO_TRUSTED_ADDRESS = "no-trusted-ip";

export function addressBucket(ip: string | undefined | null): string {
  if (!ip) return NO_TRUSTED_ADDRESS;
  const value = ip.trim().toLowerCase();
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value;
  if (!value.includes(":")) return NO_TRUSTED_ADDRESS;

  const halves = value.split("::");
  if (halves.length > 2) return NO_TRUSTED_ADDRESS;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return NO_TRUSTED_ADDRESS;
    groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return NO_TRUSTED_ADDRESS;
  return `${groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}::/64`;
}
