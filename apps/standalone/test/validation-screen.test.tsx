import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { scanTime } from "../src/floor/work/WorkScreen.js";
import type { CodeCheck } from "../src/host/protocol.js";
import { enteredShift, km, OTHER_GTIN, rows, VALIDATION_ENTERED } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { setUpPrinting } from "./support/printing.js";
import { lastLine, renderWork, type WorkHarness } from "./support/work-screen.js";

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

function panel() {
  return within(screen.getByRole("region", { name: "Проверка" }));
}

/** The figure the panel shows under `term`. */
function figure(term: string): string | null {
  return panel().getByText(term).nextElementSibling?.textContent ?? null;
}

function acceptedLine(): string | null {
  return document.querySelector(".work-validation__count")?.textContent ?? null;
}

/** The panel's last outcomes in words, newest first. */
function recent(): string[] {
  return panel()
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".work-validation__word")?.textContent ?? "");
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

describe("the work screen of a validation shift", () => {
  it("shows the validation panel in place of the box, its pallet, its label and the exceptions", async () => {
    const at = await station();
    const work = renderWork(at);
    await ready(work);
    expect(acceptedLine()).toBe("0 из 1\u00a0200 шт.");
    expect(figure("Повторы")).toBe("0");
    expect(figure("Ошибки")).toBe("0");
    expect(panel().getByText("Сканов после входа в смену ещё не было.")).toBeTruthy();
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
    expect(lastLine()).toBe("Принят: в смене 1 шт.");
    expect(work.props.signal).toHaveBeenLastCalledWith("ok");
    await work.scan(km("A2"));
    expect(acceptedLine()).toBe("2 из 1\u00a0200 шт.");
    await work.scan(km("A1"));
    expect(lastLine()).toMatch(/^Дубль: этот код уже принят в \d\d:\d\d:\d\d\.$/);
    expect(work.props.signal).toHaveBeenLastCalledWith("duplicate");
    await work.scan(km("W1", { gtin: OTHER_GTIN }));
    expect(lastLine()).toBe(`Чужой товар: GTIN ${OTHER_GTIN}.`);
    await work.scan("MRK-000742");
    expect(lastLine()).toBe("Это не код маркировки.");
    expect(work.props.signal).toHaveBeenLastCalledWith("error");
    expect(figure("Повторы")).toBe("1");
    expect(figure("Ошибки")).toBe("2");
    expect(acceptedLine()).toBe("2 из 1\u00a0200 шт.");
    expect(recent()).toEqual([
      "Это не код маркировки.",
      `Чужой товар: GTIN ${OTHER_GTIN}.`,
      expect.stringMatching(/^Дубль: этот код уже принят в /),
      "Принят: в смене 2 шт.",
      "Принят: в смене 1 шт.",
    ]);
    // Each outcome is said in words with its tone, not by colour alone.
    expect(
      panel()
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("data-verdict")),
    ).toEqual(["error", "error", "error", "ok", "ok"]);
    // The codes are the shift's, in no box; nothing else of a box or a label was written.
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes WHERE box_id IS NULL")).toEqual([
      { n: 2 },
    ]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_boxes")).toEqual([{ n: 0 }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs")).toEqual([{ n: 0 }]);
    expect(
      rows(at.db, "SELECT DISTINCT kind FROM outbox ORDER BY kind").map((row) => row["kind"]),
    ).toEqual(["scan"]);
  });

  it("says a host duplicate with the shift that took the code", async () => {
    const at = await station();
    const work = renderWork(at, {
      overrides: { online: true, checkCode: vi.fn(async () => TAKEN) },
    });
    await ready(work);
    await work.scan(km("H1"));
    expect(lastLine()).toBe(
      `Дубль: код принят в смене OCT26-003 в ${scanTime(TAKEN.owner.scannedAt)}.`,
    );
    expect(figure("Повторы")).toBe("1");
    expect(acceptedLine()).toBe("0 из 1\u00a0200 шт.");
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
    expect(lastLine()).toBe("Принят: в смене 1 шт.");
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
    await waitFor(() => expect(acceptedLine()).toBe("1 из 1\u00a0200 шт."));
    expect(figure("Повторы")).toBe("1");
    expect(figure("Ошибки")).toBe("1");
  });

  it("says the accepted codes alone for a shift without a plan", async () => {
    const at = await station(null);
    const work = renderWork(at);
    await ready(work);
    await work.scan(km("N1"));
    expect(acceptedLine()).toBe("1 шт.");
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
});
