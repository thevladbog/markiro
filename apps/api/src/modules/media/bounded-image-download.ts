import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

export interface ImageDownloadPolicy {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  allowedHosts: readonly string[] | null;
}

export interface ImageDownloadDeps {
  /** Подменяется в тестах; в бою — node:https.request. */
  request?: typeof httpsRequest;
  /** Cancels the native request before the coordinator releases capacity. */
  signal?: AbortSignal;
}

export type ImageDownloadReason =
  | "not_https"
  | "forbidden_host"
  | "forbidden_address"
  | "too_large"
  | "timeout"
  | "too_many_redirects"
  | "bad_status"
  | "network";

export class ImageDownloadError extends Error {
  constructor(
    public readonly reason: ImageDownloadReason,
    detail?: string,
  ) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
  }
}

function isForbiddenIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b! >= 64 && b! <= 127) return true;
  return false;
}

function expandIpv6(address: string): number[] | null {
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const segments = part.split(":");
    const groups: number[] = [];
    for (const [i, segment] of segments.entries()) {
      if (i === segments.length - 1 && segment.includes(".")) {
        const octets = segment.split(".").map(Number);
        if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
          return null;
        }
        groups.push(((octets[0]! << 8) | octets[1]!) & 0xffff);
        groups.push(((octets[2]! << 8) | octets[3]!) & 0xffff);
        continue;
      }
      const value = Number.parseInt(segment, 16);
      if (Number.isNaN(value) || value < 0 || value > 0xffff) return null;
      groups.push(value);
    }
    return groups;
  };

  const compressionIndex = address.indexOf("::");
  if (compressionIndex === -1) {
    const groups = parseGroups(address);
    return groups !== null && groups.length === 8 ? groups : null;
  }
  const headGroups = parseGroups(address.slice(0, compressionIndex));
  const tailGroups = parseGroups(address.slice(compressionIndex + 2));
  if (headGroups === null || tailGroups === null) return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  return [...headGroups, ...new Array<number>(missing).fill(0), ...tailGroups];
}

function embeddedIpv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function allGroupsZero(groups: number[], from: number, to: number): boolean {
  return groups.slice(from, to).every((group) => group === 0);
}

/** Denies loopback, RFC1918, link-local, ULA and private embedded IPv4 ranges. */
export function isForbiddenAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isForbiddenIpv4(address);
  if (kind === 6) {
    const groups = expandIpv6(address.toLowerCase());
    if (groups === null) return true;

    if (allGroupsZero(groups, 0, 5) && groups[5] === 0xffff) {
      return isForbiddenIpv4(embeddedIpv4(groups[6]!, groups[7]!));
    }
    if (allGroupsZero(groups, 0, 6)) {
      if (groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) return true;
      return isForbiddenIpv4(embeddedIpv4(groups[6]!, groups[7]!));
    }
    if (groups[0] === 0x64 && groups[1] === 0xff9b && allGroupsZero(groups, 2, 6)) {
      return isForbiddenIpv4(embeddedIpv4(groups[6]!, groups[7]!));
    }
    if ((groups[0]! & 0xfe00) === 0xfc00) return true;
    if ((groups[0]! & 0xffc0) === 0xfe80) return true;
    return false;
  }
  return true;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Resolves at connection time so DNS rebinding cannot bypass the address check. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const forbidden = addresses.find((entry) => isForbiddenAddress(entry.address));
    if (forbidden !== undefined || addresses.length === 0) {
      callback(
        Object.assign(new Error("forbidden resolved address"), { code: "EFORBIDDEN" }),
        "",
        0,
      );
      return;
    }
    // Node's automatic family selection requests the all-addresses callback shape.
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
};

function validatePolicy(policy: ImageDownloadPolicy): void {
  if (!Number.isFinite(policy.maxBytes) || policy.maxBytes <= 0) {
    throw new ImageDownloadError("network", "invalid maxBytes policy");
  }
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new ImageDownloadError("network", "invalid timeoutMs policy");
  }
  if (
    !Number.isInteger(policy.maxRedirects) ||
    policy.maxRedirects < 0 ||
    policy.maxRedirects > 3
  ) {
    throw new ImageDownloadError("network", "invalid maxRedirects policy");
  }
  if (
    policy.allowedHosts !== null &&
    (!Array.isArray(policy.allowedHosts) ||
      policy.allowedHosts.some((host) => typeof host !== "string" || host.length === 0))
  ) {
    throw new ImageDownloadError("network", "invalid allowedHosts policy");
  }
}

