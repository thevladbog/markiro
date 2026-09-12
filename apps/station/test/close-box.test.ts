import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSscc, isValidSscc } from "@markiro/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { boxLabelFields } from "../src/lib/box-label.js";
import { currentBox, openBox } from "../src/lib/boxes.js";
import { closeCurrentBox, type CloseBoxDeps } from "../src/lib/close-box.js";
import { recordScan, type AcceptedCode, type ScanEventRow } from "../src/lib/journal.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { addRange, remaining } from "../src/lib/sscc-pool.js";
import { makeExec, makeRotatingExec, openFileDatabase } from "./support/sqlite-exec.js";
import { useTimeZone } from "./support/timezone.js";

// A 9-digit GS1 issuer prefix -- see sscc-pool.ts's doc comment for why the
// pool is keyed by prefix rather than by GLN.
const ISSUER_PREFIX = "460123456";
const SHIFT = "s1";
const ISO = "2026-07-29T10:00:00.000Z";
const GTIN = "04600682000013";
const SSCC = "346006820000000014";

/** One scan event, distinguished by `id` only in its raw payload. */
function event(id: string, shiftId = SHIFT): ScanEventRow {
  return {
    shiftId,
    terminalId: "dev-1",
    raw: `RAW-${id}`,
    verdict: "ok",
    scannedAt: ISO,
    operatorId: null,
  };
}

/** One accepted code, named into `boxId` (or null for none). */
function code(id: string, boxId: string | null, shiftId = SHIFT): AcceptedCode {
  return {
    codeHash: `hash-${id}`,
    shiftId,
    gtin14: GTIN,
    serial: id,
    scannedAt: ISO,
    boxId,
  };
}

