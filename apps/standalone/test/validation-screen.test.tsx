import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { scanTime } from "../src/floor/work/WorkScreen.js";
import type { CodeCheck } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import {
  enteredShift,
  km,
  OPERATOR_ID,
  OTHER_GTIN,
  PAIRING,
  rows,
  VALIDATION_ENTERED,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { palletStation } from "./support/pallets.js";
import { FIRST_SSCC, jobRows, setUpPrinting } from "./support/printing.js";
import { lastLine, lastWord, renderWork, type WorkHarness } from "./support/work-screen.js";

/*
 * The work screen of a validation shift (plan РЕЖ, A7, Р8–Р10): one screen, the validation
 * panel in place of the box, its pallet and its label; no exceptions; no SSCC asked for; the
 * close counts the shift's codes and no box.
 */

const SUMMARY = "Закрытие смены OCT26-006";
const CLOSED_TITLE = "Смена OCT26-006 закрыта на этой станции";
const TAKEN: CodeCheck = {
  status: "taken",
  owner: {
    shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    shiftNumber: "OCT26-003",
    deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    scannedAt: "2026-10-08T05:58:41.090Z",
    sameDevice: false,
  },
};

async function station(plannedQty: number | null = VALIDATION_ENTERED.plannedQty) {
  const { db, executor } = openLocalDb();
  // A printer is set up, as on a station that also works aggregation shifts: nothing prints here.
  await setUpPrinting(executor);
  const shift = await enteredShift(executor, { ...VALIDATION_ENTERED, plannedQty });
  return { db, local: executor, shift };
}

type Station = Awaited<ReturnType<typeof station>>;

async function ready(work: WorkHarness): Promise<void> {
  await work.scanner.listening();
  await work.settled();
}

function band() {
  const element = document.querySelector<HTMLElement>(".work-shift-band");
  if (element === null) throw new Error("the shift band is not on the screen");
  return within(element);
}

/** The small figure of the band under `term` («Дубли», «Ошибки»). */
function figure(term: string): string | null {
  return band().getByText(term).nextElementSibling?.textContent ?? null;
}

/** The band's one accepted count. */
function acceptedCount(): string | null {
  return document.querySelector(".work-shift-band__count")?.textContent ?? null;
}

/** The history's rows as «время · результат · код», newest first. */
function historyRows(): HTMLElement[] {
  const list = screen.queryByRole("list", { name: "История сканирований" });
  return list === null ? [] : within(list).getAllByRole("listitem");
}

/** The result word of each history row, newest first. */
function recent(): string[] {
  return historyRows().map(
    (item) => item.querySelector(".scan-history__result")?.textContent?.replace(/^\S\s?/, "") ?? "",
  );
}

function closedRecords(at: Station): { data: Record<string, unknown> }[] {
  return rows(at.db, "SELECT payload FROM outbox WHERE kind = 'shift_closed'").map((row) =>
    JSON.parse(String(row["payload"])),
  );
}

function fact(name: string): string | null {
  const term = within(screen.getByRole("region", { name: SUMMARY }))
    .queryAllByText(name)
    .find((element) => element.tagName === "DT");
  return term?.nextElementSibling?.textContent ?? null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the work screen of a validation shift", () => {
  it("shows the last scan and the one history in place of the box, its pallet, its label and the exceptions", async () => {
    const at = await station();
    const work = renderWork(at);
    await ready(work);
    expect(acceptedCount()).toBe("0");
    expect(document.querySelector(".work-shift-band__planned")?.textContent).toBe("/ 1\u00a0200");
    expect(figure("Дубли")).toBe("0");
    expect(figure("Ошибки")).toBe("0");
    expect(screen.getByText("В этой смене сканов ещё не было.")).toBeTruthy();
    expect(lastWord()).toBe("Ожидание");
    expect(lastLine()).toBe("Отсканируйте код маркировки.");
    // No box, no pallet, no label, and no exceptions (Р9).
    expect(screen.queryByText("Открытый короб")).toBeNull();
    expect(screen.queryByRole("button", { name: "Закрыть короб" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Снять последний код" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Очистить короб" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Паллета" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Исключения" })).toBeNull();
    expect(screen.queryByText("Коробов закрыто")).toBeNull();
    // The way out and the close stay, as floor buttons.
    expect(screen.getByRole("button", { name: "Выйти из смены" }).className).toContain(
      "mk-btn--floor",
    );
    expect(screen.getByRole("button", { name: "Закрыть смену" }).className).toContain(
      "mk-btn--floor",
    );
    expect(document.querySelector(".work-footer")?.getAttribute("aria-label")).toBe(
      "Выход из смены, закрытие смены",
    );
  });

  it("says every outcome in words, counts them, and takes the codes without a box", async () => {
    const at = await station();
    // Online: every code of the product is checked with the host, which knows none of them.
    const work = renderWork(at, { overrides: { online: true } });
    await ready(work);
    await work.scan(km("A1"));
    // The status word says it; the shift's count stands in the band alone.
    expect(lastWord()).toBe("Принят");
    expect(lastLine()).toBe("");
    expect(acceptedCount()).toBe("1");
    expect(work.props.signal).toHaveBeenLastCalledWith("ok");
    await work.scan(km("A2"));
    expect(acceptedCount()).toBe("2");
    await work.scan(km("A1"));
    expect(lastWord()).toBe("Дубль");
    expect(lastLine()).toMatch(/^Дубль: этот код уже принят в \d\d:\d\d:\d\d\.$/);
    expect(work.props.signal).toHaveBeenLastCalledWith("duplicate");
    await work.scan(km("W1", { gtin: OTHER_GTIN }));
    expect(lastWord()).toBe("Ошибка");
    expect(lastLine()).toBe(`Чужой товар: GTIN ${OTHER_GTIN}.`);
    await work.scan("MRK-000742");
    expect(lastWord()).toBe("Ошибка");
    expect(lastLine()).toBe("Это не код маркировки.");
    expect(work.props.signal).toHaveBeenLastCalledWith("error");
    expect(figure("Дубли")).toBe("1");
    expect(figure("Ошибки")).toBe("2");
    expect(acceptedCount()).toBe("2");
    // One history, newest first, each result in words with its glyph.
    expect(recent()).toEqual(["Не код", "Другой товар", "Дубль", "Принят", "Принят"]);
    expect(historyRows().map((item) => item.getAttribute("data-verdict"))).toEqual([
      "invalid",
      "wrong_gtin",
      "duplicate",
      "ok",
      "ok",
    ]);
    // The count of accepted codes is in exactly one element of the screen.
    expect(document.querySelectorAll(".work-shift-band__count")).toHaveLength(1);
    expect(screen.queryByText(/Принят: в смене/)).toBeNull();
    expect(screen.queryByText("Последние сканы")).toBeNull();
    await work.scan(km("A3"));
    expect(acceptedCount()).toBe("3");
    expect(historyRows()).toHaveLength(6);
    // The codes are the shift's, in no box; nothing else of a box or a label was written.
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes WHERE box_id IS NULL")).toEqual([
      { n: 3 },
    ]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes")).toEqual([{ n: 0 }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs")).toEqual([{ n: 0 }]);
    expect(
      rows(at.db, "SELECT DISTINCT kind FROM outbox ORDER BY kind").map((row) => row["kind"]),
    ).toEqual(["scan"]);
  });

  it("says the last scan as one large word on its tone, and the count once", async () => {
    const at = await station();
    const work = renderWork(at, { overrides: { online: true } });
    await ready(work);
    const tone = () => document.querySelector(".work-screen__last")?.getAttribute("data-verdict");
    expect(tone()).toBe("neutral");
    await work.scan(km("V1"));
    expect([lastWord(), tone()]).toEqual(["Принят", "ok"]);
    // The code's tail and the scan's time ride with the word; no count is repeated with it.
    expect(document.querySelector(".work-scan-hero__code")?.textContent).toMatch(/…V1$/);
    expect(document.querySelector(".work-scan-result__time")).not.toBeNull();
    expect(document.querySelector(".work-scan-hero__detail")).toBeNull();
    await work.scan(km("V1"));
    expect([lastWord(), tone()]).toEqual(["Дубль", "duplicate"]);
    await work.scan(km("V2", { gtin: OTHER_GTIN }));
    expect([lastWord(), tone()]).toEqual(["Ошибка", "error"]);
    // «Принято» as a word of the screen is the band's label alone, and the count is one element.
    expect(screen.getAllByText(/принято/i)).toHaveLength(1);
    expect(document.querySelectorAll(".work-shift-band__count")).toHaveLength(1);
    expect(screen.getAllByText("1", { selector: ".work-shift-band__count" })).toHaveLength(1);
    // One list of scans, one button for all of them; no second «Последние сканы».
    expect(screen.getAllByRole("list", { name: "История сканирований" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Вся история" })).toHaveLength(1);
    // The footer's actions are the kit's 84 px row.
    for (const name of ["Выйти из смены", "Закрыть смену"]) {
      expect(screen.getByRole("button", { name }).className).toContain("floor-primary");
    }
  });

  it("says a host duplicate with the shift that took the code", async () => {
    const at = await station();
    const work = renderWork(at, {
      overrides: { online: true, checkCode: vi.fn(async () => TAKEN) },
    });
    await ready(work);
    await work.scan(km("H1"));
    expect(lastWord()).toBe("Дубль");
    expect(lastLine()).toBe(
      `Дубль: код принят в смене OCT26-003 в ${scanTime(TAKEN.owner.scannedAt)}.`,
    );
    expect(figure("Дубли")).toBe("1");
    expect(acceptedCount()).toBe("0");
  });

  it("asks the host for no SSCC serials, on entry or when the link comes back", async () => {
    const at = await station();
    const work = renderWork(at);
    await ready(work);
    work.rerender({ online: true });
    await work.settled();
    await work.scan(km("S1"));
    work.rerender({ online: false });
    work.rerender({ online: true });
    await work.settled();
    expect(work.props.requestBlock).not.toHaveBeenCalled();
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_block_requests")).toEqual([{ n: 0 }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_sscc_blocks")).toEqual([{ n: 0 }]);
    expect(lastWord()).toBe("Принят");
  });

  it("reads the shift's counts again when the operator enters it again", async () => {
    const at = await station();
    const first = renderWork(at);
    await ready(first);
    await first.scan(km("R1"));
    await first.scan(km("R1"));
    await first.scan("MRK-000742");
    first.view.unmount();
    const again = renderWork(at);
    await ready(again);
    // The entry's read may land outside the harness's turn: its render is waited for.
    await waitFor(() => expect(acceptedCount()).toBe("1"));
    expect(figure("Дубли")).toBe("1");
    expect(figure("Ошибки")).toBe("1");
    // The last scan starts empty again; the history is the shift's own, so it keeps its three.
    expect(lastWord()).toBe("Ожидание");
    await waitFor(() => expect(historyRows()).toHaveLength(3));
  });

  it("says the accepted count alone for a shift without a plan", async () => {
    const at = await station(null);
    const work = renderWork(at);
    await ready(work);
    await work.scan(km("N1"));
    expect(acceptedCount()).toBe("1");
    expect(document.querySelector(".work-shift-band__planned")).toBeNull();
    expect(document.querySelector(".work-shift-band__bar")).toBeNull();
  });

  it("offers to close the shift once the plan is reached, as the cloud does", async () => {
    const at = await station(2);
    const work = renderWork(at);
    await ready(work);
    await work.scan(km("P1"));
    expect(screen.queryByText("План выполнен: принято 1 из 2.")).toBeNull();
    await work.scan(km("P2"));
    const reached = screen.getByText("План выполнен: принято 2 из 2.").closest(".work-overlay");
    if (!(reached instanceof HTMLElement)) throw new Error("the plan's card is not on the screen");
    expect(within(reached).getByRole("button", { name: "Продолжить" })).toBeTruthy();
    work.pause();
    fireEvent.click(within(reached).getByRole("button", { name: "Закрыть смену" }));
    await work.settled();
    expect(await screen.findByRole("region", { name: SUMMARY })).toBeTruthy();
    expect(screen.queryByText("План выполнен: принято 2 из 2.")).toBeNull();
    expect(fact("Факт")).toBe("2");
    expect(fact("Отклонение")).toBe("0");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(screen.getByText("Принято: 2 шт.")).toBeTruthy();
    expect(closedRecords(at)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          plannedQtySnapshot: 2,
          actualQty: 2,
          closedBoxCount: 0,
          reasonCode: null,
        }),
      }),
    ]);
  });

  it("closes on the shift's codes and no box, with a reason when the plan is not met", async () => {
    const at = await station();
    const work = renderWork(at);
    await ready(work);
    await work.scan(km("C1"));
    await work.scan(km("C2"));
    await work.scan(km("C2"));
    await work.press("Закрыть смену");
    expect(await screen.findByRole("region", { name: SUMMARY })).toBeTruthy();
    // No open box keeps it open, and the summary names no box.
    expect(fact("Факт")).toBe("2");
    expect(fact("План")).toBe("1\u00a0200");
    expect(fact("Коробов закрыто")).toBeNull();
    expect(fact("В среднем в коробе")).toBeNull();
    expect(screen.queryByText("Смену пока не закрыть")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Подтвердить закрытие" }).hasAttribute("disabled"),
    ).toBe(true);
    await work.press("Недостаток сырья");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(screen.getByText("Принято: 2 шт.")).toBeTruthy();
    expect(screen.queryByText(/коробов:/)).toBeNull();
    expect(closedRecords(at)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          plannedQtySnapshot: 1_200,
          actualQty: 2,
          closedBoxCount: 0,
          reasonCode: "material_shortage",
        }),
      }),
    ]);
  });
  it("lists the history in a region the keyboard can scroll, named by its heading", async () => {
    const at = await station();
    const work = renderWork(at);
    await ready(work);
    await work.scan(km("F1"));
    const list = screen.getByRole("list", { name: "История сканирований" });
    expect(list.tabIndex).toBe(0);
    expect(list.classList.contains("scan-history__list")).toBe(true);
    expect(screen.getByRole("button", { name: "Вся история" })).toBeTruthy();
  });

  it("says each scan at the time it was journalled, not when the list drew it", async () => {
    const at = await station();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T06:15:02.000Z"));
    // The station's clock moves on an hour once the scan is written, before the screen speaks.
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: async (statements) => {
        const changed = await at.local.transaction(statements);
        if (statements.some((statement) => statement.sql.startsWith("INSERT INTO floor_scans"))) {
          vi.setSystemTime(Date.now() + 3_600_000);
        }
        return changed;
      },
    };
    const work = renderWork({ ...at, local });
    await ready(work);
    await work.scan(km("T1"));
    await work.scan("MRK-000742");
    const journalled = rows(at.db, "SELECT scanned_at FROM floor_scans ORDER BY scanned_at DESC");
    expect(journalled).toEqual([
      { scanned_at: "2026-10-08T07:15:02.000Z" },
      { scanned_at: "2026-10-08T06:15:02.000Z" },
    ]);
    expect(
      historyRows().map((item) => item.querySelector(".scan-history__time")?.textContent),
    ).toEqual(journalled.map((row) => scanTime(String(row["scanned_at"]))));
    // The hero says the last scan's time as the journal has it.
    expect(document.querySelector(".work-scan-result__time")?.textContent).toBe(
      scanTime("2026-10-08T07:15:02.000Z"),
    );
  });

  it("recovers no label on entry: a send another shift's stop cut stays as it was", async () => {
    const at = await station();
    // A box label of an aggregation shift whose send a stop of the station cut.
    at.db
      .prepare(
        "INSERT INTO floor_print_jobs (id, host_id, device_id, shift_id, purpose, subject_id, " +
          "sscc, state, verify, template_id, template_rev, fields, printer, bytes_base64, " +
          "error_code, attempts, operator_id, created_at, updated_at) VALUES " +
          "('job-1', ?, ?, 'aggregation-shift', 'box', 'box-1', ?, 'sending', 0, 'tpl', 1, " +
          "'{}', '{}', 'AA==', NULL, 1, ?, '2026-10-08T05:00:00.000Z', '2026-10-08T05:00:00.000Z')",
      )
      .run(PAIRING.hostId, PAIRING.deviceId, FIRST_SSCC, OPERATOR_ID);
    const work = renderWork(at);
    await ready(work);
    await work.scan(km("J1"));
    expect(jobRows(at.db)).toEqual([
      expect.objectContaining({ id: "job-1", state: "sending", error_code: null, attempts: 1 }),
    ]);
    expect(screen.queryByText("Неизвестно, напечаталась ли этикетка")).toBeNull();
    expect(work.shell.sends).toEqual([]);
  });

  it("shows no pallet and no stop for missing pallets, whatever its copy says of pallets", async () => {
    // A copy that names pallets (no office makes one so; the screen must not trust it): with
    // a capacity and a layout, and without them.
    const pallets = await palletStation();
    for (const named of [
      {
        palletsEnabled: true,
        palletBoxCapacity: pallets.shift.copy.palletBoxCapacity,
        palletTemplate: pallets.shift.snapshot.palletTemplate,
      },
      { palletsEnabled: true, palletBoxCapacity: null, palletTemplate: null },
    ]) {
      const at = await station();
      const shift = {
        ...at.shift,
        copy: {
          ...at.shift.copy,
          palletsEnabled: named.palletsEnabled,
          palletBoxCapacity: named.palletBoxCapacity,
        },
        snapshot: { ...at.shift.snapshot, palletTemplate: named.palletTemplate },
      };
      const work = renderWork({ ...at, shift });
      await ready(work);
      await work.scan(km("Q1"));
      expect(screen.queryByRole("region", { name: "Паллета" })).toBeNull();
      expect(screen.queryByText("Паллеты смены не настроены на этой станции")).toBeNull();
      expect(lastWord()).toBe("Принят");
      expect(rows(at.db, "SELECT count(*) AS n FROM floor_pallets")).toEqual([{ n: 0 }]);
      work.view.unmount();
    }
  });
});
