/** A reference value, never an instruction to fetch a remote resource. */
export function isTlcSourceReferenceUrl(value: string): boolean {
  if (
    !/^https?:\/\//i.test(value) ||
    /[\s\p{Cc}\p{Cs}\\]/u.test(value) ||
    new TextEncoder().encode(value).length > 1024
  )
    return false;
  try {
    const url = new URL(value);
    // Native URL handling of empty ACE labels differs between Node versions.
    // Check the parsed hostname, including case/percent-encoded input variants.
    const emptyAceLabel = url.hostname.split(".").some((label) => label.toLowerCase() === "xn--");
    return Boolean(url.hostname) && !url.username && !url.password && !emptyAceLabel;
  } catch {
    return false;
  }
}
