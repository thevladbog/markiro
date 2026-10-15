import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { HostUpdateOffer } from "../src/update/host-offer.js";
import { useKeptOffer } from "../src/update/kept-offer.js";

const AVAILABLE = {
  kind: "available",
  hostVersion: "0.3.0",
  required: false,
  manifest: {
    version: "0.3.0",
    channel: "stable",
    releasedAt: "2026-11-02T10:00:00Z",
    notes: [],
    minUpgradeFrom: "0.2.0",
    protocol: 4,
    minProtocol: 3,
    sizeBytes: 200,
  },
} satisfies HostUpdateOffer;
const GONE = {
  kind: "unavailable",
  hostVersion: "0.3.0",
  reason: "unread",
} satisfies HostUpdateOffer;

describe("the offer kept for an open dialog", () => {
  it("holds the last available offer while the dialog is open, and lets go once it is shut", () => {
    const { result, rerender } = renderHook(
      ({ offer, open }: { offer: HostUpdateOffer; open: boolean }) => useKeptOffer(offer, open),
      { initialProps: { offer: AVAILABLE as HostUpdateOffer, open: true } },
    );
    expect(result.current).toBe(AVAILABLE);
    rerender({ offer: GONE, open: true });
    expect(result.current).toBe(AVAILABLE);
    rerender({ offer: GONE, open: false });
    expect(result.current).toBeNull();
    rerender({ offer: GONE, open: true });
    expect(result.current).toBeNull();
  });

  it("stays stable across equal offers re-created on every render", () => {
    const { result, rerender } = renderHook(
      ({ offer }: { offer: HostUpdateOffer }) => useKeptOffer(offer, false),
      { initialProps: { offer: AVAILABLE as HostUpdateOffer } },
    );
    rerender({ offer: { ...AVAILABLE } });
    expect(result.current).toMatchObject({ kind: "available" });
  });
});
