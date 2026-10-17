import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DeviceUpdateOffer } from "../src/host/distribution.js";
import type { HostStatus } from "../src/host/protocol.js";
import { useHostUpdateCheck } from "../src/update/use-host-offer.js";
import type { ManifestView } from "../src/update/updates-api.js";

const MANIFEST: ManifestView = {
  version: "0.3.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  notes: ["x"],
  minUpgradeFrom: "0.2.0",
  protocol: 4,
  minProtocol: 3,
  sizeBytes: 200,
};
const OFFER: DeviceUpdateOffer = {
  hostVersion: "0.3.0",
  package: { state: "ok", manifest: "a.b.c", version: "0.3.0", sizeBytes: 200, sha256: "ab" },
};
const link = (o: Partial<HostStatus> = {}): HostStatus => ({
  state: "online",
  lastContactAt: 1,
  lastError: null,
  seq: 1,
  hostVersion: "0.3.0",
  ...o,
});

function setup(status: HostStatus, getDeviceUpdate: () => Promise<DeviceUpdateOffer>) {
  const updates = {
    appVersion: vi.fn(async () => "0.2.1"),
    checkManifest: vi.fn(async () => MANIFEST),
  };
  const host = { getDeviceUpdate };
  return renderHook(() => useHostUpdateCheck({ link: status, paired: true, host, updates }));
}

describe("the manual «Проверить обновление»", () => {
  it("reads the host's offer again and says when it is done", async () => {
    const get = vi.fn(async () => OFFER);
    const { result } = setup(link(), get);
    await waitFor(() => expect(result.current.offer.kind).toBe("available"));
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.checked).toBe(false);
    act(() => result.current.check());
    expect(result.current.checking).toBe(true);
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.checked).toBe(true);
    expect(result.current.appVersion).toBe("0.2.1");
  });

  it("finishes at once when the host is not newer: nothing to read", async () => {
    const get = vi.fn(async () => OFFER);
    const { result } = setup(link({ hostVersion: "0.2.1" }), get);
    await waitFor(() => expect(result.current.appVersion).toBe("0.2.1"));
    act(() => result.current.check());
    await waitFor(() => expect(result.current.checked).toBe(true));
    expect(result.current.checking).toBe(false);
    expect(result.current.offer.kind).toBe("none");
    expect(get).not.toHaveBeenCalled();
  });

  it("finishes when the host cannot be reached, with the last good offer kept", async () => {
    const get = vi.fn(async () => OFFER);
    const { result } = setup(link({ state: "offline", lastError: "unreachable" }), get);
    await waitFor(() => expect(result.current.appVersion).toBe("0.2.1"));
    act(() => result.current.check());
    await waitFor(() => expect(result.current.checked).toBe(true));
    expect(result.current.reachable).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});
