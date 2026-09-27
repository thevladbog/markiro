import { describe, expect, it, vi } from "vitest";

import { findHost, parseHostAddress } from "../src/app/host-search.js";
import { HostProbeError, type HelloObservation, type HostProbe } from "../src/host/probe.js";
import { observation } from "./support/fixtures.js";

const FINGERPRINT = "ab".repeat(32);
const VIRTUAL = "https://172.20.0.1:45710";
const LAN = "https://192.168.1.10:45710";

function seen(fingerprint: string): HelloObservation {
  return { ...observation(true), fingerprint };
}

describe("parseHostAddress", () => {
  it.each([
    ["192.168.1.10", "https://192.168.1.10:45710"],
    [" 192.168.1.10:8443 ", "https://192.168.1.10:8443"],
    ["host-pc", "https://host-pc:45710"],
    ["host-pc.local:45710", "https://host-pc.local:45710"],
    ["192,168,1,10", "https://192.168.1.10:45710"],
  ])("reads %j", (input, url) => {
    expect(parseHostAddress(input)).toBe(url);
  });

  it.each([
    "",
    "https://192.168.1.10",
    "192.168.1.10:0",
    "192.168.1.10:65536",
    "192.168.1.10:port",
    "192.168.1.10 45710",
    "-host",
    "host_pc",
  ])("refuses %j", (input) => {
    expect(parseHostAddress(input)).toBeNull();
  });
});

describe("findHost", () => {
  it("probes every address at once and takes the one with the code's certificate", async () => {
    const hello = vi.fn<HostProbe["hello"]>((address) =>
      // A virtual adapter that never answers must not hold up the real one.
      address === VIRTUAL
        ? new Promise<HelloObservation>(() => undefined)
        : Promise.resolve(seen(FINGERPRINT)),
    );
    await expect(findHost({ hello }, [VIRTUAL, LAN], FINGERPRINT)).resolves.toEqual({
      kind: "found",
      address: LAN,
    });
    expect(hello.mock.calls).toEqual([[VIRTUAL], [LAN]]);
  });

  it("does not trust a host with another certificate", async () => {
    const hello = vi.fn<HostProbe["hello"]>(async () => seen("cd".repeat(32)));
    await expect(findHost({ hello }, [VIRTUAL, LAN], FINGERPRINT)).resolves.toEqual({
      kind: "other_host",
    });
  });

  it("prefers a version to update over a foreign or a dead host", async () => {
    const hello = vi.fn<HostProbe["hello"]>(async (address) => {
      if (address === VIRTUAL) throw new HostProbeError("unreachable", "down");
      throw new HostProbeError("app_too_old", "old");
    });
    await expect(findHost({ hello }, [VIRTUAL, LAN], FINGERPRINT)).resolves.toEqual({
      kind: "incompatible",
      reason: "app_too_old",
    });
  });

  it("finds nothing when no address answers, or there is none", async () => {
    const hello = vi.fn<HostProbe["hello"]>(async () => {
      throw new HostProbeError("unreachable", "down");
    });
    await expect(findHost({ hello }, [VIRTUAL, LAN], FINGERPRINT)).resolves.toEqual({
      kind: "unreachable",
    });
    await expect(findHost({ hello }, [], FINGERPRINT)).resolves.toEqual({ kind: "unreachable" });
  });
});
