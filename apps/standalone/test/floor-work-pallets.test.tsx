import { buildSscc, formatSsccHri } from "@markiro/domain";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PALLET_EXTENSION } from "../src/floor/pallets/pallets.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
import { HostError } from "../src/host/client.js";
import type { SsccBlockRequest } from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import { km, PREFIX, rows, seedBlock } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  closeBoxOnPallet,
  PALLET_BLOCK,
  palletContext,
  palletStation,
  type PalletStation,
} from "./support/pallets.js";
import { printStation, renderedText, setUpPrinting, ZEBRA } from "./support/printing.js";
import { renderWork } from "./support/work-screen.js";

const PALLET_SSCC = buildSscc(PALLET_EXTENSION, PREFIX, 0);
const BOX_SSCC = (serial: number) => buildSscc(0, PREFIX, serial);

function kinds(at: PalletStation): unknown[] {
  return rows(at.db, "SELECT kind FROM outbox WHERE kind <> 'scan' ORDER BY seq").map(
    (row) => row["kind"],
  );
}

/** The pallet's fact: its line in the work screen's numbers. */
function palletLine(): string | null {
  const term = screen.getByText("Паллета", { selector: "dt" });
  return term.nextElementSibling?.textContent ?? null;
}

describe("the work screen of a shift with pallets (plan ПЛ-Ц)", () => {
  it("counts the boxes on the open pallet; the box that fills it closes it, and both labels print, the box's first", async () => {
    const at = await palletStation({ capacity: 2, boxCapacity: 1 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    expect(palletLine()).toBe("0 из 2 коробов");
    await work.scan(km("A1"));
    expect(palletLine()).toBe("1 из 2 коробов");
    await work.scan(km("A2"));
    expect(palletLine()).toBe("0 из 2 коробов");
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed"]);
    expect(work.shell.sends.map((send) => send.text)).toEqual([
      renderedText(ZEBRA, BOX_SSCC(1500)),
      renderedText(ZEBRA, BOX_SSCC(1501)),
      renderedText(ZEBRA, PALLET_SSCC, "100x150"),
    ]);
  });

  it("closes the pallet early after a confirmation, and never an empty one", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    const early = () => screen.getByRole("button", { name: "Закрыть паллету досрочно" });
    expect(early()).toHaveProperty("disabled", true);
    await work.scan(km("A1"));
    await work.scan(km("A2"));
    expect(early()).toHaveProperty("disabled", false);
    await work.press("Закрыть паллету досрочно");
    expect(screen.getByText("Закрыть паллету досрочно? На паллете 2 из 40 коробов.")).toBeTruthy();
    await work.press("Не закрывать");
    expect(kinds(at)).not.toContain("pallet_closed");
    await work.press("Закрыть паллету досрочно");
    await work.press("Закрыть паллету");
    expect(kinds(at).at(-1)).toBe("pallet_closed");
    expect(work.shell.sends.at(-1)?.text).toBe(renderedText(ZEBRA, PALLET_SSCC, "100x150"));
    expect(palletLine()).toBe("0 из 40 коробов");
    expect(early()).toHaveProperty("disabled", true);
  });

  it("says a full pallet waits for pallet serials, takes the next boxes on it, and closes it once the link brings a block", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1, palletBlock: false });
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => ({
      id:
        request.extension === PALLET_EXTENSION
          ? "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d"
          : "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: request.extension === PALLET_EXTENSION ? 0 : 1500,
      toSerial: request.extension === PALLET_EXTENSION ? 199 : 3499,
    }));
    const work = renderWork(at, { overrides: { requestBlock } });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(screen.getByText("Паллета заполнена, но не закрыта")).toBeTruthy();
    await work.scan(km("A2"));
    expect(palletLine()).toBe("2 из 1 коробов");
    expect(kinds(at)).toEqual(["box_closed", "box_closed"]);
    work.rerender({ online: true });
    await work.settled();
    await work.settled();
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed"]);
    expect(screen.queryByText("Паллета заполнена, но не закрыта")).toBeNull();
    expect(palletLine()).toBe("0 из 1 коробов");
    expect(requestBlock).toHaveBeenCalledWith(
      expect.objectContaining({ extension: PALLET_EXTENSION }),
    );
  });

  it("checks the box's label first and then the pallet's, each by its own SSCC, in the pallet's words", async () => {
    const at = await palletStation({
      capacity: 1,
      boxCapacity: 1,
      settings: { verifyPrintedLabel: true },
    });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(screen.getByText("Отсканируйте SSCC на этикетке короба.")).toBeTruthy();
    // The pallet's SSCC is no answer to the box's check.
    await work.scan(`(00)${PALLET_SSCC}`);
    expect(screen.getByText(/Это этикетка другого короба/)).toBeTruthy();
    await work.scan(`(00)${BOX_SSCC(1500)}`);
    expect(screen.getByText("Отсканируйте SSCC на этикетке паллеты.")).toBeTruthy();
    expect(screen.getByText(/SSCC паллеты:/)).toBeTruthy();
    await work.scan(`(00)${PALLET_SSCC}`);
    expect(screen.queryByText("Отсканируйте SSCC на этикетке паллеты.")).toBeNull();
    expect(kinds(at)).toEqual(["box_closed", "pallet_closed", "box_label", "pallet_label"]);
  });

  it("stops on a pallet's label that did not print, says why in the pallet's words, and goes on without it", async () => {
    const at = await palletStation({
      capacity: 1,
      boxCapacity: 1,
      settings: { assignments: { box: "zebra", pallet: null, duplicate: null } },
    });
    const work = renderWork(at, { shell: fakeHardware() });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(screen.getByText("Этикетка паллеты не напечатана")).toBeTruthy();
    expect(
      screen.getByText("Принтер для паллет не назначен. Назначьте его в настройке рабочего места."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Закрыть паллету досрочно" })).toHaveProperty(
      "disabled",
      true,
    );
    await work.press("Продолжить без этикетки");
    expect(screen.getByText(/Паллета уже закрыта/)).toBeTruthy();
    await work.press("Продолжить без этикетки");
    expect(kinds(at)).toEqual(["box_closed", "pallet_closed", "pallet_label"]);
    await work.scan(km("A2"));
    expect(kinds(at).at(-1)).toBe("pallet_closed");
  });
});

