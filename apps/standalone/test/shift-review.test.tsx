import { readFileSync } from "node:fs";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeShift } from "../src/host/protocol.js";
import {
  officeConflictPageSchema,
  officeShiftExceptionsSchema,
  officeShiftRejectionsSchema,
  type OfficeShiftException,
} from "../src/host/review.js";
import type { FakeOfficeSession } from "./support/office.js";
import { ACTIVE, CLOSED, openShifts, PALLET, PLANNED, shiftsSession } from "./support/shifts.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}
const EXCEPTIONS = officeShiftExceptionsSchema.parse(fixture("office-shift-exceptions.json"));
const REJECTIONS = officeShiftRejectionsSchema.parse(fixture("office-shift-rejections.json"));
const CONFLICTS = officeConflictPageSchema.parse(fixture("office-conflict-page.json"));
const TOKEN = "office-session-token";

/** «Смены» with the shift listed, its card's reads and its review stubbed. */
function cardSession(shift: OfficeShift): FakeOfficeSession {
  const session = shiftsSession([shift, ...[PLANNED, CLOSED].filter((s) => s.id !== shift.id)]);
  session.api.getShift.mockResolvedValue(shift);
  session.api.listShiftBoxes.mockResolvedValue([]);
  session.api.listShiftPallets.mockResolvedValue([]);
  session.api.listShiftExceptions.mockResolvedValue(EXCEPTIONS);
  session.api.listShiftRejections.mockResolvedValue(REJECTIONS);
  session.api.listConflicts.mockResolvedValue(CONFLICTS);
  return session;
}

async function openCard(session: FakeOfficeSession, number: string): Promise<void> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("link", { name: `Карточка смены ${number}` }));
  await screen.findByRole("heading", { name: `Смена ${number}` });
}

/** Opens a section of the drawer by its tab: each reads when it is first opened. */
function openTab(name: string): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

function tabs(): (string | null)[] {
  return screen.getAllByRole("tab").map((tab) => tab.textContent);
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

/** The rows of a section's table, cell texts each, once it has loaded. */
async function rowsOf(name: string): Promise<string[][]> {
  const table = await within(section(name)).findByRole("table");
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent ?? ""),
    );
}

