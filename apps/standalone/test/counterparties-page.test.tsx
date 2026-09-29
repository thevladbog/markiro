import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { CounterpartyRecord } from "../src/host/protocol.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const NORTH: CounterpartyRecord = {
  id: "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
  name: "ООО «Северный берег»",
  inn: "7812345678",
  gln: "4601234000017",
  gs1Prefixes: ["4601234"],
  archived: false,
  rev: 12,
};
const PLANT_2: CounterpartyRecord = {
  id: "3a7f2c1e-9b4d-4e6f-8a1b-2c3d4e5f6a7b",
  name: "Завод 2",
  inn: null,
  gln: "4605555000015",
  gs1Prefixes: [],
  archived: false,
  rev: 3,
};
const PLANT_10: CounterpartyRecord = {
  id: "8e1d4c7b-2a5f-4b3e-9c6d-7f8a9b0c1d2e",
  name: "Завод 10",
  inn: "781234567890",
  gln: "4602222000026",
  gs1Prefixes: ["4602222", "4603333"],
  archived: false,
  rev: 4,
};
const OLD: CounterpartyRecord = {
  id: "5c9b8a7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
  name: "Альфа",
  inn: "7701234567",
  gln: "4603333000035",
  gs1Prefixes: [],
  archived: true,
  rev: 7,
};

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  // The host's own order (archived last, names bytewise): the page sorts again.
  session.api.listCounterparties.mockResolvedValue([PLANT_10, PLANT_2, NORTH, OLD]);
  return session;
}