/** The executor with one kind of write failing as the test says. */
function failing(local: LocalExecutor, fails: (sql: string) => LocalDbError | null): LocalExecutor {
  return {
    query: (sql, params, row) => local.query(sql, params, row),
    transaction: async (statements) => {
      for (const statement of statements) {
        const error = fails(statement.sql);
        if (error !== null) throw error;
      }
      return local.transaction(statements);
    },
  };
}

/** A closed pallet of a former pairing that holds the SSCC of pallet `serial`. */
function holdSscc(at: PalletStation, serial: number) {
  at.db
    .prepare(
      "INSERT INTO floor_pallets (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
        "block_id, serial, closed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      `former-${serial}`,
      "former-host",
      "former-device",
      "former-shift",
      "2026-10-01T05:00:00.000Z",
      "2026-10-01T06:00:00.000Z",
      buildSscc(PALLET_EXTENSION, PREFIX, serial),
      "former-block",
      serial,
      "former-operator",
    );
}

function palletCursor(at: PalletStation): unknown {
  return rows(at.db, "SELECT next_serial FROM floor_sscc_blocks WHERE extension = 1").map(
    (row) => row["next_serial"],
  );
}

function count(at: PalletStation, table: string, where = "1 = 1"): unknown {
  return rows(at.db, `SELECT count(*) AS n FROM ${table} WHERE ${where}`)[0]?.["n"];
}

