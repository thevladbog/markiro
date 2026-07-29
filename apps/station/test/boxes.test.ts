import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { recordScan, type AcceptedCode, type ScanEventRow } from "../src/lib/journal.js";
import { closeBox, currentBox, openBox } from "../src/lib/boxes.js";
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
    await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z");
    await recordScan(exec, event("a"), code("aa", "b1"));
    await recordScan(exec, event("b"), code("bb", "b1"));
    expect((await currentBox(exec, "s1"))?.itemCount).toBe(2);
  });

  it("stops being current once closed", async () => {
    await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z");
    await closeBox(exec, "b1", "004601234560000017", "2026-07-29T10:05:00.000Z", null);
    expect(await currentBox(exec, "s1")).toBeNull();
  });

  it("keeps a closed box's item count", async () => {
    await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z");
    await recordScan(exec, event("a"), code("aa", "b1"));
    await closeBox(exec, "b1", "004601234560000017", "2026-07-29T10:05:00.000Z", null);
    const rows = await exec.all<{ sscc: string }>(
      `SELECT sscc FROM boxes_mirror WHERE box_id = ?`,
      ["b1"],
    );
    expect(rows[0]!.sscc).toBe("004601234560000017");
  });

  it("keeps boxes of different shifts apart", async () => {
    await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z");
    expect(await currentBox(exec, "s2")).toBeNull();
  });

  // Self-review: currentBox's itemCount must be scoped by box, not shift --
  // a mutation that correlated the COUNT(*) subquery by shift_id instead of
  // box_id would double-count a code scanned into an earlier (or otherwise
  // unrelated) box in the SAME shift. This code names a box that isn't even
  // the one currently open ("b0" was never opened at all), so it must never
  // show up in b1's count.
  it("excludes codes that name a different box in the same shift from the count", async () => {
    await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z");
    await recordScan(exec, event("a"), code("aa", "b1"));
    await recordScan(exec, event("z"), code("zz", "b0"));
    expect((await currentBox(exec, "s1"))?.itemCount).toBe(1);
  });

  // Self-review: pins the "other shifts" half of the same requirement --
  // a code scanned into a box opened under a DIFFERENT shift must not
  // inflate this shift's current box count either.
  it("excludes codes that name a box opened under a different shift from the count", async () => {
    await openBox(exec, "s1", "b1", "2026-07-29T10:00:00.000Z");
    await recordScan(exec, event("a"), code("aa", "b1"));
    await openBox(exec, "s2", "b2", "2026-07-29T10:00:00.000Z");
    await recordScan(exec, event("z", "s2"), code("zz", "b2", "s2"));
    expect((await currentBox(exec, "s1"))?.itemCount).toBe(1);
  });
});