describe("closeCurrentBox", () => {
  let exec: SqlExecutor;
  let deps: CloseBoxDeps;

  beforeEach(async () => {
    exec = makeExec(new DatabaseSync(":memory:"));
    await applyMigrations(exec);
    deps = {
      exec,
      issuerPrefix: ISSUER_PREFIX,
      palletBoxCapacity: null,
      terminalId: "dev-1",
      now: () => new Date(ISO).getTime(),
    };
  });

  it("burns a serial and builds a valid SSCC", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 7,
      toSerial: 9,
    });
    await openBox(exec, SHIFT, "b1", ISO, "dev-1");
    await recordScan(exec, event("a"), code("aa", "b1"));

    const res = await closeCurrentBox(deps, SHIFT, "op-1");

    expect(res.status).toBe("closed");
    if (res.status !== "closed") throw new Error("unreachable");
    expect(isValidSscc(res.sscc)).toBe(true);
    expect(res.sscc).toBe(buildSscc(0, ISSUER_PREFIX, 7));
    expect(res.itemCount).toBe(1);

    // The box itself must actually be closed, under the operator who closed
    // it -- not just a serial handed back with the mirror row left open.
    expect(await currentBox(exec, SHIFT)).toBeNull();
    const rows = await exec.all<{
      sscc: string;
      closed_by: string | null;
      closed_at: string;
      print_state: string;
      print_error_code: string | null;
    }>(
      `SELECT sscc, closed_by, closed_at, print_state, print_error_code
         FROM boxes_mirror WHERE box_id = ?`,
      ["b1"],
    );
    expect(rows[0]).toEqual({
      sscc: res.sscc,
      closed_by: "op-1",
      closed_at: ISO,
      print_state: "pending",
      print_error_code: null,
    });
  });

  it("refuses to close when the pool is dry, and burns nothing", async () => {
    await openBox(exec, SHIFT, "b1", ISO, "dev-1");
    await recordScan(exec, event("a"), code("aa", "b1"));

    expect((await closeCurrentBox(deps, SHIFT, null)).status).toBe("no-serials");

    const box = await currentBox(exec, SHIFT);
    expect(box?.sscc).toBeNull();
    expect(box?.closedAt).toBeNull();
  });

  it("refuses to close an empty box, and burns nothing", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 7,
      toSerial: 9,
    });
    await openBox(exec, SHIFT, "b1", ISO, "dev-1");

    expect((await closeCurrentBox(deps, SHIFT, null)).status).toBe("empty");

    expect(await remaining(exec, ISSUER_PREFIX, 0)).toBe(3);
    const box = await currentBox(exec, SHIFT);
    expect(box?.sscc).toBeNull();
  });

  it("refuses to close when no box is open at all, and burns nothing", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 7,
      toSerial: 9,
    });

    expect((await closeCurrentBox(deps, SHIFT, null)).status).toBe("empty");

    expect(await remaining(exec, ISSUER_PREFIX, 0)).toBe(3);
  });

  // CodeRabbit PR33 review, Finding 4: the primary fix stops the server from
  // ever handing out an over-capacity block, but a device that already
  // mirrored a bad range (or one hand-crafted here to simulate exactly that)
  // must still fail SAFELY rather than throw uncaught -- `buildSscc`'s
  // `SSCC_RANGE` for a serial beyond the 9-digit prefix's own capacity
  // (10_000_000) must surface as `invalid-serial`, not an unhandled
  // rejection, and the box must stay open (untouched) so the operator can
  // simply try again.
  it("returns invalid-serial (not a thrown error) when the burned serial cannot build a valid SSCC, leaving the box open", async () => {
    const CAPACITY = 10_000_000;
    // A pool range that reaches one serial past capacity -- burnSerial has
    // no notion of GS1 capacity at all (see its own doc comment), so it
    // happily hands this out.
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: CAPACITY - 1,
      toSerial: CAPACITY,
    });
    await openBox(exec, SHIFT, "b1", ISO, "dev-1");
    await recordScan(exec, event("a"), code("aa", "b1"));

    // First close burns the still-valid CAPACITY - 1 serial.
    const first = await closeCurrentBox(deps, SHIFT, null);
    expect(first.status).toBe("closed");

    // A second box, closed against the SAME (now over-capacity) pool range:
    // the only serial left in it is CAPACITY itself, which buildSscc must
    // reject.
    await openBox(exec, SHIFT, "b2", ISO, "dev-1");
    await recordScan(exec, event("b"), code("bb", "b2"));
    const second = await closeCurrentBox(deps, SHIFT, null);

    expect(second.status).toBe("invalid-serial");
    // The pool is now dry (both serials burned), matching the accepted
    // trade: the serial is gone, not recoverable.
    expect(await remaining(exec, ISSUER_PREFIX, 0)).toBe(0);
    // The box itself was left untouched -- still open, nothing written --
    // so the operator can simply try closing it again.
    const box = await currentBox(exec, SHIFT);
    expect(box?.boxId).toBe("b2");
    expect(box?.sscc).toBeNull();
    expect(box?.closedAt).toBeNull();
  });

  // Task 13 review, finding B4: the 06d ownership model is "One terminal.
  // Two terminals in one shift build two pallets" -- `currentPallet` used to
  // scope only by `shift_id`, so the SECOND terminal to close a box in this
  // shift would find and join the FIRST terminal's already-open pallet
  // instead of opening its own. This fails without the `terminalId` scoping
  // fix: both boxes would land on one shared pallet row.
  it("gives two terminals in the same shift two separate pallets, never one shared", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 1,
      toSerial: 10,
    });
    const dev1: CloseBoxDeps = { ...deps, palletBoxCapacity: 100, terminalId: "dev-1" };
    const dev2: CloseBoxDeps = { ...deps, palletBoxCapacity: 100, terminalId: "dev-2" };

    await openBox(exec, SHIFT, "b1", ISO, "dev-1");
    await recordScan(exec, event("a"), code("aa", "b1"));
    expect((await closeCurrentBox(dev1, SHIFT, "op-1")).status).toBe("closed");

    await openBox(exec, SHIFT, "b2", ISO, "dev-2");
    await recordScan(exec, event("b"), code("bb", "b2"));
    expect((await closeCurrentBox(dev2, SHIFT, "op-2")).status).toBe("closed");

    const pallets = await exec.all<{ pallet_id: string; terminal_id: string | null }>(
      "SELECT pallet_id, terminal_id FROM pallets_mirror ORDER BY terminal_id",
    );
    expect(pallets).toHaveLength(2);
    expect(pallets.map((p) => p.terminal_id)).toEqual(["dev-1", "dev-2"]);

    const palletByTerminal = new Map(pallets.map((p) => [p.terminal_id, p.pallet_id]));
    const boxes = await exec.all<{ box_id: string; pallet_id: string | null }>(
      "SELECT box_id, pallet_id FROM boxes_mirror ORDER BY box_id",
    );
    expect(boxes).toEqual([
      { box_id: "b1", pallet_id: palletByTerminal.get("dev-1") },
      { box_id: "b2", pallet_id: palletByTerminal.get("dev-2") },
    ]);
  });

  // Task 14 review, Finding 1: `closed_at` (closeBox) and `pallet_id`
  // (formerly a separate `joinPallet` call) used to be two statements with
  // an awaited round trip between them -- a window where a drain, or a
  // plain crash, could observe/persist the box as closed with its pallet
  // membership still null, and nothing later ever re-derives it. This test
  // arms a `beforeRun` hook that throws the instant a statement shaped
  // EXACTLY like the old, separate `joinPallet` write
  // (`UPDATE boxes_mirror SET pallet_id = ? ...`, no other column in the
  // same SET list) is about to run -- simulating a crash landing precisely
  // in that old window. Against the fix, `pallet_id` travels in the SAME
  // guarded UPDATE as `closed_at` (`closeBox` itself), so no statement ever
  // matches the trap and the close finishes normally with both columns set.
  // Reverting to two separate statements makes this test fail: the trap
  // fires and `closeCurrentBox` rejects.
  it("writes closed_at and pallet_id in the SAME statement -- no separate joinPallet write exists to crash between", async () => {
    const directory = mkdtempSync(join(tmpdir(), "markiro-close-box-atomic-"));
    const path = join(directory, "station.sqlite");
    const databases = [openFileDatabase(path), openFileDatabase(path)];
    try {
      let armed = false;
      const rotatingExec = makeRotatingExec(databases, {
        beforeRun(sql) {
          if (!armed) return;
          if (/UPDATE boxes_mirror\s+SET pallet_id = \?/.test(sql)) {
            armed = false;
            throw new Error("simulated crash between box close and pallet join");
          }
        },
      });
      await applyMigrations(rotatingExec);
      await addRange(rotatingExec, {
        issuerPrefix: ISSUER_PREFIX,
        extensionDigit: 0,
        fromSerial: 1,
        toSerial: 5,
      });
      await addRange(rotatingExec, {
        issuerPrefix: ISSUER_PREFIX,
        extensionDigit: 1,
        fromSerial: 1,
        toSerial: 5,
      });
      await openBox(rotatingExec, SHIFT, "b1", ISO, "dev-1");
      await recordScan(rotatingExec, event("a"), code("aa", "b1"));

      const palletDeps: CloseBoxDeps = {
        exec: rotatingExec,
        issuerPrefix: ISSUER_PREFIX,
        palletBoxCapacity: 100,
        terminalId: "dev-1",
        now: () => new Date(ISO).getTime(),
      };

      armed = true;
      const res = await closeCurrentBox(palletDeps, SHIFT, "op-1");

      // The trap never fired: no statement matched its shape.
      expect(armed).toBe(true);
      expect(res.status).toBe("closed");

      const row = databases[0]!
        .prepare("SELECT closed_at, pallet_id FROM boxes_mirror WHERE box_id = ?")
        .get("b1") as { closed_at: string | null; pallet_id: string | null };
      expect(row.closed_at).not.toBeNull();
      expect(row.pallet_id).not.toBeNull();
    } finally {
      for (const db of databases) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // Task 14 review, Finding 1's own guard: once `closeBox`'s UPDATE carries
  // `WHERE ... AND closed_at IS NULL`, a genuine double close must be
  // reported, not silently overwritten -- mirroring `closeCurrentPallet`'s
  // own `already-closed` status exactly. Simulates a concurrent winner
  // closing this exact box between this call's `currentBox` read and its
  // own guarded UPDATE.
  it("reports a genuine double close as already-closed, never a fabricated sscc", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 1,
      toSerial: 5,
    });
    await openBox(exec, SHIFT, "b1", ISO, "dev-1");
    await recordScan(exec, event("a"), code("aa", "b1"));

    let intercepted = false;
    const racingExec: SqlExecutor = {
      ...exec,
      // `closeBox`'s guarded write goes through `all` (it uses `RETURNING`
      // to detect whether its own guard matched), not `run` -- intercept
      // the same call the fix itself makes.
      all: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        if (!intercepted && /UPDATE boxes_mirror\s+SET sscc = \?/.test(sql)) {
          intercepted = true;
          // A concurrent winner closes this exact box out from under this
          // call, landing between its `currentBox` read and its own write.
          await exec.run(
            `UPDATE boxes_mirror SET sscc = ?, closed_at = ?, closed_by = ? WHERE box_id = ?`,
            ["999999999999999999", "2026-07-29T10:09:00.000Z", "winner", "b1"],
          );
        }
        return exec.all<T>(sql, params);
      },
    };

    const res = await closeCurrentBox({ ...deps, exec: racingExec }, SHIFT, "op-1");
    expect(res).toEqual({ status: "already-closed" });

    // The winner's row is untouched -- the loser never overwrote it.
    const rows = await exec.all<{ sscc: string; closed_by: string | null }>(
      "SELECT sscc, closed_by FROM boxes_mirror WHERE box_id = ?",
      ["b1"],
    );
    expect(rows[0]).toEqual({ sscc: "999999999999999999", closed_by: "winner" });
  });
});

