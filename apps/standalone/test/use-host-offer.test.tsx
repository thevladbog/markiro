import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DeviceUpdateOffer } from "../src/host/distribution.js";
import type { HostStatus } from "../src/host/protocol.js";
import { useHostUpdateOffer } from "../src/update/use-host-offer.js";
import type { ManifestView } from "../src/update/updates-api.js";

const MANIFEST: ManifestView = {
  version: "0.3.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  notes: [],
  minUpgradeFrom: "0.2.0",
  protocol: 4,
  minProtocol: 3,
  sizeBytes: 200,
};
const OFFER: DeviceUpdateOffer = {
  hostVersion: "0.3.0",
  package: { state: "ok", manifest: "a.b.c", version: "0.3.0", sizeBytes: 200, sha256: "ab" },
};

function link(overrides: Partial<HostStatus> = {}): HostStatus {
  return {
    state: "online",
    lastContactAt: 1,
    lastError: null,
    seq: 1,
    hostVersion: "0.3.0",
    ...overrides,
  };
}

function setup(host: { getDeviceUpdate: () => Promise<DeviceUpdateOffer> }) {
  const updates = {
    appVersion: vi.fn(async () => "0.2.1"),
    checkManifest: vi.fn(async () => MANIFEST),
  };
  const view = renderHook(
    ({ status }: { status: HostStatus }) =>
      useHostUpdateOffer({ link: status, paired: true, host, updates }),
    { initialProps: { status: link() } },
  );
  return { ...view, updates };
}

describe("the offer across the link's flaps", () => {
  it("keeps the offer while the link is away and reads once per return online", async () => {
    const host = { getDeviceUpdate: vi.fn(async () => OFFER) };
    const { result, rerender } = setup(host);
    await waitFor(() => expect(result.current.kind).toBe("available"));
    expect(host.getDeviceUpdate).toHaveBeenCalledTimes(1);

    rerender({ status: link({ state: "offline", lastError: "unreachable", seq: 2 }) });
    expect(result.current.kind).toBe("available");
    expect(host.getDeviceUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ status: link({ seq: 3 }) });
    });
    await waitFor(() => expect(host.getDeviceUpdate).toHaveBeenCalledTimes(2));
    expect(result.current.kind).toBe("available");
  });

  it("never replaces a good read with a failed one", async () => {
    const host = { getDeviceUpdate: vi.fn<() => Promise<DeviceUpdateOffer>>(async () => OFFER) };
    const { result, rerender } = setup(host);
    await waitFor(() => expect(result.current.kind).toBe("available"));
    host.getDeviceUpdate.mockRejectedValueOnce(new Error("down"));
    rerender({ status: link({ state: "offline", lastError: "unreachable", seq: 2 }) });
    await act(async () => {
      rerender({ status: link({ seq: 3 }) });
    });
    await waitFor(() => expect(host.getDeviceUpdate).toHaveBeenCalledTimes(2));
    expect(result.current.kind).toBe("available");
  });

  it("reads again when the host's version changes", async () => {
    const host = { getDeviceUpdate: vi.fn(async () => OFFER) };
    const { result, rerender } = setup(host);
    await waitFor(() => expect(result.current.kind).toBe("available"));
    host.getDeviceUpdate.mockResolvedValue({
      hostVersion: "0.4.0",
      package: { state: "missing" },
    } as DeviceUpdateOffer);
    rerender({ status: link({ hostVersion: "0.4.0", seq: 2 }) });
    await waitFor(() => expect(result.current.kind).toBe("unavailable"));
  });
});
