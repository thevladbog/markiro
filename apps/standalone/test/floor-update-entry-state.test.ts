import { describe, expect, it } from "vitest";

import type { HostUpdateOffer } from "../src/update/host-offer.js";
import { updateEntryState, type UpdateEntryInput } from "../src/update/floor-update-entry.js";

const MANIFEST = {
  version: "0.3.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  notes: [],
  minUpgradeFrom: "0.2.0",
  protocol: 4,
  minProtocol: 4,
  sizeBytes: 200,
};
const AVAILABLE: HostUpdateOffer = {
  kind: "available",
  hostVersion: "0.3.0",
  required: false,
  manifest: MANIFEST,
};

function input(overrides: Partial<UpdateEntryInput> = {}): UpdateEntryInput {
  return {
    offer: { kind: "none" },
    reachable: true,
    checking: false,
    checked: false,
    inShift: false,
    ...overrides,
  };
}

describe("what the station's update entry shows", () => {
  it("asks nothing of a station that has not checked and has no offer", () => {
    expect(updateEntryState(input()).kind).toBe("idle");
  });

  it("says a check is running before anything else", () => {
    expect(updateEntryState(input({ checking: true, reachable: false })).kind).toBe("checking");
  });

  it("says plainly that the update comes from the host PC when the host cannot be reached", () => {
    expect(updateEntryState(input({ reachable: false, checked: true })).kind).toBe("unreachable");
    expect(updateEntryState(input({ reachable: false, offer: AVAILABLE })).kind).toBe(
      "unreachable",
    );
  });

  it("says the last version is installed only after a check", () => {
    expect(updateEntryState(input({ checked: true })).kind).toBe("latest");
  });

  it("offers an available version to install, and holds the install back during a shift", () => {
    expect(updateEntryState(input({ offer: AVAILABLE }))).toEqual({
      kind: "available",
      version: "0.3.0",
      notes: [],
      required: false,
      canInstall: true,
    });
    const mid = updateEntryState(input({ offer: AVAILABLE, inShift: true }));
    expect(mid).toMatchObject({ kind: "available", canInstall: false });
  });

  it("maps the host's other answers to words", () => {
    const state = (offer: HostUpdateOffer) => updateEntryState(input({ offer, checked: true }));
    expect(state({ kind: "host_older", hostVersion: "0.1.0", appVersion: "0.2.0" }).kind).toBe(
      "host_older",
    );
    expect(
      state({ kind: "needs_intermediate", hostVersion: "0.3.0", minUpgradeFrom: "0.2.5" }).kind,
    ).toBe("intermediate");
    expect(state({ kind: "unavailable", hostVersion: "0.3.0", reason: "verifying" }).kind).toBe(
      "verifying",
    );
    expect(state({ kind: "unavailable", hostVersion: "0.3.0", reason: "unread" }).kind).toBe(
      "unreadable",
    );
    expect(state({ kind: "unavailable", hostVersion: "0.3.0", reason: "missing" }).kind).toBe(
      "no_package",
    );
  });
});