describe("boxLabelFields", () => {
  it("maps every input to its own labelled slot, leaving product.egais, km.code, and expiry blank and printing the shift number", () => {
    // `date` is the station's LOCAL day, so the zone has to be pinned or this
    // assertion would depend on wherever the runner happens to sit.
    useTimeZone("Europe/Moscow");
    const fields = boxLabelFields({
      sscc: SSCC,
      itemCount: 12,
      productName: "Кола",
      productPrintName: null,
      gtin14: GTIN,
      egaisCode: null,
      shelfLifeDays: null,
      operatorName: "Иванов",
      counterpartyName: "Клиент",
      closedAt: "2026-07-29T10:15:00.000Z",
      productionDate: null,
      shiftNumber: "AUG26-003/S",
    });
    expect(fields).toEqual({
      "product.name": "Кола",
      "product.printName": "Кола",
      "product.gtin": GTIN,
      "product.egais": "",
      "km.code": "",
      sscc: SSCC,
      "shift.no": "AUG26-003/S",
      date: "29.07.2026",
      expiry: "",
      qty: "12",
      // A box holds units, not boxes.
      "qty.boxes": "",
      operator: "Иванов",
      "counterparty.name": "Клиент",
    });
  });

  it("defaults a missing operator, counterparty or shift number to an empty string", () => {
    const fields = boxLabelFields({
      sscc: SSCC,
      itemCount: 1,
      productName: "",
      productPrintName: null,
      gtin14: GTIN,
      egaisCode: null,
      shelfLifeDays: null,
      operatorName: null,
      counterpartyName: null,
      closedAt: ISO,
      productionDate: null,
      shiftNumber: null,
    });
    expect(fields.operator).toBe("");
    expect(fields["counterparty.name"]).toBe("");
    expect(fields["shift.no"]).toBe("");
  });

  it("puts no application identifier in the field record", () => {
    const fields = boxLabelFields({
      sscc: SSCC,
      itemCount: 1,
      productName: "",
      productPrintName: null,
      gtin14: GTIN,
      egaisCode: null,
      shelfLifeDays: null,
      operatorName: null,
      counterpartyName: null,
      closedAt: ISO,
      productionDate: null,
      shiftNumber: null,
    });
    expect(fields.sscc).toHaveLength(18);
    expect(fields.sscc.startsWith("00")).toBe(false);
  });
});
