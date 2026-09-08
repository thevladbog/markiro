import { isTraceabilityReferenceHost } from "../reference-host.js";

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
    return isTraceabilityReferenceHost(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
