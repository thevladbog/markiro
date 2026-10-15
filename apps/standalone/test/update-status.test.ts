import { readFileSync } from "node:fs";

import i18n from "i18next";
import { describe, expect, it } from "vitest";

import { officeUpdateStatusSchema } from "../src/host/distribution.js";
import { packageStateKey, summarize } from "../src/office/info/update-status.js";
import { updateDistributionContributor } from "../src/office/info/update-support.js";
import { fakeOfficeSession } from "./support/office.js";

const testModuleUrl = import.meta.url;
const STATUS = officeUpdateStatusSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/office-update-status.json", testModuleUrl), "utf8"),
  ) as unknown,
);

describe("«Устройства и версии»", () => {
  it("counts the devices by state", () => {
    expect(summarize(STATUS)).toEqual({
      hostVersion: "0.3.0",
      total: 5,
      current: 1,
      behind: 1,
      incompatible: 1,
      newer: 1,
      unknown: 1,
    });
  });

  it("names a newer host's package state as unknown", () => {
    expect(packageStateKey("ok")).toBe("ok");
    expect(packageStateKey("quarantined")).toBe("unknown");
  });

  it("adds a support block of the package and the devices, without a hash", async () => {
    const session = fakeOfficeSession();
    session.api.getUpdateStatus.mockResolvedValue(STATUS);
    const block = await updateDistributionContributor({
      t: i18n.t.bind(i18n),
      facts: { generatedAt: new Date("2026-11-03T09:00:00Z") } as never,
      about: {} as never,
      read: (operation) => operation(session.api, "token"),
    });
    expect(block?.title).toBe("Раздача обновления");
    expect(block?.lines).toContainEqual(["Пакет на хосте", "проверен, 0.3.0"]);
    expect(block?.lines).toContainEqual([
      "Станция линии 2 (station)",
      "0.2.1 · протокол 3 · отстаёт",
    ]);
    expect(JSON.stringify(block)).not.toContain("7863191b");
    session.api.getUpdateStatus.mockRejectedValue(new Error("down"));
    await expect(
      updateDistributionContributor({
        t: i18n.t.bind(i18n),
        facts: {} as never,
        about: {} as never,
        read: (operation) => operation(session.api, "token"),
      }),
    ).rejects.toThrow("down");
  });
});
