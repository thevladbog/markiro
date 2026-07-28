/**
 * Normalises a kiosk-pairing rate-limiter source key so an IPv6 caller can't
 * buy unlimited buckets by rotating addresses within one allocation. IPv4
 * addresses (and any other non-IPv6 key, e.g. the literal `"*"` global
 * bucket) pass through unchanged -- a /32 is already the finest useful
 * granularity for an IPv4 address. An IPv6 address collapses to its /64
 * prefix, because a /64 is the smallest block a residential or cloud IPv6
 * allocation is normally handed out as a whole: without this, one attacker
 * holding a single /64 (2^64 addresses) would get 2^64 independent buckets.
 */
export function normalizePairSource(source: string): string {
  if (!source.includes(":")) return source; // IPv4, or an opaque key such as the global "*" bucket

  const withoutZone = source.split("%")[0] ?? source; // strip a zone id, e.g. fe80::1%eth0
  const withoutPrefix = withoutZone.split("/")[0] ?? withoutZone; // tolerate an already-CIDR'd input

  // An IPv4-mapped/compatible IPv6 address (e.g. ::ffff:192.0.2.1) embeds a
  // plain IPv4 address after its last colon -- key on that directly so it
  // lines up with the same caller seen as plain IPv4, instead of collapsing
  // every such address onto one bucket regardless of which IPv4 address it
  // actually carries.
  if (withoutPrefix.includes(".")) return withoutPrefix.slice(withoutPrefix.lastIndexOf(":") + 1);

  const hextets = expandIPv6(withoutPrefix);
  return `${hextets.slice(0, 4).join(":")}::/64`;
}

/**
 * Expands `::` shorthand into 8 explicit hextets, each canonicalised
 * (leading zeros stripped, e.g. `"0db8"` -> `"db8"`) so two textually
 * different-but-equal addresses in the same /64 -- e.g. `2001:0db8::1` and
 * `2001:db8::1` -- collapse to the same rate-limiter key. Unreachable via
 * this module's own callers today (Node's `req.ip` always emits canonical
 * addresses), but cheap to harden.
 */
function expandIPv6(address: string): string[] {
  const hextets = address.includes("::") ? expandShorthand(address) : address.split(":");
  return hextets.map((hextet) => parseInt(hextet, 16).toString(16));
}

function expandShorthand(address: string): string[] {
  const [head, tail] = address.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = Math.max(8 - headParts.length - tailParts.length, 0);
  const zeroes: string[] = Array.from({ length: missing }, () => "0");
  return [...headParts, ...zeroes, ...tailParts];
}
