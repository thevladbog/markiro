import { describe, expect, it } from "vitest";
import { nextKioskView, type KioskViewInput } from "../src/App.js";

const base: KioskViewInput = {
  paired: true,
  cacheStale: false,
  scannerSetupRequested: false,
  employeeId: null,
  submitted: false,
  configLoaded: true,
};

describe("nextKioskView", () => {
  it("waits while the local config has not been read yet", () => {
    expect(nextKioskView({ ...base, configLoaded: false })).toBe("loading");
  });

  it("demands pairing before anything else when the device has no token", () => {
    expect(nextKioskView({ ...base, paired: false })).toBe("pairing");
  });

  it("sends an unpaired device to pairing even when its cache is stale — it cannot refresh until it pairs, so blocking first would be a dead end", () => {
    expect(nextKioskView({ ...base, paired: false, cacheStale: true })).toBe("pairing");
  });

  it("lets scanner setup be reached from the pairing screen — the scanner is often needed to scan the pairing code itself", () => {
    expect(nextKioskView({ ...base, paired: false, scannerSetupRequested: true })).toBe(
      "scanner-setup",
    );
  });

  it("blocks work when the cached dataset is too old to trust", () => {
    expect(nextKioskView({ ...base, cacheStale: true })).toBe("blocked");
  });

  it("waits for a badge when idle", () => {
    expect(nextKioskView(base)).toBe("idle");
  });

  it("shows the cart once an employee is recognised", () => {
    expect(nextKioskView({ ...base, employeeId: "e1" })).toBe("cart");
  });

  it("shows the handover confirmation after submitting", () => {
    expect(nextKioskView({ ...base, employeeId: "e1", submitted: true })).toBe("done");
  });
});