describe("a shift's review on its card (plan КНФ)", () => {
  it("adds «Сканирования», «Исключения», «Отклонённые записи» and «Конфликты» after the boxes, each read when it is opened", async () => {
    const session = cardSession(ACTIVE);
    await openCard(session, ACTIVE.number);
    expect(tabs()).toEqual([
      "Итоги",
      "Короба",
      "Сканирования",
      "Исключения",
      "Отклонённые записи",
      "Конфликты",
      "Выгрузки",
    ]);
    // Nothing of the review is read before its tab is opened.
    expect(session.api.listShiftExceptions).not.toHaveBeenCalled();
    expect(session.api.listShiftRejections).not.toHaveBeenCalled();
    expect(session.api.listConflicts).not.toHaveBeenCalled();
    openTab("Исключения");
    await waitFor(() =>
      expect(session.api.listShiftExceptions).toHaveBeenCalledWith(TOKEN, ACTIVE.id),
    );
    openTab("Отклонённые записи");
    await waitFor(() =>
      expect(session.api.listShiftRejections).toHaveBeenCalledWith(TOKEN, ACTIVE.id),
    );
  });

  it("puts the review after the pallets of a shift with pallets", async () => {
    const withPallets: OfficeShift = {
      ...ACTIVE,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
    };
    await openCard(cardSession(withPallets), ACTIVE.number);
    expect(tabs()).toEqual([
      "Итоги",
      "Короба",
      "Паллеты",
      "Сканирования",
      "Исключения",
      "Отклонённые записи",
      "Конфликты",
      "Выгрузки",
    ]);
  });

  // A validation shift has no boxes and no pallets (plan РЕЖ): nothing of it can be a box or a
  // pallet exception, so that section is not offered; its rejected records and the conflicts of
  // its codes (it owns codes and loses them like any shift) are.
  it("shows a validation shift's rejections and conflicts, and no exceptions", async () => {
    const validation: OfficeShift = { ...ACTIVE, mode: "validation" };
    const session = cardSession(validation);
    await openCard(session, validation.number);
    expect(tabs()).toEqual([
      "Итоги",
      "Сканирования",
      "Отклонённые записи",
      "Конфликты",
      "Выгрузки",
    ]);
    openTab("Отклонённые записи");
    await waitFor(() =>
      expect(session.api.listShiftRejections).toHaveBeenCalledWith(TOKEN, validation.id),
    );
    openTab("Конфликты");
    await waitFor(() =>
      expect(session.api.listConflicts).toHaveBeenCalledWith(TOKEN, {
        shiftId: validation.id,
        page: 1,
      }),
    );
    expect(session.api.listShiftExceptions).not.toHaveBeenCalled();
  });

  it("has no review on a planned shift, which got nothing yet", async () => {
    const planned = cardSession(PLANNED);
    await openCard(planned, PLANNED.number);
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    expect(planned.api.listShiftExceptions).not.toHaveBeenCalled();
    expect(planned.api.listShiftRejections).not.toHaveBeenCalled();
  });

  it("lists the exceptions as the host answers them, in the station's words", async () => {
    await openCard(cardSession(ACTIVE), ACTIVE.number);
    openTab("Исключения");
    expect(await rowsOf("Исключения")).toEqual([
      [
        "08.10.2026, 10:00",
        "РасформированиеДокумент DSG-26-0007",
        "Короб (00)046006820000015001",
        "Повреждена упаковка",
        "Офис",
        "Ирина Смирнова",
      ],
      [
        "08.10.2026, 09:30",
        "Расформирование",
        "Паллета (00)146006820000000409",
        "Другая причина: Паллета упала",
        "Станция А",
        "Анна Кузнецова",
      ],
      [
        "08.10.2026, 09:20",
        "Отмена последнего сканаКод: серийный S000004",
        "Открытый короб",
        "—",
        "Станция А",
        "—",
      ],
    ]);
  });

  it("links an office disassembly to its document (plan ДЗГ-О)", async () => {
    await openCard(cardSession(ACTIVE), ACTIVE.number);
    openTab("Исключения");
    await rowsOf("Исключения");
    const link = within(section("Исключения")).getByRole("link", {
      name: "Документ DSG-26-0007",
    });
    expect(link.getAttribute("href")).toBe("/disaggregation/6a1f3c5e-7b9d-4e2f-8a4c-1d3e5f7a9b0c");
  });

  it("lists the refused records with the refusal in the station's words and its field", async () => {
    await openCard(cardSession(ACTIVE), ACTIVE.number);
    openTab("Отклонённые записи");
    expect(await rowsOf("Отклонённые записи станции")).toEqual([
      ["08.10.2026, 09:41", "Закрытие короба", "Хост не знает этот короб", "Станция А"],
      [
        "08.10.2026, 09:40",
        "Скан",
        "Хост не смог прочитать запись или одно её поле не подходит: ошибка версии станцииПоле: data.boxId",
        "Станция А",
      ],
    ]);
    expect(
      within(section("Отклонённые записи станции")).getByText(/Хост хранит каждый отказ/),
    ).toBeTruthy();
  });

  it("says a list holds the newest 500 of more, and pages them by fifty", async () => {
    const session = cardSession(ACTIVE);
    const first = EXCEPTIONS.items[0];
    if (first === undefined) throw new Error("fixture");
    const many: OfficeShiftException[] = Array.from({ length: 500 }, (_, index) => ({
      ...first,
      id: `e0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    session.api.listShiftExceptions.mockResolvedValue({ items: many, total: 900 });
    await openCard(session, ACTIVE.number);
    openTab("Исключения");
    const exceptions = section("Исключения");
    expect(await within(exceptions).findByText("Показаны последние 500 из 900.")).toBeTruthy();
    expect(await rowsOf("Исключения")).toHaveLength(50);
    const pager = within(exceptions).getByRole("navigation", {
      name: "Страницы раздела «Исключения»",
    });
    expect(within(pager).getByText("Страница 1 из 10")).toBeTruthy();
    fireEvent.click(within(pager).getByRole("button", { name: "Вперёд" }));
    expect(within(pager).getByText("Страница 2 из 10")).toBeTruthy();
  });

  it("shows the conflicts this shift lost, how many are unreviewed and a link to all of them", async () => {
    const session = cardSession(ACTIVE);
    await openCard(session, ACTIVE.number);
    openTab("Конфликты");
    const conflicts = section("Конфликты");
    expect(await within(conflicts).findByText("Не разобрано: 1 из 2")).toBeTruthy();
    expect(session.api.listConflicts).toHaveBeenCalledWith(TOKEN, {
      shiftId: ACTIVE.id,
      page: 1,
    });
    expect(
      within(conflicts).getByRole("link", { name: "Все конфликты смены" }).getAttribute("href"),
    ).toBe(`/conflicts?shift=${ACTIVE.id}&state=all`);
    const rows = await rowsOf("Конфликты");
    expect(rows[0]?.[0]).toBe("GTIN 04600682000013 · серийный S000007");
    expect(rows[0]?.[1]).toMatch(/^Вытеснение: /);
    expect(rows[0]?.[2]).toContain("Смена OCT26-005/S");
    expect(rows[0]?.[2]).toContain("Станция Б");
    expect(rows[1]?.[1]).toMatch(/^Поздний скан: /);
    // The review itself stays on «Конфликты».
    expect(within(conflicts).queryByRole("button")).toBeNull();
    // One page: the unreviewed are counted on it, with no second read.
    expect(session.api.listConflicts).not.toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ reviewed: false }),
    );
  });

  it("counts the unreviewed apart when the shift lost more than one page", async () => {
    const session = cardSession(ACTIVE);
    session.api.listConflicts.mockImplementation(async (_token, query) =>
      query.reviewed === false
        ? { ...CONFLICTS, total: 61 }
        : { ...CONFLICTS, pageCount: 3, total: 120 },
    );
    await openCard(session, ACTIVE.number);
    openTab("Конфликты");
    expect(await within(section("Конфликты")).findByText("Не разобрано: 61 из 120")).toBeTruthy();
    expect(session.api.listConflicts).toHaveBeenCalledWith(TOKEN, {
      shiftId: ACTIVE.id,
      reviewed: false,
      page: 1,
    });
  });

  it("says each section is empty in its own words", async () => {
    const session = cardSession(ACTIVE);
    session.api.listShiftExceptions.mockResolvedValue({ items: [], total: 0 });
    session.api.listShiftRejections.mockResolvedValue({ items: [], total: 0 });
    session.api.listConflicts.mockResolvedValue({ items: [], page: 1, pageCount: 1, total: 0 });
    await openCard(session, ACTIVE.number);
    openTab("Исключения");
    expect(await within(section("Исключения")).findByText("Исключений не было")).toBeTruthy();
    openTab("Отклонённые записи");
    expect(
      await within(section("Отклонённые записи станции")).findByText("Отклонённых записей нет"),
    ).toBeTruthy();
    openTab("Конфликты");
    expect(
      await within(section("Конфликты")).findByText(
        "Конфликтов, где проиграл скан этой смены, нет",
      ),
    ).toBeTruthy();
  });

  it("keeps the other sections when one does not load, and reads that one again", async () => {
    const session = cardSession(ACTIVE);
    session.api.listShiftRejections.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    await openCard(session, ACTIVE.number);
    openTab("Отклонённые записи");
    const rejections = section("Отклонённые записи станции");
    await within(rejections).findByRole("button", { name: "Повторить" });
    expect(within(rejections).getByText(/^Нет связи с хостом/)).toBeTruthy();
    // Only that section says so; the others show their lists when they are opened.
    openTab("Исключения");
    expect(await within(section("Исключения")).findByRole("table")).toBeTruthy();
    expect(within(section("Исключения")).queryByRole("button", { name: "Повторить" })).toBeNull();
    openTab("Конфликты");
    expect(await within(section("Конфликты")).findByRole("table")).toBeTruthy();
    // Back on it the section reads again (the failed read is not kept), and shows its table.
    openTab("Отклонённые записи");
    await waitFor(() => expect(session.api.listShiftRejections).toHaveBeenCalledTimes(2));
    expect(await within(section("Отклонённые записи станции")).findByRole("table")).toBeTruthy();
  });
});
