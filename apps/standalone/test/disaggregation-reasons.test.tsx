import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { DisaggregationReason } from "../src/host/disaggregation.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { expectFocusedNotice } from "./support/shifts.js";

const TOKEN = "office-session-token";

const DAMAGED: DisaggregationReason = {
  id: "d15a0000-0000-4000-8000-000000000003",
  name: "Повреждена упаковка",
  sortOrder: 30,
  archived: false,
  rev: 4,
};
const WRONG: DisaggregationReason = {
  id: "d15a0000-0000-4000-8000-000000000001",
  name: "Не тот товар",
  sortOrder: 10,
  archived: false,
  rev: 0,
};
const OTHER: DisaggregationReason = {
  id: "d15a0000-0000-4000-8000-000000000005",
  name: "Другое",
  sortOrder: 50,
  archived: false,
  rev: 0,
};
const OLD: DisaggregationReason = {
  id: "d15a0000-0000-4000-8000-000000000009",
  name: "Старая причина",
  sortOrder: 5,
  archived: true,
  rev: 2,
};

function session(user = fakeOfficeSession().user): FakeOfficeSession {
  const value = fakeOfficeSession({ user });
  // The host's own order (archived last): the page sorts again by `sortOrder`.
  value.api.listDisaggregationReasons.mockResolvedValue([OTHER, DAMAGED, WRONG, OLD]);
  return value;
}

/** Opens the reasons from the list's link and waits for the table. */
async function openReasons(value: FakeOfficeSession): Promise<void> {
  value.api.getOrg.mockResolvedValue({
    name: "ООО «Атолл»",
    inn: "7701234567",
    gln: "4600682000013",
    gs1Prefixes: ["4600682"],
    timeZone: "Europe/Moscow",
    rev: 4,
  });
  value.api.listDisaggregations.mockResolvedValue([]);
  renderOffice(value);
  fireEvent.click(await screen.findByRole("link", { name: "Дезагрегация" }));
  fireEvent.click(await screen.findByRole("link", { name: "Причины дезагрегации" }));
  await screen.findByRole("heading", { name: "Причины дезагрегации", level: 1 });
  await screen.findByText("Не тот товар");
}

