import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useStationLicense, type StationLicenseOptions } from "../src/app/use-station-license.js";
import { floorLicenseLine, licenseRefusalOf, opensBlocked } from "../src/floor/license.js";
import type { DeviceInfo, DeviceLicense } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";
import { lastMomentBefore, licenseDayMonth, licenseMinute } from "../src/lib/license-dates.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { DEVICE_INFO, deviceLicense } from "./support/license.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const GRACE_END = "2027-11-14T21:00:00Z";
const EMERGENCY_END = "2027-11-23T06:00:00Z";
/** This PC's clock while the emergency extension runs, and once it has ended. */
const DURING = new Date("2027-11-21T10:00:00Z");
const AFTER = new Date("2027-11-23T06:00:00Z");

function said(line: ReturnType<typeof floorLicenseLine>): string | null {
  return line === null ? null : i18n.t(line.key, line.values ?? {});
}

describe("the license on the floor (spec §9.6)", () => {
  it("is silent in the trial, while the license runs, in its last weeks, on another host and for a newer state", () => {
    for (const state of ["trial", "active", "expiring", "wrong_host", "some_future_state"]) {
      expect(floorLicenseLine(deviceLicense(state, GRACE_END), DURING)).toBeNull();
      expect(floorLicenseLine(deviceLicense(state, GRACE_END, EMERGENCY_END), DURING)).toBeNull();
      expect(opensBlocked(deviceLicense(state))).toBeNull();
    }
    expect(floorLicenseLine(null, DURING)).toBeNull();
    expect(opensBlocked(null)).toBeNull();
  });

  it("tells everyone in the grace till when new shifts open, in this PC's zone", () => {
    const line = floorLicenseLine(deviceLicense("grace", GRACE_END), DURING);
    expect(line?.tone).toBe("warn");
    expect(said(line)).toBe(
      `Лицензия площадки истекла. Новые смены откроются до ${licenseDayMonth(lastMomentBefore(GRACE_END), null)}. Сообщите администратору.`,
    );
    expect(opensBlocked(deviceLicense("grace", GRACE_END))).toBeNull();
  });

  it("says the grace without a date when the host sends no end", () => {
    const line = floorLicenseLine(deviceLicense("grace"), DURING);
    expect(line?.tone).toBe("warn");
    expect(said(line)).toBe(
      "Лицензия площадки истекла. Скоро новые смены перестанут открываться. Сообщите администратору.",
    );
  });

  it.each([
    [
      "restricted",
      "license_restricted",
      "Новые смены не открываются: лицензия площадки истекла. Сообщите администратору.",
    ],
    [
      "trial_expired",
      "license_trial_expired",
      "Новые смены не открываются: пробный период закончился. Сообщите администратору.",
    ],
    [
      "inn_mismatch",
      "license_inn_mismatch",
      "Новые смены не открываются: ИНН организации не совпадает с лицензией. Сообщите администратору.",
    ],
  ] as const)("says %s and opens no new shift", (state, refusal, text) => {
    const line = floorLicenseLine(deviceLicense(state), DURING);
    expect(line?.tone).toBe("error");
    expect(said(line)).toBe(text);
    expect(opensBlocked(deviceLicense(state))).toBe(refusal);
    expect(licenseRefusalOf({ constraint: "license_restricted", state })).toBe(refusal);
  });

  it.each([
    ["restricted", "Лицензия площадки истекла: новые смены открываются по аварийному продлению до"],
    [
      "trial_expired",
      "Пробный период закончился: новые смены открываются по аварийному продлению до",
    ],
    [
      "inn_mismatch",
      "ИНН организации не совпадает с лицензией: новые смены открываются по аварийному продлению до",
    ],
  ] as const)(
    "opens new shifts while the emergency extension runs in %s, and says till when",
    (state, start) => {
      const line = floorLicenseLine(deviceLicense(state, null, EMERGENCY_END), DURING);
      expect(line?.tone).toBe("warn");
      expect(said(line)).toBe(
        `${start} ${licenseMinute(EMERGENCY_END, null)}. Сообщите администратору.`,
      );
      expect(opensBlocked(deviceLicense(state, null, EMERGENCY_END))).toBeNull();
    },
  );

  it("never claims the extension once its end has passed by this PC's clock, though the host still sends it", () => {
    const ended = deviceLicense("restricted", null, EMERGENCY_END);
    const line = floorLicenseLine(ended, AFTER);
    expect(line?.tone).toBe("error");
    expect(said(line)).toBe(
      "Новые смены не открываются: лицензия площадки истекла. Сообщите администратору.",
    );
    expect(said(floorLicenseLine(ended, new Date(AFTER.getTime() - 1)))).toContain(
      "по аварийному продлению",
    );
    expect(said(floorLicenseLine(deviceLicense("trial_expired", null, EMERGENCY_END), AFTER))).toBe(
      "Новые смены не открываются: пробный период закончился. Сообщите администратору.",
    );
    // A time the station cannot read says no extension either.
    expect(floorLicenseLine(deviceLicense("restricted", null, "not a time"), DURING)?.tone).toBe(
      "error",
    );
  });

  it("reads a host's refusal without a state it knows as the license's restriction", () => {
    expect(licenseRefusalOf({ constraint: "license_restricted" })).toBe("license_restricted");
    expect(licenseRefusalOf({ constraint: "license_restricted", state: "from_a_newer_host" })).toBe(
      "license_restricted",
    );
  });
});

