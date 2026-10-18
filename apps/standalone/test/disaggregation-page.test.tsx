import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type {
  DisaggregationDetail,
  DisaggregationDocument,
  DisaggregationReason,
} from "../src/host/disaggregation.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { chooseText, optionTexts, shownIn, waitForList } from "./support/select.js";
import { freezeToday, pickDate } from "./support/shifts.js";

const TOKEN = "office-session-token";
const ID_BASE = "6a1f3c5e-7b9d-4e2f-8a4c-1d3e5f7a";

const DAMAGED: DisaggregationReason = {
  id: "d15a0000-0000-4000-8000-000000000003",
  name: "Повреждена упаковка",
  sortOrder: 30,
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
const OLD_REASON: DisaggregationReason = {
  id: "d15a0000-0000-4000-8000-000000000009",
  name: "Старая причина",
  sortOrder: 10,
  archived: true,
  rev: 2,
};

function document_(
  n: number,
  overrides: Partial<DisaggregationDocument> = {},
): DisaggregationDocument {
  return {
    id: `${ID_BASE}${String(n).padStart(4, "0")}`,
    docNo: `DSG-26-${String(n).padStart(4, "0")}`,
    status: "draft",
    reasonId: null,
    reasonName: null,
    comment: null,
    source: "manual",
    lineCount: 0,
    codeCount: 0,
    createdBy: "2f4e6a8c-1b3d-4f5a-9c7e-0d2b4f6a8c1e",
    createdByName: "Ирина Смирнова",
    createdAt: "2026-10-13T09:00:00Z",
    appliedAt: null,
    appliedBy: null,
    appliedByName: null,
    cancelledAt: null,
    cancelledBy: null,
    rev: 1,
    ...overrides,
  };
}

const APPLIED = document_(7, {
  status: "applied",
  reasonId: DAMAGED.id,
  reasonName: DAMAGED.name,
  lineCount: 5,
  codeCount: 60,
  createdByName: "Павел Орлов",
  appliedAt: "2026-10-13T10:00:00Z",
  appliedBy: "2f4e6a8c-1b3d-4f5a-9c7e-0d2b4f6a8c1e",
  appliedByName: "Ирина Смирнова",
});
const DRAFT = document_(8, { lineCount: 2 });
const CANCELLED = document_(6, {
  status: "cancelled",
  cancelledAt: "2026-10-12T19:30:00Z",
  createdAt: "2026-10-12T08:00:00Z",
});

function session(
  documents: DisaggregationDocument[] = [DRAFT, APPLIED, CANCELLED],
  user = fakeOfficeSession().user,
): FakeOfficeSession {
  const value = fakeOfficeSession({ user });
  value.api.getOrg.mockResolvedValue(ORG_PROFILE);
  value.api.listDisaggregations.mockResolvedValue(documents);
  value.api.listDisaggregationReasons.mockResolvedValue([DAMAGED, OLD_REASON, OTHER]);
  return value;
}

async function openList(value: FakeOfficeSession): Promise<void> {
  renderOffice(value);
  fireEvent.click(await screen.findByRole("link", { name: "Дезагрегация" }));
  await screen.findByRole("heading", { name: "Дезагрегация", level: 1 });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

/** The rows of the list, cells by column title. */
function rows(): Record<string, HTMLElement>[] {
  const table = screen.getByRole("table");
  const titles = within(table)
    .getAllByRole("columnheader")
    .map((header) => header.textContent ?? "");
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      Object.fromEntries(
        within(row)
          .getAllByRole("cell")
          .map((cell, index) => [titles[index] ?? String(index), cell]),
      ),
    );
}

function lastFilter(value: FakeOfficeSession): unknown {
  return value.api.listDisaggregations.mock.calls.at(-1)?.[1];
}

describe("office «Дезагрегация»: the list", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("is in the production menu for both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = renderOffice(session(undefined, user ?? fakeOfficeSession().user));
      expect(await screen.findByRole("link", { name: "Дезагрегация" })).toBeTruthy();
      expect(screen.getByText("Производство")).toBeTruthy();
      view.unmount();
    }
  });

  it("lists the documents as the host sends them: number, time in the organization's zone, status, reason, counts, author", async () => {
    const value = session();
    await openList(value);
    expect(value.api.listDisaggregations).toHaveBeenCalledWith(TOKEN, {});
    const table = rows();
    expect(table.map((row) => row["№ документа"]?.textContent)).toEqual([
      "DSG-26-0008",
      "DSG-26-0007",
      "DSG-26-0006",
    ]);
    const applied = table[1];
    expect(applied?.["Создан"]?.textContent).toBe("13.10.2026, 12:00");
    expect(applied?.["Статус"]?.textContent).toContain("Проведён");
    expect(applied?.["Причина"]?.textContent).toBe("Повреждена упаковка");
    expect(applied?.["Строк"]?.textContent).toBe("5");
    expect(applied?.["Кодов"]?.textContent).toBe("60");
    expect(applied?.["Автор"]?.textContent).toBe("Павел Орлов");
    expect(table[0]?.["Статус"]?.textContent).toContain("Черновик");
    expect(table[0]?.["Причина"]?.textContent).toBe("—");
    expect(table[2]?.["Статус"]?.textContent).toContain("Отменён");
    expect(screen.getByRole("link", { name: "Открыть документ DSG-26-0007" })).toBeTruthy();
  });

  it("says when there is no document at all and when the filters keep none", async () => {
    const value = session([]);
    await openList(value);
    expect(screen.getByText("Документов дезагрегации пока нет.")).toBeTruthy();
    chooseText("Статус", "Проведён");
    await waitFor(() => expect(lastFilter(value)).toEqual({ status: "applied" }));
    expect(await screen.findByText("По фильтрам ничего не найдено.")).toBeTruthy();
  });

  it("offers every reason, the archived ones marked, and every status", async () => {
    await openList(session());
    await waitForList(() =>
      expect(optionTexts("Причина")).toEqual([
        "Все причины",
        "Повреждена упаковка",
        "Другое",
        "Старая причина (в архиве)",
      ]),
    );
    expect(optionTexts("Статус")).toEqual(["Все статусы", "Черновик", "Проведён", "Отменён"]);
  });

  it("asks the host for a status and a reason, and for the number after a pause of 300 ms", async () => {
    vi.useRealTimers();
    const value = session();
    await openList(value);
    chooseText("Статус", "Проведён");
    await waitFor(() => expect(lastFilter(value)).toEqual({ status: "applied" }));
    await waitForList(() => expect(optionTexts("Причина").length).toBe(4));
    chooseText("Причина", "Повреждена упаковка");
    await waitFor(() =>
      expect(lastFilter(value)).toEqual({ status: "applied", reasonId: DAMAGED.id }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = value.api.listDisaggregations.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Номер документа"), { target: { value: " 0007 " } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    // Not yet: the number is typed, the pause is not over.
    expect(value.api.listDisaggregations.mock.calls.length).toBe(calls);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await waitFor(() =>
      expect(lastFilter(value)).toEqual({ status: "applied", reasonId: DAMAGED.id, q: "0007" }),
    );
  });

  it("asks for a period as the organization's days turned into instants", async () => {
    const value = session();
    await openList(value);
    pickDate("С", "13 октября 2026");
    pickDate("По", "13 октября 2026");
    await waitFor(() =>
      expect(lastFilter(value)).toEqual({
        from: "2026-10-12T21:00:00Z",
        to: "2026-10-13T20:59:59Z",
      }),
    );
  });

  it("does not ask when «С» is later than «По», and says so", async () => {
    const value = session();
    await openList(value);
    pickDate("С", "13 октября 2026");
    pickDate("По", "1 октября 2026");
    expect(await screen.findByText("Дата «С» позже даты «По».")).toBeTruthy();
    const asked = value.api.listDisaggregations.mock.calls.map((call) => call[1]);
    expect(asked.some((filter) => filter?.to === "2026-10-01T20:59:59Z")).toBe(false);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("resets the filters to the list without any", async () => {
    const value = session();
    await openList(value);
    expect(screen.queryByRole("button", { name: "Сбросить фильтры" })).toBeNull();
    chooseText("Статус", "Отменён");
    await waitFor(() => expect(lastFilter(value)).toEqual({ status: "cancelled" }));
    fireEvent.click(await screen.findByRole("button", { name: "Сбросить фильтры" }));
    await waitFor(() => expect(lastFilter(value)).toEqual({}));
    expect(shownIn("Статус")).toBe("Все статусы");
    expect(screen.queryByRole("button", { name: "Сбросить фильтры" })).toBeNull();
  });

  it("divides 11 documents into two pages of 10", async () => {
    const many = Array.from({ length: 11 }, (_, n) => document_(100 - n));
    await openList(session(many));
    expect(rows().length).toBe(10);
    expect(screen.getByText("Страница 1 из 2")).toBeTruthy();
    const pager = screen.getByRole("navigation", { name: "Страницы документов" });
    fireEvent.click(within(pager).getByRole("button", { name: "Вперёд" }));
    expect(rows().length).toBe(1);
    expect(rows()[0]?.["№ документа"]?.textContent).toBe("DSG-26-0090");
  });

  it("makes a document with no reason and no comment and opens it", async () => {
    const value = session();
    const created = document_(9);
    const detail: DisaggregationDetail = { document: created, lines: [] };
    value.api.createDisaggregation.mockResolvedValue(detail);
    value.api.getDisaggregation.mockResolvedValue(detail);
    await openList(value);
    fireEvent.click(screen.getByRole("button", { name: "Создать документ" }));
    expect(await screen.findByRole("heading", { name: "Документ DSG-26-0009" })).toBeTruthy();
    expect(value.api.createDisaggregation).toHaveBeenCalledWith(TOKEN, {
      reasonId: null,
      comment: null,
    });
    expect(value.api.getDisaggregation).toHaveBeenCalledWith(TOKEN, created.id);
  });

  it("lets a technologist make a document too", async () => {
    const value = session(undefined, TECHNOLOGIST);
    await openList(value);
    expect(screen.getByRole("button", { name: "Создать документ" })).toBeTruthy();
  });

  it("explains a document that could not be made, and stays on the list", async () => {
    const value = session();
    value.api.createDisaggregation.mockRejectedValue(
      new HostError({ kind: "api", code: "internal", status: 500, message: "boom" }),
    );
    await openList(value);
    fireEvent.click(screen.getByRole("button", { name: "Создать документ" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Дезагрегация", level: 1 })).toBeTruthy();
  });

  it("opens the reasons page from the link, and not a document called «reasons»", async () => {
    const value = session();
    value.api.listDisaggregationReasons.mockResolvedValue([DAMAGED]);
    await openList(value);
    fireEvent.click(screen.getByRole("link", { name: "Причины дезагрегации" }));
    expect(
      await screen.findByRole("heading", { name: "Причины дезагрегации", level: 1 }),
    ).toBeTruthy();
    expect(value.api.getDisaggregation).not.toHaveBeenCalled();
  });

  it("shows a list that did not load with a way to try again", async () => {
    const value = session();
    value.api.listDisaggregations.mockRejectedValueOnce(
      new HostError({ kind: "api", code: "internal", status: 500, message: "boom" }),
    );
    renderOffice(value);
    fireEvent.click(await screen.findByRole("link", { name: "Дезагрегация" }));
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("DSG-26-0007")).toBeTruthy();
  });
});
