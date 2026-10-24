import { describe, expect, it } from "vitest";

import ru from "../src/i18n/ru.json";

/** The text at a dotted path of `ru.json`; a missing path or a non-text throws, naming it. */
function text(path: string): string {
  let node: unknown = ru;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) {
      throw new Error(`no key ${path}`);
    }
    node = Reflect.get(node, part);
  }
  if (typeof node !== "string") throw new Error(`${path} is not a text`);
  return node;
}

const KEYS = [
  "rules.maxStations",
  "office.lines.table.maxStations",
  "office.lines.fields.maxStations",
  "office.lines.fields.maxStationsHint",
  "office.shifts.closeAll",
  "office.shifts.closeAllNamed",
  "office.shifts.closeAllTitle",
  "office.shifts.closeAllSubmit",
  "office.shifts.closeAllIntro",
  "office.shifts.notClosed",
  "office.shifts.notClosedItem",
  "office.shifts.notClosedItemRevoked",
  "office.shifts.notClosedState.active",
  "office.shifts.notClosedState.left",
  "office.shifts.stationsLine",
  "office.shifts.reasonMissing",
  "office.shifts.supplyReason",
  "office.shifts.supplyReasonNamed",
  "office.shifts.reasonTitle",
  "office.shifts.reasonIntro",
  "office.shifts.reasonSubmit",
  "office.shifts.reasonSaved",
  "office.shifts.fields.reasonCode",
  "office.shifts.fields.reasonCodePlaceholder",
  "office.shifts.errors.reasonRequired",
  "office.shifts.errors.reasonAlreadySet",
  "office.shifts.totals.byDevice",
  "office.shifts.totals.byDeviceValue",
  "office.shifts.totals.byDeviceUnits",
  "office.shiftCard.tabs.stations",
  "office.shiftCard.participants.title",
  "office.shiftCard.participants.summary",
  "office.shiftCard.participants.table",
  "office.shiftCard.participants.pager",
  "office.shiftCard.participants.device",
  "office.shiftCard.participants.joined",
  "office.shiftCard.participants.state",
  "office.shiftCard.participants.accepted",
  "office.shiftCard.participants.boxes",
  "office.shiftCard.participants.pallets",
  "office.shiftCard.participants.closedAt",
  "office.shiftCard.participants.closedQty",
  "office.shiftCard.participants.lastSeen",
  "office.shiftCard.participants.states.active",
  "office.shiftCard.participants.states.silent",
  "office.shiftCard.participants.states.left",
  "office.shiftCard.participants.states.closedDevice",
  "office.shiftCard.participants.states.closedOffice",
  "office.devices.presence.active",
  "office.devices.presence.left",
  "office.devices.presence.closed",
  "office.overview.lines.stations",
  "office.overview.attention.participant.title",
  "office.overview.attention.participant.detail",
  "office.overview.attention.participant.action",
  "office.overview.attention.closeReason.title",
  "office.overview.attention.closeReason.detail",
  "office.overview.attention.closeReason.action",
  "office.overview.attention.shiftWaits.title",
  "office.overview.attention.shiftWaits.detail",
  "office.overview.attention.shiftWaits.action",
  "office.devices.revokeOpenShifts",
  "office.devices.shiftOnStationShared",
] as const;

const PLURALS = [
  "office.lines.fields.maxStationsInUse",
  "office.lines.errors.stationsInUse",
] as const;

describe("the texts of the multi-station office (plan 2b)", () => {
  it.each(KEYS)("has %s", (key) => {
    expect(text(key).trim()).not.toBe("");
  });

  it.each(PLURALS)("has the four plural forms of %s, each with the count", (base) => {
    for (const form of ["one", "few", "many", "other"]) {
      expect(text(`${base}_${form}`)).toContain("{{count}}");
    }
  });

  it("pins the owner's words", () => {
    expect(text("office.lines.fields.maxStations")).toBe("Максимум станций в смене");
    expect(text("office.shifts.closeAllSubmit")).toBe("Закрыть смену целиком");
    expect(text("office.shifts.notClosed")).toBe("Не закрыли: {{devices}}.");
    expect(text("office.shifts.reasonMissing")).toBe("Причина не указана");
    expect(text("office.overview.lines.stations")).toBe("станций в смене: {{active}} из {{max}}");
    expect(text("office.overview.attention.shiftWaits.title")).toBe(
      "Смена {{number}} ждёт отозванное или приостановленное устройство",
    );
    expect(text("office.overview.attention.shiftWaits.detail")).toBe(
      "Остальные устройства закрыли свои части: закройте смену целиком",
    );
  });

  it("keeps the placeholders the components pass", () => {
    expect(text("office.shifts.notClosedItem")).toBe("{{name}} ({{state}})");
    expect(text("office.shifts.notClosedItemRevoked")).toBe(
      "{{name}} ({{state}}, устройство отозвано)",
    );
    expect(text("office.shifts.totals.byDeviceValue")).toContain("{{units}}");
    expect(text("office.shifts.totals.byDeviceValue")).toContain("{{boxes}}");
    expect(text("office.shifts.totals.byDeviceValue")).toContain("{{pallets}}");
    expect(text("office.shifts.reasonIntro")).toContain("{{plan}}");
    expect(text("office.shifts.reasonIntro")).toContain("{{accepted}}");
    expect(text("office.devices.presence.active")).toContain("{{number}}");
    expect(text("office.overview.attention.participant.title")).toContain("{{duration}}");
    expect(text("office.overview.attention.shiftWaits.title")).toContain("{{number}}");
    expect(text("office.devices.revokeOpenShifts")).toContain("{{shifts}}");
    expect(text("office.devices.shiftOnStationShared")).toContain("{{number}}");
  });
});