function names(): (string | null | undefined)[] {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent);
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("office «Причины дезагрегации»", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("lists the reasons in their order, those in use first and the archived last", async () => {
    await openReasons(session());
    expect(names()).toEqual(["Не тот товар", "Повреждена упаковка", "Другое", "Старая причина"]);
    expect(within(rowOf("Повреждена упаковка")).getAllByRole("cell")[1]?.textContent).toBe("30");
    expect(within(rowOf("Повреждена упаковка")).getByText("Действует")).toBeTruthy();
    expect(within(rowOf("Старая причина")).getByText("В архиве")).toBeTruthy();
  });

  it("links back to the documents", async () => {
    await openReasons(session());
    fireEvent.click(screen.getByRole("link", { name: "← Дезагрегация" }));
    expect(await screen.findByRole("heading", { name: "Дезагрегация", level: 1 })).toBeTruthy();
  });

  it("says when there is no reason", async () => {
    const value = session();
    value.api.listDisaggregationReasons.mockResolvedValue([]);
    value.api.listDisaggregations.mockResolvedValue([]);
    renderOffice(value);
    fireEvent.click(await screen.findByRole("link", { name: "Дезагрегация" }));
    fireEvent.click(await screen.findByRole("link", { name: "Причины дезагрегации" }));
    expect(await screen.findByText("Причины не добавлены.")).toBeTruthy();
  });

  it("adds a reason with its trimmed name and its order", async () => {
    const value = session();
    const added: DisaggregationReason = {
      id: "d15a0000-0000-4000-8000-0000000000aa",
      name: "Недостача",
      sortOrder: 60,
      archived: false,
      rev: 0,
    };
    value.api.createDisaggregationReason.mockResolvedValue(added);
    await openReasons(value);
    fireEvent.click(screen.getByRole("button", { name: "Добавить причину" }));
    const dialog = screen.getByRole("dialog", { name: "Новая причина" });
    expect(within(dialog).queryByLabelText("В архиве")).toBeNull();
    // The next place after the last one.
    expect((within(dialog).getByLabelText("Порядок") as HTMLInputElement).value).toBe("60");
    type("Название", "  Недостача  ");
    fireEvent.click(within(dialog).getByRole("button", { name: "Добавить причину" }));
    await expectFocusedNotice("Причина «Недостача» добавлена.");
    expect(value.api.createDisaggregationReason).toHaveBeenCalledWith(TOKEN, {
      name: "Недостача",
      sortOrder: 60,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(names()).toEqual([
      "Не тот товар",
      "Повреждена упаковка",
      "Другое",
      "Недостача",
      "Старая причина",
    ]);
  });

  it("changes the whole reason over its revision", async () => {
    const value = session();
    value.api.updateDisaggregationReason.mockResolvedValue({
      ...DAMAGED,
      name: "Повреждение упаковки",
      rev: 5,
    });
    await openReasons(value);
    fireEvent.click(screen.getByRole("button", { name: "Изменить причину Повреждена упаковка" }));
    const dialog = screen.getByRole("dialog", { name: "Причина «Повреждена упаковка»" });
    expect((within(dialog).getByLabelText("Название") as HTMLInputElement).value).toBe(
      "Повреждена упаковка",
    );
    expect((within(dialog).getByLabelText("Порядок") as HTMLInputElement).value).toBe("30");
    // Nothing changed yet: nothing to save.
    expect(within(dialog).getByRole("button", { name: "Сохранить" }).hasAttribute("disabled")).toBe(
      true,
    );
    type("Название", "Повреждение упаковки");
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await expectFocusedNotice("Изменения сохранены.");
    expect(value.api.updateDisaggregationReason).toHaveBeenCalledWith(TOKEN, DAMAGED.id, {
      name: "Повреждение упаковки",
      sortOrder: 30,
      archived: false,
      expectedRev: 4,
    });
    expect(screen.getByText("Повреждение упаковки")).toBeTruthy();
  });

  it("moves a reason to the archive and out of the way of the others", async () => {
    const value = session();
    value.api.updateDisaggregationReason.mockResolvedValue({ ...WRONG, archived: true, rev: 1 });
    await openReasons(value);
    fireEvent.click(screen.getByRole("button", { name: "Изменить причину Не тот товар" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "В архиве" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await expectFocusedNotice("Изменения сохранены.");
    expect(value.api.updateDisaggregationReason).toHaveBeenCalledWith(TOKEN, WRONG.id, {
      name: "Не тот товар",
      sortOrder: 10,
      archived: true,
      expectedRev: 0,
    });
    expect(names()).toEqual(["Повреждена упаковка", "Другое", "Старая причина", "Не тот товар"]);
    expect(within(rowOf("Не тот товар")).getByText("В архиве")).toBeTruthy();
  });

  it("brings an archived reason back with the same dialog", async () => {
    const value = session();
    value.api.updateDisaggregationReason.mockResolvedValue({ ...OLD, archived: false, rev: 3 });
    await openReasons(value);
    fireEvent.click(screen.getByRole("button", { name: "Изменить причину Старая причина" }));
    const dialog = screen.getByRole("dialog");
    const archived = within(dialog).getByRole("checkbox", { name: "В архиве" });
    expect(archived.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(archived);
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await expectFocusedNotice("Изменения сохранены.");
    expect(value.api.updateDisaggregationReason.mock.calls[0]?.[2]).toMatchObject({
      archived: false,
      expectedRev: 2,
    });
  });

  it("refuses an empty name and a fractional order without asking the host", async () => {
    const value = session();
    await openReasons(value);
    fireEvent.click(screen.getByRole("button", { name: "Добавить причину" }));
    type("Название", "   ");
    type("Порядок", "1.5");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Добавить причину" }),
    );
    expect(await screen.findByText("Укажите название.")).toBeTruthy();
    expect(screen.getByText("Введите целое число.")).toBeTruthy();
    expect(value.api.createDisaggregationReason).not.toHaveBeenCalled();
  });

  it("refuses a name over 120 characters and an order out of range", async () => {
    const value = session();
    await openReasons(value);
    fireEvent.click(screen.getByRole("button", { name: "Добавить причину" }));
    type("Название", "я".repeat(121));
    type("Порядок", "1000001");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Добавить причину" }),
    );
    expect(await screen.findByText("Не больше 120 символов.")).toBeTruthy();
    expect(screen.getByText("Порядок — число от −1 000 000 до 1 000 000.")).toBeTruthy();
    expect(value.api.createDisaggregationReason).not.toHaveBeenCalled();
  });

  it("offers to load the reasons again after a stale change", async () => {
    const value = session();
    value.api.updateDisaggregationReason.mockRejectedValue(
      new HostError({ kind: "api", code: "stale_revision", status: 409, message: "stale" }),
    );
    await openReasons(value);
    const reads = value.api.listDisaggregationReasons.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Изменить причину Другое" }));
    type("Название", "Прочее");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() =>
      expect(value.api.listDisaggregationReasons.mock.calls.length).toBe(reads + 1),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lets a technologist do the same (the host gives both roles the reasons)", async () => {
    const value = session(TECHNOLOGIST);
    value.api.createDisaggregationReason.mockResolvedValue({
      id: "d15a0000-0000-4000-8000-0000000000bb",
      name: "Излишек",
      sortOrder: 0,
      archived: false,
      rev: 0,
    });
    await openReasons(value);
    expect(screen.getByRole("button", { name: "Изменить причину Другое" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Добавить причину" }));
    type("Название", "Излишек");
    type("Порядок", "0");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Добавить причину" }),
    );
    await expectFocusedNotice("Причина «Излишек» добавлена.");
    expect(value.api.createDisaggregationReason).toHaveBeenCalledWith(TOKEN, {
      name: "Излишек",
      sortOrder: 0,
    });
  });

  it("shows a list that did not load with a way to try again", async () => {
    const value = session();
    // The list reads the reasons for its filter first, then the page itself.
    value.api.listDisaggregationReasons
      .mockResolvedValueOnce([OTHER])
      .mockRejectedValueOnce(
        new HostError({ kind: "api", code: "internal", status: 500, message: "boom" }),
      );
    value.api.listDisaggregations.mockResolvedValue([]);
    renderOffice(value);
    fireEvent.click(await screen.findByRole("link", { name: "Дезагрегация" }));
    fireEvent.click(await screen.findByRole("link", { name: "Причины дезагрегации" }));
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Не тот товар")).toBeTruthy();
  });
});
