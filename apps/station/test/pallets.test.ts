import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { BoxPrintErrorCode } from "../src/lib/boxes.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  closePallet,
  currentPallet,
  listPalletBoxes,
  disassemblePallet,
  findUnresolvedPalletPrint,
  joinPallet,
  markPalletPrintFailed,
  markPalletPrinted,
  openPallet,
  reprintPallet,
} from "../src/lib/pallets.js";
import { makeExec, openFileDatabase } from "./support/sqlite-exec.js";

/** Deterministic ISO timestamp, offset by whole seconds from a fixed instant. */
function iso(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 6, 29, 10, 0, offsetSeconds)).toISOString();
}

describe("pallets", () => {
  let exec: SqlExecutor;

  /** A closed, SSCC-assigned box -- the only shape `joinPallet` is ever called with. */
  async function insertClosedBox(boxId: string): Promise<void> {
    await exec.run(
      `INSERT INTO boxes_mirror (box_id, shift_id, terminal_id, opened_at, closed_at, sscc)
       VALUES (?,?,?,?,?,?)`,
      [boxId, "s1", "t1", iso(0), iso(0), "004601234560000017"],
    );
  }

  beforeEach(async () => {
    exec = makeExec(new DatabaseSync(":memory:"));
    await applyMigrations(exec);
  });

  it("lists only this terminal's pallet contents, excluding disassembled boxes, newest first", async () => {
    const palletId = await openPallet(exec, "s1", "t1", iso(0));
    for (const id of ["b1", "b2", "removed"]) {
      await insertClosedBox(id);
      await joinPallet(exec, id, palletId);
    }
    await exec.run("UPDATE boxes_mirror SET closed_at=? WHERE box_id='b2'", [iso(2)]);
    await exec.run("UPDATE boxes_mirror SET disassembled_at=? WHERE box_id='removed'", [iso(3)]);
    expect(await listPalletBoxes(exec, "s1", "t1", palletId)).toEqual([
      { boxId: "b2", sscc: "004601234560000017", closedAt: iso(2) },
      { boxId: "b1", sscc: "004601234560000017", closedAt: iso(0) },
    ]);
    expect(await listPalletBoxes(exec, "s1", "t2", palletId)).toEqual([]);
    expect(await listPalletBoxes(exec, "s2", "t1", palletId)).toEqual([]);
    expect(await currentPallet(exec, "s1", "t1")).toMatchObject({
      boxCount: 2,
      lastBoxSscc: "004601234560000017",
    });
  });

  it("has no current pallet before one opens", async () => {
    expect(await currentPallet(exec, "s1", "t1")).toBeNull();
  });

  it("opens one pallet per shift and reuses it", async () => {
    const a = await openPallet(exec, "s1", "t1", iso(0));
    expect(await currentPallet(exec, "s1", "t1")).toMatchObject({ palletId: a, boxCount: 0 });
    expect((await currentPallet(exec, "s1", "t1"))!.palletId).toBe(a);
  });

  it("keeps the persisted shift and terminal identity on the current pallet", async () => {
    const a = await openPallet(exec, "s1", "t1", iso(0));
    expect(await currentPallet(exec, "s1", "t1")).toMatchObject({
      palletId: a,
      shiftId: "s1",
      terminalId: "t1",
      openedAt: iso(0),
    });
  });

  it("keeps pallets of different shifts apart", async () => {
    await openPallet(exec, "s1", "t1", iso(0));
    expect(await currentPallet(exec, "s2", "t1")).toBeNull();
  });

  it("keeps pallets of different terminals in the same shift apart", async () => {
    const a = await openPallet(exec, "s1", "t1", iso(0));
    expect(await currentPallet(exec, "s1", "t2")).toBeNull();
    expect((await currentPallet(exec, "s1", "t1"))!.palletId).toBe(a);
  });

  it("counts only boxes that joined it", async () => {
    const p = await openPallet(exec, "s1", "t1", iso(0));
    await insertClosedBox("b1");
    await joinPallet(exec, "b1", p);
    await insertClosedBox("b2");
    expect((await currentPallet(exec, "s1", "t1"))!.boxCount).toBe(1);
  });

  it("does not count a disassembled box", async () => {
    const p = await openPallet(exec, "s1", "t1", iso(0));
    await insertClosedBox("b1");
    await joinPallet(exec, "b1", p);
    await exec.run("UPDATE boxes_mirror SET disassembled_at = ? WHERE box_id = 'b1'", [iso(1)]);
    expect((await currentPallet(exec, "s1", "t1"))!.boxCount).toBe(0);
  });

  it("stops being current once closed", async () => {
    const p = await openPallet(exec, "s1", "t1", iso(0));
    await closePallet(exec, p, "103460068200000004", iso(1), "op1");
    expect(await currentPallet(exec, "s1", "t1")).toBeNull();
  });

  it("closes a pallet into pending print state in the same write that records its SSCC", async () => {
    const p = await openPallet(exec, "s1", "t1", iso(0));

    await closePallet(exec, p, "103460068200000004", iso(1), "op1");

    expect(
      await exec.all(
        `SELECT sscc, closed_at, closed_by, print_state, print_error_code
           FROM pallets_mirror WHERE pallet_id = ?`,
        [p],
      ),
    ).toEqual([
      {
        sscc: "103460068200000004",
        closed_at: iso(1),
        closed_by: "op1",
        print_state: "pending",
        print_error_code: null,
      },
    ]);
  });

  it("does not let a double close overwrite an already-assigned SSCC", async () => {
    const p = await openPallet(exec, "s1", "t1", iso(0));
    expect(await closePallet(exec, p, "103460068200000004", iso(1), "op1")).toBe(true);

    expect(await closePallet(exec, p, "103460068200000011", iso(2), "op2")).toBe(false);

    const rows = await exec.all<{ sscc: string; closed_at: string; closed_by: string | null }>(
      "SELECT sscc, closed_at, closed_by FROM pallets_mirror WHERE pallet_id = ?",
      [p],
    );
    expect(rows[0]).toEqual({
      sscc: "103460068200000004",
      closed_at: iso(1),
      closed_by: "op1",
    });
  });

  it("marks a closed pallet printed and clears its error", async () => {
    const p = await openPallet(exec, "s1", "t1", iso(0));
    await closePallet(exec, p, "103460068200000004", iso(1), "op1");
    await markPalletPrintFailed(exec, p, "transport_failed");

    await markPalletPrinted(exec, p);

    const rows = await exec.all(
      "SELECT print_state, print_error_code FROM pallets_mirror WHERE pallet_id = ?",
      [p],
    );
    expect(rows).toEqual([{ print_state: "printed", print_error_code: null }]);
  });

  describe("markPalletPrintFailed", () => {
    const errorCodes = [
      "template_missing",
      "printer_unconfigured",
      "render_failed",
      "transport_failed",
    ] as const satisfies readonly BoxPrintErrorCode[];
    type MissingErrorCode = Exclude<BoxPrintErrorCode, (typeof errorCodes)[number]>;
    const allErrorCodesCovered: MissingErrorCode extends never ? true : never = true;
    void allErrorCodesCovered;

    it.each(errorCodes)("persists the sanitized %s failure", async (code) => {
      const p = await openPallet(exec, "s1", "t1", iso(0));
      await closePallet(exec, p, "103460068200000004", iso(1), "op1");

      await markPalletPrintFailed(exec, p, code);

      const rows = await exec.all<{ print_state: string; print_error_code: string | null }>(
        "SELECT print_state, print_error_code FROM pallets_mirror WHERE pallet_id = ?",
        [p],
      );
      expect(rows).toEqual([{ print_state: "pending", print_error_code: code }]);
    });

    // Review finding 4: `code` must be the shared `BoxPrintErrorCode` union,
    // not a bare `string`. Without that narrowing this call would typecheck
    // and the `@ts-expect-error` below would go unused, which itself is a
    // typecheck failure -- so this test fails without the fix.
    it("rejects an unknown print error code at the type level", () => {
      const call = () =>
        // @ts-expect-error markPalletPrintFailed only accepts a known BoxPrintErrorCode, not an arbitrary string
        markPalletPrintFailed(exec, "p1", "not_a_real_code");
      void call;
    });
  });

  it("queues a disassembly with its reason", async () => {
    const p = await openPallet(exec, "s1", "t1", iso(0));
    await closePallet(exec, p, "103460068200000004", iso(1), "op1");
    await disassemblePallet(exec, {
      palletId: p,
      shiftId: "s1",
      terminalId: "t1",
      operatorId: "op1",
      reason: "повреждён поддон",
      occurredAt: iso(2),
    });
    const rows = await exec.all("SELECT * FROM pallet_exceptions_mirror");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "disassemble", reason: "повреждён поддон" });
    const [pallet] = await exec.all<{ disassembled_at: string | null }>(
      "SELECT disassembled_at FROM pallets_mirror WHERE pallet_id = ?",
      [p],
    );
    expect(pallet!.disassembled_at).not.toBeNull();
  });

  // Review finding 1: before the fix, `disassemblePallet` applied this
  // update itself as a second, non-atomic statement. This test bypasses
  // `disassemblePallet` entirely -- a raw INSERT into
  // `pallet_exceptions_mirror` -- to prove the local side effect now comes
  // from the `pallet_exception_disassemble_local` trigger alone, landing in
  // the same statement as the fact. It would fail without that migration.
  it("marks the pallet disassembled from the exception insert alone", async () => {
    const p = await openPallet(exec, "s1", "t1", iso(0));
    await closePallet(exec, p, "103460068200000004", iso(1), "op1");

    await exec.run(
      `INSERT INTO pallet_exceptions_mirror
         (kind, pallet_id, shift_id, terminal_id, operator_id, reason, occurred_at)
       VALUES ('disassemble', ?, 's1', 't1', 'op1', 'повреждён поддон', ?)`,
      [p, iso(2)],
    );

    const [pallet] = await exec.all<{ disassembled_at: string | null }>(
      "SELECT disassembled_at FROM pallets_mirror WHERE pallet_id = ?",
      [p],
    );
    expect(pallet!.disassembled_at).toBe(iso(2));
  });

  it("queues a reprint with its reason and does not disassemble the pallet", async () => {
    const p = await openPallet(exec, "s1", "t1", iso(0));
    await closePallet(exec, p, "103460068200000004", iso(1), "op1");
    await reprintPallet(exec, {
      palletId: p,
      shiftId: "s1",
      terminalId: "t1",
      operatorId: "op1",
      reason: "этикетка испорчена",
      occurredAt: iso(2),
    });
    const rows = await exec.all("SELECT * FROM pallet_exceptions_mirror");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "reprint", reason: "этикетка испорчена" });
    const [pallet] = await exec.all<{ disassembled_at: string | null }>(
      "SELECT disassembled_at FROM pallets_mirror WHERE pallet_id = ?",
      [p],
    );
    expect(pallet!.disassembled_at).toBeNull();
  });

  describe("findUnresolvedPalletPrint", () => {
    it("restores the oldest unresolved pending print for this shift", async () => {
      const newer = await openPallet(exec, "s1", "t1", iso(1));
      await closePallet(exec, newer, "103460068200000011", iso(6), "op1");
      const older = await openPallet(exec, "s1", "t1", iso(0));
      await insertClosedBox("b1");
      await joinPallet(exec, "b1", older);
      await closePallet(exec, older, "103460068200000004", iso(5), "op1");
      await markPalletPrintFailed(exec, older, "printer_unconfigured");

      expect(await findUnresolvedPalletPrint(exec, "s1", "t1")).toEqual({
        palletId: older,
        sscc: "103460068200000004",
        boxCount: 1,
        closedAt: iso(5),
        state: "pending",
        errorCode: "printer_unconfigured",
      });
    });

    it("returns null once the pallet's label is printed", async () => {
      const p = await openPallet(exec, "s1", "t1", iso(0));
      await closePallet(exec, p, "103460068200000004", iso(1), "op1");
      await markPalletPrinted(exec, p);

      expect(await findUnresolvedPalletPrint(exec, "s1", "t1")).toBeNull();
    });

    it("does not restore print recovery for a disassembled pallet", async () => {
      const p = await openPallet(exec, "s1", "t1", iso(0));
      await closePallet(exec, p, "103460068200000004", iso(1), "op1");
      await disassemblePallet(exec, {
        palletId: p,
        shiftId: "s1",
        terminalId: "t1",
        operatorId: "op1",
        reason: "повреждён поддон",
        occurredAt: iso(2),
      });

      expect(await findUnresolvedPalletPrint(exec, "s1", "t1")).toBeNull();
    });

    // Review finding 2: the 06d spec has two terminals in one shift each
    // building their own pallet. Without scoping on `terminal_id`, terminal
    // t2's operator would be prompted to print terminal t1's pending label.
    it("does not surface another terminal's unresolved print", async () => {
      const p = await openPallet(exec, "s1", "t1", iso(0));
      await closePallet(exec, p, "103460068200000004", iso(1), "op1");

      expect(await findUnresolvedPalletPrint(exec, "s1", "t2")).toBeNull();
      expect((await findUnresolvedPalletPrint(exec, "s1", "t1"))?.palletId).toBe(p);
    });
  });

  it("survives a restart with an open pallet", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "markiro-pallets-"));
    const databasePath = join(fixtureDir, "station.sqlite");
    try {
      let p: string;
      const firstDb = openFileDatabase(databasePath);
      try {
        const firstExec = makeExec(firstDb);
        await applyMigrations(firstExec);
        p = await openPallet(firstExec, "s1", "t1", iso(0));
      } finally {
        firstDb.close();
      }

      const reopenedDb = openFileDatabase(databasePath);
      try {
        const reopenedExec = makeExec(reopenedDb);
        await applyMigrations(reopenedExec);
        expect((await currentPallet(reopenedExec, "s1", "t1"))!.palletId).toBe(p);
      } finally {
        reopenedDb.close();
      }
    } finally {
      rmSync(fixtureDir, { force: true, recursive: true });
    }
  });
});
