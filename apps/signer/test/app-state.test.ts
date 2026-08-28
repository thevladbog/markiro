import { describe, expect, it } from "vitest";
import { nextSignerView } from "../src/App.js";

describe("nextSignerView", () => {
  it("waits while the status is unknown", () => {
    expect(nextSignerView(null)).toBe("loading");
  });

  it("asks for a pairing code until the agent is paired", () => {
    expect(
      nextSignerView({
        phase: "unpaired",
        tenantName: null,
        certThumbprint: null,
        lastTokenExpiresAt: null,
        lastError: null,
        journal: [],
      }),
    ).toBe("pairing");
  });

  it("shows the status panel once paired, even while degraded", () => {
    for (const phase of ["idle", "working", "degraded"] as const) {
      expect(
        nextSignerView({
          phase,
          tenantName: "ООО Ромашка",
          certThumbprint: "AB12",
          lastTokenExpiresAt: null,
          lastError: null,
          journal: [],
        }),
      ).toBe("ready");
    }
  });
});
