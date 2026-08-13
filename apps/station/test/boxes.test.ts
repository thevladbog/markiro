import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { recordScan, type AcceptedCode, type ScanEventRow } from "../src/lib/journal.js";
import {
  boxOrdinal,
  clearBox,
  closeBox,
  currentBox,
  disassembleBox,
  listClosedBoxes,
  markPrintSkipped,
  markPrintVerified,
  openBox,
} from "../src/lib/boxes.js";
import { makeExec } from "./support/sqlite-exec.js";

/** One scan event, distinguished by `id` only in its raw payload. */
function event(id: string, shiftId = "s1"): ScanEventRow {
  return {
    shiftId,
    terminalId: "dev-1",
    raw: `RAW-${id}`,
    verdict: "ok",
    scannedAt: "2026-07-29T10:00:00.000Z",
    operatorId: null,
  };
}

/** One accepted code, named into `boxId` (or null for none). */
function code(id: string, boxId: string | null, shiftId = "s1"): AcceptedCode {
  return {
    codeHash: `hash-${id}`,
    shiftId,
    gtin14: "04600000000015",
    serial: id,
    scannedAt: "2026-07-29T10:00:00.000Z",
    boxId,
  };
}

describe("boxes", () => {
  let exec: SqlExecutor;
  beforeEach(async () => {
    exec = makeExec(new DatabaseSync(":memory:"));
    await applyMigrations(exec);
  });

  it("has no current box before one opens", async () => {
    expect(await currentBox(exec, "s1")).toBeNull();
  });

  it("counts the codes that name the open box", async () => {
    await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z", "dev-1");
    await recordScan(exec, event("a"), code("aa", "b1"));
    await recordScan(exec, event("b"), code("bb", "b1"));
    expect((await currentBox(exec, "s1"))?.itemCount).toBe(2);
  });

  it("stops being current once closed", async () => {
    await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z", "dev-1");
    await closeBox(exec, "b1", "004601234560000017", "2026-07-29T10:05:00.000Z", null);
    expect(await currentBox(exec, "s1")).toBeNull();
  });

  it("keeps a closed box's item count", async () => {
    await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z", "dev-1");
    await recordScan(exec, event("a"), code("aa", "b1"));
    await closeBox(exec, "b1", "004601234560000017", "2026-07-29T10:05:00.000Z", null);
    const rows = await exec.all<{ sscc: string }>(
      `SELECT sscc FROM boxes_mirror WHERE box_id = ?`,
      ["b1"],
    );
    expect(rows[0]!.sscc).toBe("004601234560000017");
  });

  it("keeps boxes of different shifts apart", async () => {
    await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z", "dev-1");
    expect(await currentBox(exec, "s2")).toBeNull();
  });

  it("derives a stable box ordinal within one shift and terminal", async () => {
    await openBox(exec, "s1", "box-1", "2026-07-29T10:00:00.000Z", "t1");
    await openBox(exec, "s1", "box-2", "2026-07-29T10:00:00.000Z", "t1");
    await openBox(exec, "s1", "other-terminal-box", "2026-07-29T09:00:00.000Z", "t2");

    expect(await boxOrdinal(exec, "s1", "t1", "box-1")).toBe(1);
    expect(await boxOrdinal(exec, "s1", "t1", "box-2")).toBe(2);
    expect(await boxOrdinal(exec, "s1", "t2", "other-terminal-box")).toBe(1);
  });

  it("keeps the persisted terminal identity on the current box", async () => {
    await openBox(exec, "s1", "box-1", "2026-07-29T10:00:00.000Z", "old-terminal");

    expect((await currentBox(exec, "s1"))?.terminalId).toBe("old-terminal");
  });

  it("orders nullable legacy boxes and never returns ordinal zero for an identity mismatch", async () => {
    await openBox(exec, "s1", "legacy-1", "2026-07-29T10:00:00.000Z", null);
    await openBox(exec, "s1", "legacy-2", "2026-07-29T10:01:00.000Z", null);

    expect(await boxOrdinal(exec, "s1", null, "legacy-2")).toBe(2);
    expect(await boxOrdinal(exec, "s1", "re-enrolled-terminal", "legacy-2")).toBe(1);
  });

  // Self-review: currentBox's itemCount must be scoped by box, not shift --
  // a mutation that correlated the COUNT(*) subquery by shift_id instead of
  // box_id would double-count a code scanned into an earlier (or otherwise
  // unrelated) box in the SAME shift. This code names a box that isn't even
  // the one currently open ("b0" was never opened at all), so it must never
  // show up in b1's count.
  it("excludes codes that name a different box in the same shift from the count", async () => {
    await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z", "dev-1");
    await recordScan(exec, event("a"), code("aa", "b1"));
    await recordScan(exec, event("z"), code("zz", "b0"));
    expect((await currentBox(exec, "s1"))?.itemCount).toBe(1);
  });

  // Self-review: pins the "other shifts" half of the same requirement --
  // a code scanned into a box opened under a DIFFERENT shift must not
  // inflate this shift's current box count either.
  it("excludes codes that name a box opened under a different shift from the count", async () => {
    await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z", "dev-1");
    await recordScan(exec, event("a"), code("aa", "b1"));
    await openBox(exec, "s2", "b2", "2026-07-29T10:00:00.000Z", "dev-1");
    await recordScan(exec, event("z", "s2"), code("zz", "b2", "s2"));
    expect((await currentBox(exec, "s1"))?.itemCount).toBe(1);
  });

  describe("markPrintVerified / markPrintSkipped", () => {
    it("records that a closed box's label was verified", async () => {
      await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z", "dev-1");
      await closeBox(exec, "b1", "004601234560000017", "2026-07-29T10:05:00.000Z", null);

      await markPrintVerified(exec, "b1", "2026-07-29T10:06:00.000Z");

      const rows = await exec.all<{
        print_verified_at: string | null;
        print_skipped_at: string | null;
      }>(`SELECT print_verified_at, print_skipped_at FROM boxes_mirror WHERE box_id = ?`, ["b1"]);
      expect(rows[0]).toEqual({
        print_verified_at: "2026-07-29T10:06:00.000Z",
        print_skipped_at: null,
      });
    });

    it("records that the operator skipped verifying a closed box's label", async () => {
      await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z", "dev-1");
      await closeBox(exec, "b1", "004601234560000017", "2026-07-29T10:05:00.000Z", null);

      await markPrintSkipped(exec, "b1", "2026-07-29T10:06:00.000Z");

      const rows = await exec.all<{
        print_verified_at: string | null;
        print_skipped_at: string | null;
      }>(`SELECT print_verified_at, print_skipped_at FROM boxes_mirror WHERE box_id = ?`, ["b1"]);
      expect(rows[0]).toEqual({
        print_verified_at: null,
        print_skipped_at: "2026-07-29T10:06:00.000Z",
      });
    });

    // Task 13 review, Finding 1: the sync engine's box-closure query
    // (`sync.ts`'s `readClosedUnackedBoxes`) is gated on `acked_at IS NULL`,
    // and `ackBoxes` sets it on every successful drain -- typically within
    // seconds of the box closing, well before the operator resolves this
    // prompt. Without clearing it back here, the outcome just recorded would
    // have no way off the device. `closed_at`/`sscc` -- everything else
    // already acked about this box -- must stay exactly as they were; only
    // `acked_at` un-gates the resend.
    it("clears acked_at so a later drain resends this box, without disturbing closed_at or sscc", async () => {
      await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z", "dev-1");
      await closeBox(exec, "b1", "004601234560000017", "2026-07-29T10:05:00.000Z", null);
      await exec.run(`UPDATE boxes_mirror SET acked_at = ? WHERE box_id = ?`, [
        "2026-07-29T10:05:30.000Z",
        "b1",
      ]);

      await markPrintVerified(exec, "b1", "2026-07-29T10:06:00.000Z");

      const rows = await exec.all<{
        acked_at: string | null;
        closed_at: string | null;
        sscc: string | null;
      }>(`SELECT acked_at, closed_at, sscc FROM boxes_mirror WHERE box_id = ?`, ["b1"]);
      expect(rows[0]).toEqual({
        acked_at: null,
        closed_at: "2026-07-29T10:05:00.000Z",
        sscc: "004601234560000017",
      });
    });

    // The skip counterpart of the test above.
    it("clears acked_at on a skip too", async () => {
      await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z", "dev-1");
      await closeBox(exec, "b1", "004601234560000017", "2026-07-29T10:05:00.000Z", null);
      await exec.run(`UPDATE boxes_mirror SET acked_at = ? WHERE box_id = ?`, [
        "2026-07-29T10:05:30.000Z",
        "b1",
      ]);

      await markPrintSkipped(exec, "b1", "2026-07-29T10:06:00.000Z");

      const rows = await exec.all<{ acked_at: string | null }>(
        `SELECT acked_at FROM boxes_mirror WHERE box_id = ?`,
        ["b1"],
      );
      expect(rows[0]!.acked_at).toBeNull();
    });

    // Self-review: a mutation swapping which box id `markPrintVerified` names
    // (e.g. naming the current box instead of the closed one) would pass
    // both tests above, since each only ever has one box. This pins that a
    // SECOND, still-open box is left untouched.
    it("touches only the named box, not another open one", async () => {
      await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z", "dev-1");
      await closeBox(exec, "b1", "004601234560000017", "2026-07-29T10:05:00.000Z", null);
      await openBox(exec, "s1", "b2", "2026-07-29T10:10:00.000Z", "dev-1");

      await markPrintVerified(exec, "b1", "2026-07-29T10:06:00.000Z");

      const rows = await exec.all<{ print_verified_at: string | null }>(
        `SELECT print_verified_at FROM boxes_mirror WHERE box_id = ?`,
        ["b2"],
      );
      expect(rows[0]!.print_verified_at).toBeNull();
    });
  });

  describe("clearBox", () => {
    it("frees every code in the box and leaves it open", async () => {
      await openBox(exec, "s1", "b1", "t0", null);
      await exec.run(
        "INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at, box_id) VALUES (?,?,?,?,?,?)",
        ["h1", "s1", "04006381333931", "1", "t1", "b1"],
      );
      await clearBox(exec, {
        boxId: "b1",
        shiftId: "s1",
        terminalId: null,
        operatorId: null,
        at: "t2",
      });

      const codes = await exec.all("SELECT * FROM codes_mirror WHERE box_id = ?", ["b1"]);
      expect(codes).toHaveLength(0);
      const box = await currentBox(exec, "s1");
      expect(box?.boxId).toBe("b1");
      expect(box?.itemCount).toBe(0);
      const pending = await exec.all<{ reason: string | null }>(
        "SELECT * FROM box_exceptions_mirror WHERE kind = 'clear'",
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]!.reason).toBeNull();
    });
  });

  describe("disassembleBox", () => {
    it("marks a closed box disassembled and drops it from listClosedBoxes", async () => {
      await openBox(exec, "s1", "b1", "t0", null);
      await exec.run(
        "INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at, box_id) VALUES (?,?,?,?,?,?)",
        ["h1", "s1", "04006381333931", "1", "t1", "b1"],
      );
      await closeBox(exec, "b1", "123456789012345675", "t2", null);

      await disassembleBox(exec, {
        boxId: "b1",
        shiftId: "s1",
        terminalId: null,
        operatorId: null,
        reason: "wrong customer",
        at: "t3",
      });

      const listed = await listClosedBoxes(exec, "s1", null);
      expect(listed).toHaveLength(0);
      const codes = await exec.all("SELECT * FROM codes_mirror WHERE box_id = ?", ["b1"]);
      expect(codes).toHaveLength(0);
      const pending = await exec.all<{ reason: string | null }>(
        "SELECT * FROM box_exceptions_mirror WHERE kind = 'disassemble'",
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]!.reason).toBe("wrong customer");
    });
  });

  describe("listClosedBoxes", () => {
    it("lists closed, not-yet-disassembled boxes for this shift and terminal, newest first", async () => {
      await openBox(exec, "s1", "b1", "t0", "term-1");
      await closeBox(exec, "b1", "123456789012345675", "t1", null);
      await openBox(exec, "s1", "b2", "t2", "term-1");
      await closeBox(exec, "b2", "123456789012345682", "t3", null);

      const listed = await listClosedBoxes(exec, "s1", "term-1");
      expect(listed.map((b) => b.boxId)).toEqual(["b2", "b1"]);
    });

    // Task 11 review, Finding: the ordering test above only exercises boxes
    // opened at a real terminal, so the terminal_id IS NULL branch (a device
    // that never enrolled with a terminal) is only ever proven negatively
    // elsewhere. This pins the positive case: a box opened and closed with
    // terminalId: null must still be returned when the caller asks with
    // terminalId: null.
    it("lists a closed box opened with no terminal when queried with terminalId null", async () => {
      await openBox(exec, "s1", "b1", "t0", null);
      await closeBox(exec, "b1", "123456789012345675", "t1", null);

      const listed = await listClosedBoxes(exec, "s1", null);
      expect(listed.map((b) => b.boxId)).toEqual(["b1"]);
    });

    // Task 11 review, Finding: both boxes in the ordering test above have
    // zero scanned items, so itemCount's COUNT(*) subquery is never actually
    // exercised against real codes_mirror rows. This proves the count is
    // correct for a box that held real scans before it closed.
    it("computes itemCount from the codes actually scanned into the box before it closed", async () => {
      await openBox(exec, "s1", "b1", "t0", "term-1");
      await recordScan(exec, event("a"), code("aa", "b1"));
      await recordScan(exec, event("b"), code("bb", "b1"));
      await recordScan(exec, event("c"), code("cc", "b1"));
      await closeBox(exec, "b1", "123456789012345675", "t1", null);

      const listed = await listClosedBoxes(exec, "s1", "term-1");
      expect(listed).toHaveLength(1);
      expect(listed[0]!.itemCount).toBe(3);
    });
  });
});
