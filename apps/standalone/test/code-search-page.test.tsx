import { readFileSync } from "node:fs";

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalizeKm, kmHash } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { OfficeShift } from "../src/host/protocol.js";
import type { OfficeCodeCard, OfficeCodePage } from "../src/host/code-search.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { chooseText } from "./support/select.js";
import { freezeToday, pickDate } from "./support/shifts.js";

const testModuleUrl = import.meta.url;
function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8")) as T;
}

const PAGE = fixture<OfficeCodePage>("office-code-page.json");
const CARD = fixture<OfficeCodeCard>("office-code-card.json");
const VALIDATION_CARD = fixture<OfficeCodeCard>("office-code-card-validation.json");
const GS = "\u001d";
const KM = `010460068200001321S000002${GS}93Tail`;

const ACTIVE_SHIFT = {
  id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  number: "OCT26-004",
  status: "active",
} as unknown as OfficeShift;

function session(user = fakeOfficeSession().user): FakeOfficeSession {
  const value = fakeOfficeSession({ user });
  value.api.getOrg.mockResolvedValue(ORG_PROFILE);
  return value;
}

async function openSearch(value: FakeOfficeSession) {
  renderOffice(value);
  fireEvent.click(await screen.findByRole("link", { name: "Поиск кодов" }));
  await screen.findByRole("heading", { name: "Поиск кодов", level: 1 });
}

