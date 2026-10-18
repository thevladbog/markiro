import { describe, expect, it } from "vitest";

import type { DeviceUpdateOffer } from "../src/host/distribution.js";
import { hostUpdateOffer, type HostOfferInput } from "../src/update/host-offer.js";
import type { ManifestView } from "../src/update/updates-api.js";

const MANIFEST: ManifestView = {
  version: "0.3.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  notes: ["Лицензия площадки"],
  minUpgradeFrom: "0.2.0",
  protocol: 4,
  minProtocol: 3,
  sizeBytes: 61234567,
};

const OFFER: DeviceUpdateOffer = {
  hostVersion: "0.3.0",
  package: { state: "ok", manifest: "a.b.c", version: "0.3.0", sizeBytes: 61234567, sha256: "ab" },
};

function input(overrides: Partial<HostOfferInput> = {}): HostOfferInput {
  return {
    appVersion: "0.2.1",
    hostVersion: "0.3.0",
    offer: OFFER,
    manifest: MANIFEST,
    appTooOld: false,
    ...overrides,
  };
}

describe("«Доступно обновление» (spec §10.11.5)", () => {
  it("holds when all four conditions do", () => {
    expect(hostUpdateOffer(input())).toEqual({
      kind: "available",
      hostVersion: "0.3.0",
      manifest: MANIFEST,
      required: false,
    });
    expect(hostUpdateOffer(input({ appTooOld: true }))).toMatchObject({ required: true });
  });

  it("1: the host must be newer than this PC; an older host is said, never a downgrade", () => {
    expect(hostUpdateOffer(input({ appVersion: "0.3.0" }))).toEqual({ kind: "none" });
    expect(hostUpdateOffer(input({ hostVersion: null }))).toEqual({ kind: "none" });
    expect(hostUpdateOffer(input({ appVersion: null }))).toEqual({ kind: "none" });
    expect(hostUpdateOffer(input({ appVersion: "0.4.0" }))).toEqual({
      kind: "host_older",
      hostVersion: "0.3.0",
      appVersion: "0.4.0",
    });
  });

  it("2: the host must give a package of its own version", () => {
    for (const state of ["missing", "mismatch", "invalid", "verifying", "quarantined"]) {
      expect(
        hostUpdateOffer(input({ offer: { hostVersion: "0.3.0", package: { state } } })),
      ).toEqual({ kind: "unavailable", hostVersion: "0.3.0", reason: state });
    }
    expect(
      hostUpdateOffer(
        input({ offer: { ...OFFER, package: { ...OFFER.package, version: "0.2.9" } } }),
      ),
    ).toEqual({ kind: "unavailable", hostVersion: "0.3.0", reason: "version_differs" });
    expect(hostUpdateOffer(input({ offer: null }))).toMatchObject({ reason: "unread" });
  });

  it("3: this PC must not be below the manifest's minUpgradeFrom", () => {
    expect(hostUpdateOffer(input({ appVersion: "0.1.9" }))).toEqual({
      kind: "needs_intermediate",
      hostVersion: "0.3.0",
      minUpgradeFrom: "0.2.0",
    });
  });

  it("4: the manifest's signature must have checked out, and name the host's version", () => {
    expect(hostUpdateOffer(input({ manifest: { refused: "manifest_signature" } }))).toEqual({
      kind: "unavailable",
      hostVersion: "0.3.0",
      reason: "manifest_signature",
    });
    expect(hostUpdateOffer(input({ manifest: null }))).toMatchObject({ reason: "unread" });
    expect(hostUpdateOffer(input({ manifest: { ...MANIFEST, version: "0.3.1" } }))).toMatchObject({
      reason: "version_differs",
    });
  });
});
