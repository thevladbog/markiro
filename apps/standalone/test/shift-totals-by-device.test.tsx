import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TECHNOLOGIST } from "./support/office.js";
import { ACTIVE, openShifts, shiftsSession, SHARED, STATION_ID } from "./support/shifts.js";

async function openTotals(session: ReturnType<typeof shiftsSession>): Promise<HTMLElement> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: "Итоги смены OCT26-004" }));
  const dialog = await screen.findByRole("dialog", { name: "Итоги смены OCT26-004" });
  // The figures load after the dialog opens: wait for them, so «adds nothing» is not a read of the spinner.
  await within(dialog).findByText("Принято кодов");
  return dialog;
}

/** The «По устройствам» block as device → figures. */
function breakdown(dialog: HTMLElement): Record<string, string | null> {
  const section = within(dialog).getByRole("region", { name: "По устройствам" });
  return Object.fromEntries(
    within(section)
      .getAllByRole("term")
      .map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? null]),
  );
}

describe("a shift's totals with each device's part (plan 2b)", () => {
  it("lists each device with the codes it accepted, its closed boxes and pallets, in the order of the participants", async () => {
    const dialog = await openTotals(shiftsSession([SHARED]));
    expect(breakdown(dialog)).toEqual({
      "Станция линии 1": "427 шт · 35 кор. · 0 пал.",
      "ТСД 1": "120 шт · 10 кор. · 0 пал.",
    });
    // The shift-wide figures stay the shift's.
    expect(within(dialog).getByText("Принято кодов").nextElementSibling?.textContent).toBe("547");
  });

  it("names the devices from the participants, so a technologist sees names too", async () => {
    const dialog = await openTotals(shiftsSession([SHARED], TECHNOLOGIST));
    expect(Object.keys(breakdown(dialog))).toEqual(["Станция линии 1", "ТСД 1"]);
  });

  it("gives a validation shift only the codes", async () => {
    const validation = { ...SHARED, mode: "validation" as const };
    const dialog = await openTotals(shiftsSession([validation]));
    expect(breakdown(dialog)).toEqual({ "Станция линии 1": "427 шт", "ТСД 1": "120 шт" });
  });

  it("adds nothing for a shift of one device", async () => {
    const single = {
      ...ACTIVE,
      byDevice: [{ deviceId: STATION_ID, accepted: 547, boxesClosed: 45, pallets: 0 }],
    };
    const dialog = await openTotals(shiftsSession([single]));
    expect(within(dialog).queryByRole("region", { name: "По устройствам" })).toBeNull();
  });

  it("adds nothing for a shift of a host before protocol 7", async () => {
    const dialog = await openTotals(shiftsSession([ACTIVE]));
    expect(within(dialog).queryByRole("region", { name: "По устройствам" })).toBeNull();
  });
});