function search(text: string) {
  fireEvent.change(screen.getByLabelText("Код, GTIN, SSCC или номер смены"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Найти" }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("«Поиск кодов» in the office", () => {
  it("is in the production part of both roles' menus, after the administrator's «Устройства»", async () => {
    renderOffice(session());
    await screen.findByRole("link", { name: "Поиск кодов" });
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links[links.indexOf("Устройства") + 1]).toBe("Поиск кодов");
  });

  it("is open to a technologist", async () => {
    freezeToday();
    const value = session(TECHNOLOGIST);
    value.api.searchCodes.mockResolvedValue(PAGE);
    await openSearch(value);
    await screen.findByText("Найдено: 2");
  });

  it("opens on the last seven days of the organization's zone, newest first, and says so", async () => {
    freezeToday();
    const value = session();
    value.api.searchCodes.mockResolvedValue(PAGE);
    value.api.listShifts.mockResolvedValue([
      { ...ACTIVE_SHIFT, status: "closed", number: "OCT26-001" },
      ACTIVE_SHIFT,
    ]);
    await openSearch(value);
    await screen.findByText("Найдено: 2");
    expect(screen.getByText(/история облака при переносе не переносится/)).toBeTruthy();
    // 2026-10-03 … 2026-10-09 in the site's zone (UTC+3), the later midnight excluded.
    expect(value.api.searchCodes).toHaveBeenCalledWith("office-session-token", {
      fromMs: Date.parse("2026-10-02T21:00:00.000Z"),
      toMs: Date.parse("2026-10-09T21:00:00.000Z"),
    });
    expect(value.api.getCodeCard).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "7 дней" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Сегодня" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    const note = await screen.findByTestId("code-period-note");
    await waitFor(() => expect(note.textContent).toContain("Активная смена: OCT26-004"));
    expect(note.textContent).toContain("Период: 03.10.2026 — 09.10.2026");
    expect(note.textContent).toContain("По умолчанию показаны последние 7 дней");
    expect(note.textContent).toContain("Сегодня: 09.10.2026");
  });

  it("switches the period with the quick chips: today, 30 days, all the time, 7 days again", async () => {
    freezeToday();
    const value = session();
    value.api.searchCodes.mockResolvedValue(PAGE);
    await openSearch(value);
    await screen.findByText("Найдено: 2");
    const lastCall = () => value.api.searchCodes.mock.calls.at(-1)?.[1];
    fireEvent.click(screen.getByRole("radio", { name: "Сегодня" }));
    await waitFor(() =>
      expect(lastCall()).toEqual({
        fromMs: Date.parse("2026-10-08T21:00:00.000Z"),
        toMs: Date.parse("2026-10-09T21:00:00.000Z"),
      }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "30 дней" }));
    await waitFor(() =>
      expect(lastCall()).toEqual({
        fromMs: Date.parse("2026-09-09T21:00:00.000Z"),
        toMs: Date.parse("2026-10-09T21:00:00.000Z"),
      }),
    );
    expect(screen.getByRole("radio", { name: "30 дней" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Всё время" }));
    await waitFor(() => expect(lastCall()).toEqual({ fromMs: 0 }));
    expect(screen.getByTestId("code-period-note").textContent).toContain("Период: всё время");
    fireEvent.click(screen.getByRole("radio", { name: "7 дней" }));
    await waitFor(() =>
      expect(lastCall()).toEqual({
        fromMs: Date.parse("2026-10-02T21:00:00.000Z"),
        toMs: Date.parse("2026-10-09T21:00:00.000Z"),
      }),
    );
  });

  it("says which period found nothing, and offers all the time", async () => {
    freezeToday();
    const value = session();
    value.api.searchCodes.mockResolvedValue({ ...PAGE, items: [], total: 0 });
    await openSearch(value);
    await screen.findByText("Ничего не найдено");
    expect(
      screen.getByText(/За период 03\.10\.2026 — 09\.10\.2026 ничего не нашлось/),
    ).toBeTruthy();
  });

  it("does not narrow an explicit search to the default days", async () => {
    freezeToday();
    const value = session();
    value.api.searchCodes.mockResolvedValue(PAGE);
    await openSearch(value);
    await screen.findByText("Найдено: 2");
    fireEvent.change(screen.getByLabelText("Код, GTIN, SSCC или номер смены"), {
      target: { value: "(00)046006820000015000" },
    });
    // Typing a criterion over the untouched default days leaves the pickers empty.
    expect(screen.getByRole("radio", { name: "Всё время" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    await waitFor(() =>
      expect(value.api.searchCodes).toHaveBeenLastCalledWith("office-session-token", {
        sscc: "046006820000015000",
      }),
    );
  });

  it("opens a scanned code's card by its hash: its full text, where it is, every box and its history", async () => {
    const value = session();
    value.api.getCodeCard.mockResolvedValue(CARD);
    await openSearch(value);
    search(KM);
    await screen.findByText("010460068200001321S000002<GS>93Tail");
    expect(value.api.getCodeCard).toHaveBeenCalledWith(
      "office-session-token",
      kmHash(canonicalizeKm(KM)),
    );
    // Only the default period was searched; a code is asked for by its card.
    expect(
      value.api.searchCodes.mock.calls.every(([, query]) => query.codeHash === undefined),
    ).toBe(true);
    // The code goes to the host as its hash only.
    expect(JSON.stringify(value.api.getCodeCard.mock.calls)).not.toContain("S000002");
    // The scan that owns it now is in a closed box.
    expect(screen.queryByText("Свободен: ни в одном коробе")).toBeNull();
    expect(screen.getAllByText("В коробе").length).toBeGreaterThan(0);
    const link = screen.getAllByRole("link", { name: "OCT26-003" })[0];
    expect(link?.getAttribute("href")).toBe("/shifts?shift=1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
    const history = screen.getByRole("heading", { name: "История" }).parentElement;
    if (history === null) throw new Error("no history");
    const items = within(history)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toHaveLength(7);
    expect(items[0]).toContain("Скан: чужой товар");
    // Neither text says where the earlier scan put the code: the event does not carry it.
    expect(items[2]).toContain("Скан: повтор, код уже принят по данным хоста");
    expect(items[3]).toContain("Изъят: отмена последнего скана");
    expect(items[4]).toContain("Забран из короба: тот же код раньше принят другим сканом");
    // An office disassembly (plan ДЗГ-О): the document and its user, not a station.
    expect(items[5]).toContain("Изъят: короб расформирован (Повреждена упаковка)");
    expect(items[5]).toContain("документ DSG-26-0007");
    expect(items[5]).toContain("Ирина Смирнова");
    expect(items[6]).toContain(
      "Перепечатка на складе: напечатана и проверена, причина — Повреждена",
    );
  });

  it("says a boxed scan lost its code to an earlier scan without saying that scan was in a box", async () => {
    // The earlier scan may be a validation shift's, which put the code in no box (plan РЕЖ).
    const value = session();
    const [, accepted] = CARD.events;
    if (accepted?.type !== "scan") throw new Error("the fixture's second event is a scan");
    value.api.getCodeCard.mockResolvedValue({
      ...CARD,
      events: [{ ...accepted, placed: false }],
    });
    await openSearch(value);
    search(KM);
    const history = (await screen.findByRole("heading", { name: "История" })).parentElement;
    if (history === null) throw new Error("no history");
    const items = within(history)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toHaveLength(1);
    expect(items[0]).toContain("Скан: принят, но код уже был принят раньше другим сканом");
    expect(items[0]).not.toContain("короб");
  });

  it("shows a validation shift's code without a box (plan РЕЖ): «—» for the box, no open box", async () => {
    const value = session();
    value.api.getCodeCard.mockResolvedValue(VALIDATION_CARD);
    await openSearch(value);
    search(KM);
    await screen.findByText("010460068200001321S000017<GS>93Tail");
    expect(screen.queryByText(/Открыт, без SSCC/)).toBeNull();
    expect(screen.getAllByText("Принят без короба").length).toBeGreaterThan(0);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const boxColumn = within(table)
      .getAllByRole("columnheader")
      .findIndex((cell) => cell.textContent === "Короб");
    for (const row of rows) {
      const boxCell = within(row).getAllByRole("cell")[boxColumn];
      expect(boxCell?.textContent).toBe("—");
      // No box, no card to open (plan КРТ links a box by its id): a link would be dead.
      expect(boxCell?.querySelector("a")).toBeNull();
    }
    // Nor does the «Сейчас» line of the card link to a box that is not there.
    expect(document.querySelector('a[href^="/codes/box/"]')).toBeNull();
    expect(rows[0]?.textContent).toContain("Забран другим сканом");
    expect(rows[1]?.textContent).toContain("Принят без короба");
    const history = screen.getByRole("heading", { name: "История" }).parentElement;
    if (history === null) throw new Error("no history");
    const items = within(history)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("Скан: принят");
    expect(items[0]).not.toContain("в другом коробе");
    expect(items[2]).toContain("Забран: тот же код раньше принят другим сканом");
    expect(items[2]).not.toContain("короб");
  });

  it("says a code the host never saw is not here, with why", async () => {
    const value = session();
    value.api.getCodeCard.mockRejectedValue(
      new HostError({ kind: "api", code: "not_found", message: "no scan", status: 404 }),
    );
    await openSearch(value);
    search(KM);
    await screen.findByText("Этот код на площадке не сканировали");
    expect(screen.getByText(/Коды из облака сюда не переносятся/)).toBeTruthy();
  });

  it("lists what an SSCC finds and opens a row's code in a drawer", async () => {
    const value = session();
    value.api.searchCodes.mockResolvedValue(PAGE);
    value.api.getCodeCard.mockResolvedValue(CARD);
    await openSearch(value);
    search("(00)046006820000015000");
    await screen.findByText("Найдено: 2");
    expect(value.api.searchCodes).toHaveBeenCalledWith("office-session-token", {
      sscc: "046006820000015000",
    });
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("010460068200001321S000002");
    expect(rows[0]?.textContent).toContain("В коробе");
    expect(rows[0]?.textContent).toContain("(00)146006820000000402");
    expect(rows[1]?.textContent).toContain("Изъят из короба");
    expect(rows[1]?.textContent).toContain("OCT26-003/S");
    fireEvent.click(rows[0] as HTMLElement);
    const drawer = await screen.findByRole("dialog", { name: "Карточка кода" });
    await within(drawer).findByText("010460068200001321S000002<GS>93Tail");
    expect(value.api.getCodeCard).toHaveBeenCalledWith(
      "office-session-token",
      PAGE.items[0]?.codeHash,
    );
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("links the box and the pallet of a code's placements to their cards (plan КРТ)", async () => {
    const value = session();
    value.api.getCodeCard.mockResolvedValue(CARD);
    await openSearch(value);
    search(KM);
    await screen.findByText("010460068200001321S000002<GS>93Tail");
    const placement = CARD.placements[0];
    const boxLink = screen.getAllByRole("link", { name: /^\(00\)046006820000015000/ })[0];
    expect(boxLink?.getAttribute("href")).toBe(`/codes/box/${placement?.boxId ?? ""}`);
    const palletLink = screen.getAllByRole("link", { name: /^\(00\)146006820000000402/ })[0];
    expect(palletLink?.getAttribute("href")).toBe(`/codes/pallet/${placement?.palletId ?? ""}`);
  });

  it("refuses what is no criterion without asking the host", async () => {
    const value = session();
    await openSearch(value);
    await waitFor(() => expect(value.api.searchCodes).toHaveBeenCalledTimes(1));
    search("молоко");
    await screen.findByText(/Это не код маркировки, не GTIN, не SSCC и не номер смены/);
    expect(value.api.searchCodes).toHaveBeenCalledTimes(1);
  });

  it("sends a GTIN with the period's days as the organization's midnights", async () => {
    freezeToday();
    const value = session();
    value.api.searchCodes.mockResolvedValue({ ...PAGE, items: [], total: 0 });
    await openSearch(value);
    pickDate("Сканирован с", "8 октября 2026");
    pickDate("по", "9 октября 2026");
    search("4600682000013");
    await screen.findByText("Ничего не найдено");
    expect(value.api.searchCodes).toHaveBeenCalledWith("office-session-token", {
      gtin: "04600682000013",
      fromMs: Date.parse("2026-10-07T21:00:00.000Z"),
      toMs: Date.parse("2026-10-09T21:00:00.000Z"),
    });
  });

  it("searches a period alone", async () => {
    freezeToday();
    const value = session();
    value.api.searchCodes.mockResolvedValue(PAGE);
    await openSearch(value);
    pickDate("Сканирован с", "8 октября 2026");
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    await screen.findByText("Найдено: 2");
    // The other end stays the default's: today.
    await waitFor(() =>
      expect(value.api.searchCodes).toHaveBeenLastCalledWith("office-session-token", {
        fromMs: Date.parse("2026-10-07T21:00:00.000Z"),
        toMs: Date.parse("2026-10-09T21:00:00.000Z"),
      }),
    );
  });

  it("searches by a shift's number typed in any case", async () => {
    const value = session();
    value.api.searchCodes.mockResolvedValue(PAGE);
    await openSearch(value);
    search("oct26-3");
    await screen.findByText("Найдено: 2");
    expect(value.api.searchCodes).toHaveBeenLastCalledWith("office-session-token", {
      shift: "OCT26-3",
    });
  });

  /** The host's page `page` of 50 placements out of 10 000, as the host answers a capped search. */
  function cappedPages(value: FakeOfficeSession) {
    const [first] = PAGE.items;
    if (first === undefined) throw new Error("the fixture has no placements");
    value.api.searchCodes.mockImplementation(async (_token, query) => {
      const page = query.page ?? 1;
      return {
        items: Array.from({ length: 50 }, (_, index) => ({
          ...first,
          scanId: `d0000000-0000-4000-8000-${String((page - 1) * 50 + index + 1).padStart(12, "0")}`,
        })),
        page,
        pageCount: 200,
        total: 10_000,
        capped: true,
      };
    });
  }

  it("says when it counted no further, and pages by ten out of the host's pages of fifty, asking only for the pages it needs", async () => {
    const value = session();
    cappedPages(value);
    await openSearch(value);
    search("04600682000013");
    const summary = await screen.findByText(/Найдено больше/);
    expect(summary.textContent).toBe(
      "Найдено больше 10\u00a0000 — показаны первые 10\u00a0000. Уточните поиск.",
    );
    const pager = () => screen.getByRole("navigation", { name: "Страницы результатов" });
    expect(await screen.findByText("Показано 1–10 из 10 000")).toBeTruthy();
    expect(within(pager()).getByText("Страница 1 из 1 000")).toBeTruthy();
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(11);
    // The second page of ten is inside the host's first page of fifty.
    const asked = value.api.searchCodes.mock.calls.length;
    fireEvent.click(within(pager()).getByRole("button", { name: "Вперёд" }));
    expect(await screen.findByText("Показано 11–20 из 10 000")).toBeTruthy();
    expect(value.api.searchCodes).toHaveBeenCalledTimes(asked);
    // The last page of ten is the host's last page of fifty.
    fireEvent.click(within(pager()).getByRole("button", { name: "Последняя страница" }));
    expect(await screen.findByText("Показано 9 991–10 000 из 10 000")).toBeTruthy();
    expect(value.api.searchCodes).toHaveBeenLastCalledWith("office-session-token", {
      gtin: "04600682000013",
      page: 200,
    });
  });

  it("takes the page size from the table's own choice: a page of a hundred reads two host pages, and the size stays chosen", async () => {
    const value = session();
    cappedPages(value);
    await openSearch(value);
    search("04600682000013");
    await screen.findByText(/Найдено больше/);
    chooseText("Строк на странице: Найденные коды", "100");
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(101),
    );
    expect(value.api.searchCodes).toHaveBeenCalledWith("office-session-token", {
      gtin: "04600682000013",
      page: 2,
    });
    expect(screen.getByText("Показано 1–100 из 10 000")).toBeTruthy();
    expect(screen.getByText("Страница 1 из 100")).toBeTruthy();
    cleanup();
    await openSearch(value);
    search("04600682000013");
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(101),
    );
  });

  it("explains a failed search and tries again", async () => {
    const value = session();
    value.api.searchCodes
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "x" }),
      )
      .mockResolvedValueOnce(PAGE);
    await openSearch(value);
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    await screen.findByText("Найдено: 2");
  });
});
