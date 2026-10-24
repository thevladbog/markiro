import { describe, expect, it } from "vitest";

import { installWarnings } from "../src/office/info/update-flow.js";
import type { VerifiedReport } from "../src/office/info/update-shell.js";
import { DEVICE_ID } from "./support/fixtures.js";
import { ACTIVE, HANDHELD_ID, PARTICIPANT_B, participant, SHARED } from "./support/shifts.js";

const SHA = "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b";

const REPORT: VerifiedReport = {
  path: "C:\\Updates\\markiro-standalone-0.2.0.update.jws",
  kid: "test-upd-1",
  manifest: {
    v: 1,
    product: "markiro-standalone",
    version: "0.2.0",
    channel: "stable",
    releasedAt: "2026-11-02T10:00:00Z",
    sourceSha: "a".repeat(40),
    installer: {
      name: "markiro-standalone-0.2.0-windows-x86_64-setup.exe",
      sha256: SHA,
      sizeBytes: 29,
    },
    protocol: 3,
    minProtocol: 2,
    minUpgradeFrom: "0.1.0",
    notes: ["Тестовый выпуск 0.2.0"],
  },
  installed: "0.1.0",
  installerPath: "C:\\Updates\\markiro-standalone-0.2.0-windows-x86_64-setup.exe",
  comparison: "newer",
  refusal: null,
  confirmations: [],
  host: null,
};

function warnings(shifts: Parameters<typeof installWarnings>[0]["shifts"], thisDeviceId: string) {
  return installWarnings({ report: REPORT, role: "station", devices: [], shifts, thisDeviceId });
}

describe("the shift of this PC before an update (plan 2b)", () => {
  it("is the shift this PC works as a participant, though it did not open it", () => {
    expect(warnings([SHARED], HANDHELD_ID).openShift).toBe("OCT26-004");
  });

  it("is none once this PC left the shift, even if it opened it", () => {
    const shift = { ...SHARED, participants: [participant({ state: "left" }), PARTICIPANT_B] };
    expect(warnings([shift], DEVICE_ID).openShift).toBeNull();
    expect(warnings([shift], HANDHELD_ID).openShift).toBe("OCT26-004");
  });

  it("is the owner's for a host before protocol 7, as before", () => {
    expect(warnings([ACTIVE], DEVICE_ID).openShift).toBe("OCT26-004");
    expect(warnings([ACTIVE], HANDHELD_ID).openShift).toBeNull();
  });
});