async function openCounterparties(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Контрагенты" }));
  await screen.findByText("ООО «Северный берег»");
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

describe("office counterparties", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu for both roles", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    expect(await screen.findByRole("link", { name: "Контрагенты" })).toBeTruthy();
  });

  it("lists the counterparties by name, numbers in order, archived ones last", async () => {
    await openCounterparties(adminSession());
    expect(names()).toEqual(["Завод 2", "Завод 10", "ООО «Северный берег»", "Альфа"]);
    const plant = rowOf("Завод 10");
    expect(within(plant).getByText("781234567890")).toBeTruthy();
    expect(within(plant).getByText("4602222, 4603333")).toBeTruthy();
    expect(within(plant).getByText("Действует")).toBeTruthy();
    expect(within(rowOf("Завод 2")).getAllByText("—")).toHaveLength(2);
    expect(within(rowOf("Альфа")).getByText("В архиве")).toBeTruthy();
  });

  it("shows a technologist the list without a way to change it", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.listCounterparties.mockResolvedValue([NORTH]);
    await openCounterparties(session);
    expect(screen.queryByRole("button", { name: "Добавить контрагента" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Изменить/ })).toBeNull();
    expect(screen.getByText("Изменять эти данные может только администратор.")).toBeTruthy();
  });

  it("adds a counterparty, sending each field by name", async () => {
    const session = adminSession();
    const created: CounterpartyRecord = {
      id: "0f1e2d3c-4b5a-4968-8776-655443322110",
      name: "ООО «Юг»",
      inn: null,
      gln: "4607091000009",
      gs1Prefixes: ["4607091", "4609876"],
      archived: false,
      rev: 20,
    };
    session.api.createCounterparty.mockResolvedValue(created);
    await openCounterparties(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить контрагента" }));
    expect(within(dialog()).queryByRole("checkbox")).toBeNull();
    type("Название", " ООО «Юг» ");
    type("GLN контрагента", "4607091000009");
    type("Префиксы GS1", "4607091, 4607091; 4609876");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Контрагент «ООО «Юг»» добавлен.")).toBeTruthy();
    expect(session.api.createCounterparty.mock.calls).toStrictEqual([
      [
        "office-session-token",
        {
          name: "ООО «Юг»",
          inn: null,
          gln: "4607091000009",
          gs1Prefixes: ["4607091", "4609876"],
        },
      ],
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(names()).toEqual(["Завод 2", "Завод 10", "ООО «Северный берег»", "ООО «Юг»", "Альфа"]);
  });

  it("checks the fields like the host, and the GLN check digit, before sending", async () => {
    const session = adminSession();
    await openCounterparties(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить контрагента" }));
    type("Название", "ООО\t«Юг»");
    type("ИНН", "781234567");
    type("GLN контрагента", "4607091000000");
    type("Префиксы GS1", "123");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Укажите название, до 200 символов")).toBeTruthy();
    expect(screen.getByText("ИНН — 10 или 12 цифр")).toBeTruthy();
    expect(screen.getByText("Неверная контрольная цифра GLN")).toBeTruthy();
    expect(
      screen.getByText("Каждый префикс — от 4 до 12 цифр, не больше 10 префиксов"),
    ).toBeTruthy();
    expect(session.api.createCounterparty).not.toHaveBeenCalled();
  });

  it("saves a change as the whole record with the loaded revision, archive included", async () => {
    const session = adminSession();
    session.api.updateCounterparty.mockResolvedValue({
      ...NORTH,
      name: "ООО «Северный берег-2»",
      archived: true,
      rev: 21,
    });
    await openCounterparties(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить контрагента «ООО «Северный берег»»" }),
    );
    const save = within(dialog()).getByRole("button", { name: "Сохранить" });
    expect(save).toHaveProperty("disabled", true);
    type("Название", "ООО «Северный берег-2»");
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "В архиве" }));
    fireEvent.click(save);
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateCounterparty.mock.calls).toStrictEqual([
      [
        "office-session-token",
        NORTH.id,
        {
          name: "ООО «Северный берег-2»",
          inn: "7812345678",
          gln: "4601234000017",
          gs1Prefixes: ["4601234"],
          archived: true,
          expectedRev: 12,
        },
      ],
    ]);
    expect(names()).toEqual(["Завод 2", "Завод 10", "Альфа", "ООО «Северный берег-2»"]);
    expect(within(rowOf("ООО «Северный берег-2»")).getByText("В архиве")).toBeTruthy();
  });

  it("clears the INN with null and takes a counterparty out of the archive", async () => {
    const session = adminSession();
    session.api.updateCounterparty.mockResolvedValue({
      ...OLD,
      inn: null,
      archived: false,
      rev: 22,
    });
    await openCounterparties(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить контрагента «Альфа»" }));
    type("ИНН", " ");
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "В архиве" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateCounterparty).toHaveBeenCalledWith("office-session-token", OLD.id, {
      name: "Альфа",
      inn: null,
      gln: "4603333000035",
      gs1Prefixes: [],
      archived: false,
      expectedRev: 7,
    });
    expect(names()).toEqual(["Альфа", "Завод 2", "Завод 10", "ООО «Северный берег»"]);
  });

  it("offers to load the list again after a stale change", async () => {
    const session = adminSession();
    session.api.updateCounterparty.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 13 },
      }),
    );
    await openCounterparties(session);
    fireEvent.click(
      screen.getByRole("button", { name: "Изменить контрагента «ООО «Северный берег»»" }),
    );
    type("Название", "ООО «Северный берег-2»");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listCounterparties).toHaveBeenCalledTimes(2));
  });

  it("puts the host's refusal of a field under that field", async () => {
    const session = adminSession();
    session.api.createCounterparty.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "the GLN must be 13 digits",
        details: { field: "gln" },
      }),
    );
    await openCounterparties(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить контрагента" }));
    type("Название", "ООО «Юг»");
    type("GLN контрагента", "4607091000009");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    const message = await screen.findByText("Хост не принял это значение. Проверьте его.");
    expect(screen.getByLabelText("GLN контрагента").getAttribute("aria-describedby")).toBe(
      message.id,
    );
  });

  it("sends one request for a double click, and none while it is on its way", async () => {
    const session = adminSession();
    let answer: (record: CounterpartyRecord) => void = () => undefined;
    session.api.createCounterparty.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await openCounterparties(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить контрагента" }));
    type("Название", "ООО «Юг»");
    type("GLN контрагента", "4607091000009");
    const add = within(dialog()).getByRole("button", { name: "Добавить" });
    fireEvent.click(add);
    fireEvent.click(add);
    await waitFor(() => expect(add).toHaveProperty("disabled", true));
    fireEvent.click(add);
    expect(session.api.createCounterparty).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer({ ...NORTH, id: "0f1e2d3c-4b5a-4968-8776-655443322110", name: "ООО «Юг»", rev: 20 });
    });
    expect(await screen.findByText("Контрагент «ООО «Юг»» добавлен.")).toBeTruthy();
    expect(session.api.createCounterparty).toHaveBeenCalledTimes(1);
  });
});
