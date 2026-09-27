import { fromRussianLayout, hasCyrillic, isIpv4 } from "../host/pairing-code.js";
import { HostProbeError, type HostProbe } from "../host/probe.js";
import { DEFAULT_HOST_PORT } from "../host/protocol.js";

/** The URL the shell calls for a host at `host` (an address or a name) and `port`. */
export function hostUrl(host: string, port: number): string {
  return `https://${host}:${port}`;
}

/** A host name: letters, digits, dots and inner hyphens. */
const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
/** Nothing but digits and dots: must be a strict IPv4 address, not a name. */
const NUMERIC_HOST = /^[0-9.]+$/;

/**
 * A host address a person typed — `host` or `host:port`, port 45710 when
 * left out — as the URL the shell calls; `null` when it is neither.
 *
 * Read by key position under the Russian layout when the text holds
 * Cyrillic letters: safe for an address, unlike the code, since nothing
 * counts against a wrong one and the fingerprint is confirmed before the
 * code leaves. A comma reads as a dot either way, since the keypad's decimal
 * key types one under the Russian layout.
 *
 * A host of only digits and dots must be a strict IPv4 address (`isIpv4`),
 * not the looser host-name pattern: the WHATWG URL rules the host's HTTP
 * client uses read a partial or zero-padded one (`192.168.1`,
 * `192.168.1.010`) as a different address than its text suggests.
 */
export function parseHostAddress(input: string): string | null {
  const keyed = hasCyrillic(input) ? fromRussianLayout(input) : input;
  const match = /^([^:\s]+)(?::(\d{1,5}))?$/.exec(keyed.trim().replace(/,/g, "."));
  if (match === null) return null;
  const [, host = "", port] = match;
  const number = port === undefined ? DEFAULT_HOST_PORT : Number(port);
  const validHost = NUMERIC_HOST.test(host) ? isIpv4(host) : HOST_NAME.test(host);
  if (!validHost || number < 1 || number > 65535) return null;
  return hostUrl(host, number);
}

/** Where the host of a pairing payload answered, or the most telling reason it did not. */
export type HostSearch =
  | { kind: "found"; address: string }
  /** A Markiro host answered, but with another certificate than the payload's. */
  | { kind: "other_host" }
  | { kind: "incompatible"; reason: "host_too_old" | "app_too_old" }
  | { kind: "unreachable" };

type Failure = Exclude<HostSearch, { kind: "found" }>;

/** Which failure explains the search best: a version to update, then a foreign host. */
const TELLING: readonly Failure["kind"][] = ["incompatible", "other_host", "unreachable"];

/**
 * Probes every candidate at once and settles on the first whose certificate
 * has `fingerprint`. Probing one by one would cost a connect timeout for
 * every dead address first, and virtual adapters sort before the real one.
 */
export function findHost(
  probe: HostProbe,
  candidates: readonly string[],
  fingerprint: string,
): Promise<HostSearch> {
  return new Promise((resolve) => {
    const failures: Failure[] = [];
    const fail = (failure: Failure) => {
      failures.push(failure);
      if (failures.length < candidates.length) return;
      const telling = TELLING.map((kind) => failures.find((each) => each.kind === kind));
      resolve(telling.find((each) => each !== undefined) ?? { kind: "unreachable" });
    };
    if (candidates.length === 0) resolve({ kind: "unreachable" });
    for (const address of candidates) {
      probe.hello(address).then(
        (observation) => {
          if (observation.fingerprint === fingerprint) resolve({ kind: "found", address });
          else fail({ kind: "other_host" });
        },
        (error: unknown) => {
          const code = error instanceof HostProbeError ? error.code : "unreachable";
          fail(
            code === "host_too_old" || code === "app_too_old"
              ? { kind: "incompatible", reason: code }
              : { kind: "unreachable" },
          );
        },
      );
    }
  });
}