function recordWith(license?: DeviceLicense): DeviceInfo {
  return license === undefined ? DEVICE_INFO : { ...DEVICE_INFO, license };
}

function hookWith(initial: StationLicenseOptions) {
  return renderHook((props: StationLicenseOptions) => useStationLicense(props), {
    initialProps: initial,
  });
}

describe("useStationLicense", () => {
  it("reads once online and after every revision, and keeps what the host said", async () => {
    const read = vi.fn(async () => recordWith(deviceLicense("restricted")));
    const hook = hookWith({ pairing: PAIRING, read, revision: 1, online: true });
    await waitFor(() => expect(hook.result.current?.state).toBe("restricted"));
    read.mockResolvedValueOnce(recordWith(deviceLicense("active")));
    hook.rerender({ pairing: PAIRING, read, revision: 2, online: true });
    await waitFor(() => expect(hook.result.current?.state).toBe("active"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known state when a read fails and while the link is down", async () => {
    const read = vi.fn(async () => recordWith(deviceLicense("grace", GRACE_END)));
    const hook = hookWith({ pairing: PAIRING, read, revision: 1, online: true });
    await waitFor(() => expect(hook.result.current?.state).toBe("grace"));
    read.mockRejectedValueOnce(new Error("down"));
    hook.rerender({ pairing: PAIRING, read, revision: 2, online: true });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(hook.result.current?.state).toBe("grace");
    hook.rerender({ pairing: PAIRING, read, revision: 3, online: false });
    expect(read).toHaveBeenCalledTimes(2);
    expect(hook.result.current?.state).toBe("grace");
    hook.rerender({ pairing: PAIRING, read, revision: 3, online: true });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  });

  it("is silent for a host that sends no license, asks nothing without a pairing, and forgets another pairing's", async () => {
    const read = vi.fn(async () => recordWith());
    const hook = hookWith({ pairing: null, read, revision: 1, online: true });
    expect(read).not.toHaveBeenCalled();
    expect(hook.result.current).toBeNull();
    read.mockResolvedValue(recordWith(deviceLicense("restricted")));
    hook.rerender({ pairing: PAIRING, read, revision: 1, online: true });
    await waitFor(() => expect(hook.result.current?.state).toBe("restricted"));
    read.mockImplementation(() => new Promise<DeviceInfo>(() => undefined));
    hook.rerender({
      pairing: { hostId: HOST_ID, deviceId: "1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6" },
      read,
      revision: 1,
      online: true,
    });
    expect(hook.result.current).toBeNull();
  });

  it("drops a late answer of a read the next one replaced", async () => {
    let answerFirst: (record: DeviceInfo) => void = () => undefined;
    const read = vi
      .fn<() => Promise<DeviceInfo>>()
      .mockImplementationOnce(
        () =>
          new Promise<DeviceInfo>((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(recordWith(deviceLicense("active")));
    const hook = hookWith({ pairing: PAIRING, read, revision: 1, online: true });
    hook.rerender({ pairing: PAIRING, read, revision: 2, online: true });
    await waitFor(() => expect(hook.result.current?.state).toBe("active"));
    answerFirst(recordWith(deviceLicense("restricted")));
    await Promise.resolve();
    expect(hook.result.current?.state).toBe("active");
  });
});
