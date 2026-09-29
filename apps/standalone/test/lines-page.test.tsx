import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeLine } from "../src/host/protocol.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const LINE_2: OfficeLine = {
  id: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  name: "Линия 2",
  archived: false,
  rev: 40,
};
const LINE_10: OfficeLine = {
  id: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21",
  name: "Линия 10",
  archived: false,
  rev: 41,
};
const PACKING: OfficeLine = {
  id: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  name: "Фасовка",
  archived: false,
  rev: 42,
};
const OLD_LINE: OfficeLine = {
  id: "9b2e4a6c-1d3f-4e5a-8b7c-6d5e4f3a2b1c",
  name: "Линия 1",
  archived: true,
  rev: 30,
};

function conflict(): HostError {
  return new HostError({
    kind: "api",
    code: "conflict",
    status: 409,
    message: "another active line has this name",
    details: { constraint: "line_name" },
  });
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  // The host's own order (archived last, names bytewise): the page sorts again.
  session.api.listLines.mockResolvedValue([LINE_10, LINE_2, PACKING, OLD_LINE]);
  return session;
}

async function openLines(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Линии" }));
  await screen.findByText("Фасовка");
}

/** The names column, top to bottom. */
function names(): (string | null | undefined)[] {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent);
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("office lines", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu for a technologist, under «Производство»", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    expect(await screen.findByRole("link", { name: "Линии" })).toBeTruthy();
    expect(screen.getByText("Производство")).toBeTruthy();
  });

  it("lists the lines by name, numbers in order, archived ones last", async () => {
    await openLines(adminSession());
    expect(names()).toEqual(["Линия 2", "Линия 10", "Фасовка", "Линия 1"]);
    expect(within(rowOf("Линия 10")).getByText("Действует")).toBeTruthy();
    expect(within(rowOf("Линия 1")).getByText("В архиве")).toBeTruthy();
    expect(
      within(rowOf("Линия 1")).getByRole("button", { name: "Вернуть линию «Линия 1» из архива" }),
    ).toBeTruthy();
    expect(within(rowOf("Линия 1")).queryByRole("button", { name: /Переименовать/ })).toBeNull();
  });

  it("shows a technologist the lines without a way to change them", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.listLines.mockResolvedValue([LINE_2, OLD_LINE]);
    renderOffice(session);
    fireEvent.click(await screen.findByRole("link", { name: "Линии" }));
    await screen.findByText("Линия 2");
    expect(screen.queryByRole("button", { name: "Добавить линию" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Переименовать|архив/ })).toBeNull();
    expect(screen.getByText("Изменять эти данные может только администратор.")).toBeTruthy();
  });

  it("adds a line with its trimmed name", async () => {
    const session = adminSession();
    session.api.createLine.mockResolvedValue({
      id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
      name: "Линия 3",
      archived: false,
      rev: 50,
    });
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
    type("Название линии", "  Линия 3 ");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Линия «Линия 3» добавлена.")).toBeTruthy();
    expect(session.api.createLine.mock.calls).toStrictEqual([
      ["office-session-token", { name: "Линия 3" }],
    ]);
    expect(names()).toEqual(["Линия 2", "Линия 3", "Линия 10", "Фасовка", "Линия 1"]);
  });

  it("says under the name when an active line already has it", async () => {
    const session = adminSession();
    session.api.createLine.mockRejectedValueOnce(conflict());
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
    type("Название линии", "фасовка");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    const message = await screen.findByText("Активная линия с таким названием уже есть");
    expect(screen.getByLabelText("Название линии").getAttribute("aria-describedby")).toBe(
      message.id,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("refuses a control character in the name before sending", async () => {
    const session = adminSession();
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
    type("Название линии", "Линия\t3");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(
      await screen.findByText("Уберите табуляцию, перенос строки или другой служебный символ"),
    ).toBeTruthy();
    expect(session.api.createLine).not.toHaveBeenCalled();
  });

  it("renames a line with the loaded revision, sending only the name", async () => {
    const session = adminSession();
    session.api.updateLine
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({ ...LINE_2, name: "Линия 2а", rev: 51 });
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Переименовать линию «Линия 2»" }));
    const save = within(dialog()).getByRole("button", { name: "Сохранить" });
    expect(save).toHaveProperty("disabled", true);
    type("Название линии", "Линия 10");
    fireEvent.click(save);
    expect(await screen.findByText("Активная линия с таким названием уже есть")).toBeTruthy();
    type("Название линии", "Линия 2а");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateLine.mock.calls).toStrictEqual([
      ["office-session-token", LINE_2.id, { name: "Линия 10", expectedRev: 40 }],
      ["office-session-token", LINE_2.id, { name: "Линия 2а", expectedRev: 40 }],
    ]);
    expect(rowOf("Линия 2а")).toBeTruthy();
  });

  it("offers to load the lines again after a stale change", async () => {
    const session = adminSession();
    session.api.updateLine.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 45 },
      }),
    );
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Переименовать линию «Линия 2»" }));
    type("Название линии", "Линия 2а");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listLines).toHaveBeenCalledTimes(2));
  });

  it("offers to load the lines again when the line to archive changed meanwhile", async () => {
    const session = adminSession();
    session.api.updateLine.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 43 },
      }),
    );
    await openLines(session);
    expect(session.api.listLines).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Убрать линию «Фасовка» в архив" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "В архив" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listLines).toHaveBeenCalledTimes(2));
    // Exactly one read again, and the archive itself is never sent a second
    // time with the host's newer revision: let every pending task settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.api.listLines).toHaveBeenCalledTimes(2);
    expect(session.api.updateLine).toHaveBeenCalledTimes(1);
  });

  it("archives a line after saying that its stations stay on it", async () => {
    const session = adminSession();
    session.api.updateLine.mockResolvedValue({ ...PACKING, archived: true, rev: 52 });
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Убрать линию «Фасовка» в архив" }));
    expect(
      within(dialog()).getByText(
        "Линию «Фасовка» больше нельзя будет выбрать на станции. Станции, которые уже работают на ней, останутся на этой линии, пока их не переведут в разделе «Устройства».",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "В архив" }));
    expect(await screen.findByText("Линия «Фасовка» убрана в архив.")).toBeTruthy();
    expect(session.api.updateLine.mock.calls).toStrictEqual([
      ["office-session-token", PACKING.id, { archived: true, expectedRev: 42 }],
    ]);
    expect(names()).toEqual(["Линия 2", "Линия 10", "Линия 1", "Фасовка"]);
    expect(within(rowOf("Фасовка")).getByText("В архиве")).toBeTruthy();
  });

  it("brings a line back from the archive, renaming it when an active line took its name", async () => {
    const session = adminSession();
    session.api.updateLine
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({ ...OLD_LINE, name: "Линия 1 (старая)", archived: false, rev: 53 });
    await openLines(session);
    fireEvent.click(screen.getByRole("button", { name: "Вернуть линию «Линия 1» из архива" }));
    // The title names the line, as the rename dialog's does.
    expect(screen.getByRole("dialog", { name: "Вернуть линию «Линия 1» из архива" })).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "Линия снова появится в выборе линии на станциях. Если её название уже заняла другая линия, дайте ей новое.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Вернуть" }));
    expect(await screen.findByText("Активная линия с таким названием уже есть")).toBeTruthy();
    type("Название линии", "Линия 1 (старая)");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Вернуть" }));
    expect(await screen.findByText("Линия «Линия 1 (старая)» возвращена из архива.")).toBeTruthy();
    expect(session.api.updateLine.mock.calls).toStrictEqual([
      ["office-session-token", OLD_LINE.id, { archived: false, expectedRev: 30 }],
      [
        "office-session-token",
        OLD_LINE.id,
        { name: "Линия 1 (старая)", archived: false, expectedRev: 30 },
      ],
    ]);
    expect(names()).toEqual(["Линия 1 (старая)", "Линия 2", "Линия 10", "Фасовка"]);
  });
});
