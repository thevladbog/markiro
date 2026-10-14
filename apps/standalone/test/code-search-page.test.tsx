import { readFileSync } from "node:fs";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalizeKm, kmHash } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { OfficeCodeCard, OfficeCodePage } from "../src/host/code-search.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { freezeToday, pickDate } from "./support/shifts.js";

const testModuleUrl = import.meta.url;
function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8")) as T;
}

const PAGE = fixture<OfficeCodePage>("office-code-page.json");
const CARD = fixture<OfficeCodeCard>("office-code-card.json");
const GS = "\u001d";
const KM = `010460068200001321S000002${GS}93Tail`;

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
    const value = session(TECHNOLOGIST);
    await openSearch(value);
    expect(screen.getByText("Введите код, GTIN, SSCC или номер смены")).toBeTruthy();
  });

  it("asks the host nothing until a criterion is given, and says what to give", async () => {
    const value = session();
    await openSearch(value);
    expect(screen.getByText(/история облака при переносе не переносится/)).toBeTruthy();
    expect(value.api.searchCodes).not.toHaveBeenCalled();
    expect(value.api.getCodeCard).not.toHaveBeenCalled();
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
    expect(value.api.searchCodes).not.toHaveBeenCalled();
    // The code goes to the host as its hash only.
    expect(JSON.stringify(value.api.getCodeCard.mock.calls)).not.toContain("S000002");
    // The scan that owns it now is in a closed box.
    expect(screen.queryByText("Свободен: ни в одном коробе")).toBeNull();
    expect(screen.getAllByText("В коробе").length).toBeGreaterThan(0);
    const link = screen.getAllByRole("link", { name: "OCT26-003" })[0];
    expect(link?.getAttribute("href")).toBe("/shifts/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
    const history = screen.getByRole("heading", { name: "История" }).parentElement;
    if (history === null) throw new Error("no history");
    const items = within(history)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toHaveLength(6);
    expect(items[0]).toContain("Скан: чужой товар");
    expect(items[2]).toContain("повтор, код уже в коробе по данным хоста");
    expect(items[3]).toContain("Изъят: отмена последнего скана");
    expect(items[4]).toContain("Забран из короба");
    expect(items[5]).toContain(
      "Перепечатка на складе: напечатана и проверена, причина — Повреждена",
    );
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
    search("молоко");
    await screen.findByText(/Это не код маркировки, не GTIN, не SSCC и не номер смены/);
    expect(value.api.searchCodes).not.toHaveBeenCalled();
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
    expect(value.api.searchCodes).toHaveBeenCalledWith("office-session-token", {
      fromMs: Date.parse("2026-10-07T21:00:00.000Z"),
    });
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

  it("pages through the host's pages and says when it counted no further", async () => {
    const value = session();
    value.api.searchCodes.mockResolvedValue({
      ...PAGE,
      pageCount: 200,
      total: 10_000,
      capped: true,
    });
    await openSearch(value);
    search("04600682000013");
    const summary = await screen.findByText(/Найдено больше/);
    expect(summary.textContent).toBe(
      "Найдено больше 10\u00a0000 — показаны первые 10\u00a0000. Уточните поиск.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Вперёд" }));
    await waitFor(() =>
      expect(value.api.searchCodes).toHaveBeenLastCalledWith("office-session-token", {
        gtin: "04600682000013",
        page: 2,
      }),
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
    search("04600682000013");
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    await screen.findByText("Найдено: 2");
  });
});