describe("the work screen of a shift with pallets: what the plan leaves to its guards", () => {
  it("stops a shift that works with pallets but has none: nothing is taken, nothing is closed, boxes alone are never worked", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    // A full open box a stop of the station left: it must not close without its pallet.
    await processScan(palletContext(at), km("A1"));
    const broken = { ...at.shift, copy: { ...at.shift.copy, palletBoxCapacity: null } };
    const work = renderWork({ local: at.local, shift: broken });
    await work.scanner.listening();
    await work.settled();
    expect(screen.getByText("Паллеты смены не настроены на этой станции")).toBeTruthy();
    expect(count(at, "floor_boxes", "closed_at IS NOT NULL")).toBe(0);
    await work.scan(km("A2"));
    expect(count(at, "floor_codes")).toBe(1);
    expect(kinds(at)).toEqual([]);
    expect(screen.queryByText("Паллета", { selector: "dt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Закрыть паллету досрочно" })).toBeNull();
  });

  it("goes on with the label that cannot move on, never sending it round in a loop", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    let stale = 0;
    // The send of the box's label finds the job moved on, three times in all.
    const local = failing(at.local, (sql) => {
      if (!sql.startsWith("UPDATE floor_print_jobs SET state = 'sending'")) return null;
      stale += 1;
      return stale <= 3 ? new LocalDbError("changes_mismatch", "the job moved") : null;
    });
    const work = renderWork({ local, shift: at.shift });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(stale).toBe(1);
    expect(work.shell.sends).toEqual([]);
    expect(screen.getByText("Этикетка отправляется на принтер")).toBeTruthy();
  });

  it("loses the pallet serials that cannot label a pallet in a few tries and closes the pallet on the next, without stopping the line", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    holdSscc(at, 0);
    holdSscc(at, 1);
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(kinds(at)).toEqual(["box_closed", "pallet_closed"]);
    expect(palletCursor(at)).toEqual([3]);
    expect(work.shell.sends.at(-1)?.text).toBe(
      renderedText(ZEBRA, buildSscc(PALLET_EXTENSION, PREFIX, 2), "100x150"),
    );
    expect(screen.queryByText("Паллета заполнена, но не закрыта")).toBeNull();
    expect(palletLine()).toBe("0 из 1 коробов");
  });

  it("stops losing serials after three tries: the pallet waits in words and closes with the next box", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    for (const serial of [0, 1, 2]) holdSscc(at, serial);
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(kinds(at)).toEqual(["box_closed"]);
    expect(palletCursor(at)).toEqual([3]);
    expect(screen.getByText("Паллета заполнена, но не закрыта")).toBeTruthy();
    expect(screen.getByText(/Номер SSCC паллеты не подошёл и пропущен/)).toBeTruthy();
    expect(screen.queryByText(/Нет номеров SSCC паллет: паллета закроется/)).toBeNull();
    await work.scan(km("A2"));
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed"]);
    expect(screen.queryByText("Паллета заполнена, но не закрыта")).toBeNull();
  });

  it("closes a pallet that a stopped station left full as soon as the screen opens with pallet serials", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1, palletBlock: false });
    await closeBoxOnPallet(at, ["A1"]);
    seedBlock(at.db, { blockId: PALLET_BLOCK, from: 0, to: 199, extension: 1 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    expect(kinds(at)).toEqual(["box_closed", "pallet_closed"]);
    expect(work.shell.sends.at(-1)?.text).toBe(renderedText(ZEBRA, PALLET_SSCC, "100x150"));
    expect(palletLine()).toBe("0 из 1 коробов");
  });

  it("closes the waiting pallet early when serials came without the link, and the message goes", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1, palletBlock: false });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(screen.getByText("Паллета заполнена, но не закрыта")).toBeTruthy();
    seedBlock(at.db, { blockId: PALLET_BLOCK, from: 0, to: 199, extension: 1 });
    await work.press("Закрыть паллету досрочно");
    await work.press("Закрыть паллету");
    expect(kinds(at).at(-1)).toBe("pallet_closed");
    expect(screen.queryByText("Паллета заполнена, но не закрыта")).toBeNull();
    expect(palletLine()).toBe("0 из 1 коробов");
  });

  it("stops the early close that finds no serial offline, tries again on «Повторить», and closes once the link brings a block", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, palletBlock: false });
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => ({
      id: PALLET_BLOCK,
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: 0,
      toSerial: 199,
    }));
    const work = renderWork(at, { overrides: { requestBlock } });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.press("Закрыть паллету досрочно");
    await work.press("Закрыть паллету");
    expect(screen.getByText("Нет номеров SSCC паллет: паллета не закрыта")).toBeTruthy();
    expect(
      screen.getByText(
        "Номера выдаёт хост, а связи с ним нет. Паллета закроется, как только номера придут.",
      ),
    ).toBeTruthy();
    expect(kinds(at)).not.toContain("pallet_closed");
    // The line does not take a code while the pallet's close waits.
    await work.scan(km("A2"));
    expect(count(at, "floor_codes")).toBe(1);
    await work.press("Повторить");
    expect(screen.getByText("Нет номеров SSCC паллет: паллета не закрыта")).toBeTruthy();
    work.rerender({ online: true });
    await work.settled();
    await work.settled();
    expect(kinds(at).at(-1)).toBe("pallet_closed");
    expect(screen.queryByText("Нет номеров SSCC паллет: паллета не закрыта")).toBeNull();
    expect(requestBlock).toHaveBeenCalledWith(
      expect.objectContaining({ extension: PALLET_EXTENSION }),
    );
  });

  it("says the pallet serials ran out when the host has none left", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, palletBlock: false });
    const requestBlock = vi.fn(async (_request: SsccBlockRequest) => {
      throw new HostError({ kind: "api", code: "sscc_exhausted", status: 409, message: "none" });
    });
    const work = renderWork(at, { overrides: { requestBlock, online: true } });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.press("Закрыть паллету досрочно");
    await work.press("Закрыть паллету");
    expect(
      screen.getByText(
        "Номера SSCC паллет префикса организации закончились. Обратитесь к администратору.",
      ),
    ).toBeTruthy();
    expect(kinds(at)).not.toContain("pallet_closed");
  });

  it("says the early close did not take when its serial is lost, and takes the next on «Повторить»", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    holdSscc(at, 0);
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.press("Закрыть паллету досрочно");
    await work.press("Закрыть паллету");
    expect(screen.getByText("Паллета не закрыта")).toBeTruthy();
    expect(kinds(at)).not.toContain("pallet_closed");
    expect(palletCursor(at)).toEqual([1]);
    await work.press("Повторить");
    expect(kinds(at).at(-1)).toBe("pallet_closed");
    expect(screen.queryByText("Паллета не закрыта")).toBeNull();
    expect(work.shell.sends.at(-1)?.text).toBe(
      renderedText(ZEBRA, buildSscc(PALLET_EXTENSION, PREFIX, 1), "100x150"),
    );
  });

  it("starts no early close once the floor has begun to leave", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.press("Закрыть паллету досрочно");
    work.rerender({ isLeaving: () => true });
    await work.press("Закрыть паллету");
    expect(kinds(at)).not.toContain("pallet_closed");
  });

  it("puts the focus on the safe answer of the confirmation, and back on the pallet's button when it is declined", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.press("Закрыть паллету досрочно");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Не закрывать" }));
    await work.press("Не закрывать");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Закрыть паллету досрочно" }),
    );
  });

  it("maps a failed pallet write in the box's close to a close that did not take: the box stays open, and the retry closes it", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    let palletWriteFails = true;
    const local = failing(at.local, (sql) =>
      palletWriteFails && sql.startsWith("INSERT INTO floor_pallets")
        ? new LocalDbError("statement_failed", "UNIQUE constraint failed: floor_pallets.id")
        : null,
    );
    const work = renderWork({ local, shift: at.shift });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(screen.getByText("Короб не закрыт")).toBeTruthy();
    expect(screen.getByText(/Закрытие короба не записалось/)).toBeTruthy();
    expect(count(at, "floor_boxes", "closed_at IS NOT NULL")).toBe(0);
    expect(kinds(at)).toEqual([]);
    palletWriteFails = false;
    await work.press("Повторить");
    expect(kinds(at)).toEqual(["box_closed"]);
    expect(palletLine()).toBe("1 из 40 коробов");
  });

  it("renders a pallet's label again from the pallet layout, and keeps the exceptions away while it waits", async () => {
    const at = await palletStation({
      capacity: 1,
      boxCapacity: 1,
      settings: { assignments: { box: "zebra", pallet: null, duplicate: null } },
    });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(screen.getByText("Этикетка паллеты не напечатана")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Исключения" })).toHaveProperty("disabled", true);
    await setUpPrinting(at.local, {
      assignments: { box: "zebra", pallet: "zebra", duplicate: null },
    });
    await work.press("Напечатать снова");
    expect(work.shell.sends.at(-1)?.text).toBe(renderedText(ZEBRA, PALLET_SSCC, "100x150"));
    expect(screen.queryByText("Этикетка паллеты не напечатана")).toBeNull();
  });

  it("refuses another pallet's SSCC and a code that is no SSCC in the pallet's words, and asks the reprint's reason about the pallet", async () => {
    const at = await palletStation({
      capacity: 1,
      boxCapacity: 1,
      settings: { verifyPrintedLabel: true },
    });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.scan(`(00)${BOX_SSCC(1500)}`);
    await work.scan(`(00)${BOX_SSCC(1500)}`);
    expect(
      screen.getByText(`Это этикетка другой паллеты или короба: ${formatSsccHri(BOX_SSCC(1500))}.`),
    ).toBeTruthy();
    await work.scan(km("P12"));
    expect(screen.getByText("Это не код SSCC. Отсканируйте этикетку паллеты.")).toBeTruthy();
    await work.press("Напечатать снова");
    expect(
      screen.getByText(
        "Если этикетка уже вышла, новая будет с тем же номером SSCC: на паллете должна остаться одна.",
      ),
    ).toBeTruthy();
  });

  it("sends the pallet's label once the box's is skipped, and closes a pallet that waited for the serials that came meanwhile", async () => {
    const at = await palletStation({
      capacity: 1,
      boxCapacity: 1,
      settings: { assignments: { box: null, pallet: "zebra", duplicate: null } },
    });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    // The box has no printer: its label waits, and the pallet's is written behind it.
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(work.shell.sends).toEqual([]);
    await work.press("Продолжить без этикетки");
    await work.press("Продолжить без этикетки");
    expect(work.shell.sends.map((send) => send.text)).toEqual([
      renderedText(ZEBRA, PALLET_SSCC, "100x150"),
    ]);
    expect(kinds(at)).toEqual(["box_closed", "pallet_closed", "box_label"]);
  });

  it("closes the pallet that waited for serials once the box's label is skipped and the serials are here", async () => {
    const at = await palletStation({
      capacity: 1,
      boxCapacity: 1,
      palletBlock: false,
      settings: { assignments: { box: null, pallet: "zebra", duplicate: null } },
    });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    seedBlock(at.db, { blockId: PALLET_BLOCK, from: 0, to: 199, extension: 1 });
    await work.press("Продолжить без этикетки");
    await work.press("Продолжить без этикетки");
    expect(kinds(at)).toEqual(["box_closed", "box_label", "pallet_closed"]);
    expect(work.shell.sends.at(-1)?.text).toBe(renderedText(ZEBRA, PALLET_SSCC, "100x150"));
  });

  it("closes the pallet that waited for serials once the box's label is verified and the serials are here", async () => {
    const at = await palletStation({
      capacity: 1,
      boxCapacity: 1,
      palletBlock: false,
      settings: { verifyPrintedLabel: true },
    });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(screen.getByText("Отсканируйте SSCC на этикетке короба.")).toBeTruthy();
    seedBlock(at.db, { blockId: PALLET_BLOCK, from: 0, to: 199, extension: 1 });
    await work.scan(`(00)${BOX_SSCC(1500)}`);
    expect(kinds(at)).toEqual(["box_closed", "box_label", "pallet_closed"]);
    expect(screen.getByText("Отсканируйте SSCC на этикетке паллеты.")).toBeTruthy();
  });

  it("asks the host for pallet serials by the half rule after a box closes, and for no pallet serials in a shift without pallets", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, palletBlock: false });
    const requestBlock = vi.fn(async (_request: SsccBlockRequest) => {
      throw new HostError({ kind: "transport", code: "unreachable", message: "down" });
    });
    const work = renderWork(at, { overrides: { requestBlock, online: true } });
    await work.scanner.listening();
    await work.settled();
    const asked = () =>
      requestBlock.mock.calls.filter(([request]) => request.extension === PALLET_EXTENSION).length;
    const onEntry = asked();
    expect(onEntry).toBe(1);
    await work.scan(km("A1"));
    expect(asked()).toBe(onEntry + 1);
  });

  it("asks for no pallet serials in a shift without pallets, on entry or after a box", async () => {
    const at = await printStation();
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => ({
      id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1b",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: 5000,
      toSerial: 6999,
    }));
    const work = renderWork(at, { overrides: { requestBlock, online: true } });
    await work.scanner.listening();
    await work.settled();
    for (const serial of ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "B1", "B2", "B3"]) {
      await work.scan(km(serial));
    }
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE closed_at IS NOT NULL"),
    ).toEqual([{ n: 1 }]);
    expect(
      requestBlock.mock.calls.filter(([request]) => request.extension === PALLET_EXTENSION),
    ).toEqual([]);
    expect(screen.queryByText("Паллета", { selector: "dt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Закрыть паллету досрочно" })).toBeNull();
  });

  it("says no pallet serials will come while the link is held off for the rest of the shift", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, palletBlock: false });
    const work = renderWork(at, { overrides: { linkHeld: true } });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.press("Закрыть паллету досрочно");
    await work.press("Закрыть паллету");
    expect(screen.getByText(/Связь с хостом остановлена до выхода из смены/)).toBeTruthy();
    expect(screen.getByText(/номера паллет не придут/)).toBeTruthy();
  });
});