function fetchHop(
  url: URL,
  request: typeof httpsRequest,
  timeoutMs: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ redirectTo: string } | { body: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let currentRes: IncomingMessage | undefined;
    let req: ReturnType<typeof httpsRequest> | undefined;
    const clearDeadline = () => {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", abort);
    };
    const settleResolve = (value: { redirectTo: string } | { body: Buffer }) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      resolve(value);
    };
    const settleReject = (error: ImageDownloadError) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      req?.destroy();
      currentRes?.destroy();
      reject(error);
    };

    const deadlineTimer = setTimeout(() => {
      settleReject(new ImageDownloadError("timeout", `deadline ${timeoutMs}ms expired`));
    }, timeoutMs);

    const abort = () => {
      settleReject(new ImageDownloadError("timeout", "request aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      req = request(url, { method: "GET", lookup: guardedLookup, timeout: timeoutMs }, (res) => {
        currentRes = res;
        // Keep an error listener through destruction, including non-success responses.
        res.on("error", () =>
          settleReject(new ImageDownloadError("network", "response stream failed")),
        );
        try {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (status >= 300 && status < 400 && typeof location === "string") {
            req?.destroy();
            res.destroy();
            settleResolve({ redirectTo: location });
            return;
          }
          if (status < 200 || status >= 300) {
            settleReject(new ImageDownloadError("bad_status", `HTTP ${status}`));
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          res.on("data", (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > maxBytes) {
              settleReject(new ImageDownloadError("too_large", `> ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => settleResolve({ body: Buffer.concat(chunks) }));
        } catch (cause) {
          settleReject(
            cause instanceof ImageDownloadError
              ? cause
              : new ImageDownloadError("network", "response handling failed"),
          );
        }
      });
    } catch {
      settleReject(new ImageDownloadError("network", "request failed"));
      return;
    }
    req.on("timeout", () => {
      settleReject(new ImageDownloadError("timeout", `${timeoutMs}ms`));
    });
    req.on("error", (cause: NodeJS.ErrnoException) => {
      settleReject(
        cause.code === "EFORBIDDEN"
          ? new ImageDownloadError("forbidden_address", "resolved address denied")
          : new ImageDownloadError("network", "request failed"),
      );
    });
    try {
      req.end();
    } catch {
      settleReject(new ImageDownloadError("network", "request failed"));
    }
  });
}

export async function downloadBoundedImage(
  rawUrl: string,
  policy: ImageDownloadPolicy,
  deps: ImageDownloadDeps = {},
): Promise<Buffer> {
  validatePolicy(policy);
  const request = deps.request ?? httpsRequest;
  const deadline = Date.now() + policy.timeoutMs;
  let current = rawUrl;
  let base: URL | undefined;

  for (let hop = 0; hop <= policy.maxRedirects; hop++) {
    let url: URL;
    try {
      url = base === undefined ? new URL(current) : new URL(current, base);
    } catch {
      throw new ImageDownloadError("network", "invalid URL");
    }
    if (url.username !== "" || url.password !== "") {
      throw new ImageDownloadError("forbidden_host", "credentials in URL");
    }
    if (policy.allowedHosts !== null && !policy.allowedHosts.includes(url.hostname.toLowerCase())) {
      throw new ImageDownloadError("forbidden_host", "host outside configured allowlist");
    }
    if (url.protocol !== "https:") throw new ImageDownloadError("not_https", url.protocol);

    const hostname = stripBrackets(url.hostname);
    if (isIP(hostname) !== 0 && isForbiddenAddress(hostname)) {
      throw new ImageDownloadError("forbidden_address", hostname);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ImageDownloadError("timeout", `budget ${policy.timeoutMs}ms exhausted`);
    }
    const outcome = await fetchHop(url, request, remainingMs, policy.maxBytes, deps.signal);
    if ("body" in outcome) return outcome.body;
    current = outcome.redirectTo;
    base = url;
  }
  throw new ImageDownloadError("too_many_redirects", `> ${policy.maxRedirects}`);
}
