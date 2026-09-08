import { toASCII } from "tr46";

/** Validate a hostname already parsed by URL; never rewrite or resolve a reference. */
export function isTraceabilityReferenceHost(hostname: string): boolean {
  if (!hostname) return false;
  // URL has already validated bracketed IPv6. IDNA applies only to domain labels.
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  // Keep IDNA semantics independent of native URL parser changes. This is the
  // non-transitional URL processing profile, without DNS registration limits.
  const checked = toASCII(hostname, {
    checkBidi: true,
    checkHyphens: false,
    checkJoiners: true,
    ignoreInvalidPunycode: false,
    transitionalProcessing: false,
    useSTD3ASCIIRules: false,
    verifyDNSLength: false,
  });
  return checked !== null && checked.length > 0;
}
