import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeLine } from "../src/host/protocol.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { pressRowAction } from "./support/row-menu.js";
import { LINE_10, LINE_2, SHARED } from "./support/shifts.js";

const TOKEN = "office-session-token";
const THREE: OfficeLine = { ...LINE_2, maxStations: 3 };
const LABEL = "Максимум станций в смене";
const IN_USE = "Сейчас в смене работают 2 устройства: меньше поставить нельзя.";
const BELOW = "В смене этой линии работают 2 устройства: максимум не может быть меньше.";

function session(): FakeOfficeSession {
  const fake = fakeOfficeSession();
  // Line 2 allows three devices and two work its shift; line 10 is a line of an older host.
  fake.api.listLines.mockResolvedValue([LINE_10, THREE]);
  fake.api.listShifts.mockResolvedValue([SHARED]);
  return fake;
}

async function openLines(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake, { initialPath: "/lines" });
  await screen.findByRole("link", { name: "Линии" });
  await screen.findByText("Линия 10");
}

async function openRename(fake: FakeOfficeSession): Promise<HTMLElement> {
  await openLines(fake);
  pressRowAction(screen, "Переименовать линию «Линия 2»");
  return screen.findByRole("dialog");
}

function typeLimit(value: string): void {
  fireEvent.change(screen.getByLabelText(LABEL), { target: { value } });
}

describe("the line's limit in the office (plan 2b)", () => {
  it("lists it in its own column, and one for a line of an older host", async () => {
    await openLines(session());
    expect(
      within(screen.getByRole("table"))
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
    ).toEqual(["Название", "Макс. станций", "Состояние", "Действия"]);
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole("cell")
          .slice(0, 2)
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["Линия 2", "3"],
      ["Линия 10", "1"],
    ]);
  });

  it("changes only the limit and sends it with the loaded revision", async () => {
    const fake = session();
    fake.api.updateLine.mockResolvedValue({ ...THREE, maxStations: 4, rev: 41 });
    const dialog = await openRename(fake);
    expect((within(dialog).getByLabelText(LABEL) as HTMLInputElement).value).toBe("3");
    typeLimit("4");
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(fake.api.updateLine).toHaveBeenCalledWith(TOKEN, THREE.id, {
        maxStations: 4,
        expectedRev: 40,
      }),
    );
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
  });

  it("says how many devices work the line and refuses a limit below them before asking the host", async () => {
    const fake = session();
    const dialog = await openRename(fake);
    expect(await within(dialog).findByText(IN_USE)).toBeTruthy();
    typeLimit("1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    expect(await within(dialog).findByText(BELOW)).toBeTruthy();
    expect(fake.api.updateLine).not.toHaveBeenCalled();
    // Two is exactly the devices at work: allowed.
    typeLimit("2");
    fake.api.updateLine.mockResolvedValue({ ...THREE, maxStations: 2, rev: 41 });
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(fake.api.updateLine).toHaveBeenCalledWith(TOKEN, THREE.id, {
        maxStations: 2,
        expectedRev: 40,
      }),
    );
  });

  it("puts the host's refusal under the field with the host's count", async () => {
    const fake = session();
    // The shifts did not load, so the form could not know; the host did.
    fake.api.listShifts.mockRejectedValue(new Error("down"));
    fake.api.updateLine.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "more devices work a shift of this line than the new limit",
        details: { constraint: "line_stations_in_use", active: 3 },
      }),
    );
    const dialog = await openRename(fake);
    typeLimit("2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    expect(
      await within(dialog).findByText(
        "В смене этой линии работают 3 устройства: максимум не может быть меньше.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText(LABEL).getAttribute("aria-invalid")).toBe("true");
  });

  it("refuses a limit that is not a whole number from 1 to 16", async () => {
    const fake = session();
    const dialog = await openRename(fake);
    for (const value of ["0", "17", "1.5", ""]) {
      typeLimit(value);
      fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
      expect(await within(dialog).findByText("Укажите целое число от 1 до 16"), value).toBeTruthy();
    }
    expect(fake.api.updateLine).not.toHaveBeenCalled();
  });

  it("offers no limit when a line is added", async () => {
    await openLines(session());
    fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText(LABEL)).toBeNull();
  });

  it("shows a technologist the limit and no way to change it", async () => {
    const readOnly = fakeOfficeSession({ user: TECHNOLOGIST });
    readOnly.api.listLines.mockResolvedValue([THREE]);
    renderOffice(readOnly, { initialPath: "/lines" });
    await screen.findByText("Линия 2");
    const row = screen.getByText("Линия 2").closest("tr");
    expect(within(row as HTMLElement).getAllByRole("cell")[1]?.textContent).toBe("3");
    expect(screen.queryByRole("button", { name: /Переименовать/ })).toBeNull();
  });
});
