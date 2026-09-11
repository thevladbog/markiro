import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { openBox } from "../src/lib/boxes.js";
import {
  closeCurrentBox,
  type CloseBoxDeps,
  type CloseBoxResultClosed,
} from "../src/lib/close-box.js";
import { closeCurrentPallet, PALLET_EXTENSION_DIGIT } from "../src/lib/close-pallet.js";
import { recordScan, type AcceptedCode, type ScanEventRow } from "../src/lib/journal.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { currentPallet } from "../src/lib/pallets.js";
import { addRange, burnSerial, remaining } from "../src/lib/sscc-pool.js";
import { makeExec } from "./support/sqlite-exec.js";

// A 9-digit GS1 issuer prefix -- see sscc-pool.ts's doc comment for why the
// pool is keyed by prefix rather than by GLN.
const ISSUER_PREFIX = "460123456";
const shiftId = "s1";
const terminalId = "dev-1";
const ISO = "2026-07-29T10:00:00.000Z";
const GTIN = "04600682000013";

/** Extension digit reserved for transport boxes -- mirrors close-box.ts's own private constant. */
const BOX_EXTENSION_DIGIT = 0;

/** One scan event, distinguished by `id` only in its raw payload. */
function event(id: string): ScanEventRow {
  return {
    shiftId,
    terminalId,
    raw: `RAW-${id}`,
    verdict: "ok",
    scannedAt: ISO,
    operatorId: null,
  };
}

/** One accepted code, named into `boxId`. */
function code(id: string, boxId: string | null): AcceptedCode {
  return {
    codeHash: `hash-${id}`,
    shiftId,
    gtin14: GTIN,
    serial: id,
    scannedAt: ISO,
    boxId,
  };
}

describe("closeCurrentPallet", () => {
  let exec: SqlExecutor;
  let deps: CloseBoxDeps;

  beforeEach(async () => {
    exec = makeExec(new DatabaseSync(":memory:"));
    await applyMigrations(exec);
  });

  interface GivenShiftOptions {
    boxCapacity: number;
    palletBoxCapacity?: number;
    palletsEnabled: boolean;
  }

  /**
   * Seeds a generous box-serial pool (never the thing under test here) and,
   * when pallets are enabled, a 200-serial pallet pool -- then builds `deps`
   * so every helper below shares the same shift/terminal configuration.
   */
  async function givenShift(options: GivenShiftOptions): Promise<void> {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: BOX_EXTENSION_DIGIT,
      fromSerial: 1,
      toSerial: 1000,
    });
    if (options.palletsEnabled) {
      await addRange(exec, {
        issuerPrefix: ISSUER_PREFIX,
        extensionDigit: PALLET_EXTENSION_DIGIT,
        fromSerial: 1,
        toSerial: 200,
      });
    }
    deps = {
      exec,
      issuerPrefix: ISSUER_PREFIX,
      palletBoxCapacity: options.palletsEnabled ? (options.palletBoxCapacity ?? null) : null,
      terminalId,
      now: () => new Date(ISO).getTime(),
    };
  }

  /** Opens a fresh box, scans exactly one item into it, and closes it -- the box pool is always generous, so this never returns anything but "closed". */
  async function fillAndCloseBox(boxId: string): Promise<CloseBoxResultClosed> {
    await openBox(exec, shiftId, boxId, ISO, terminalId);
    await recordScan(exec, event(boxId), code(boxId, boxId));
    const result = await closeCurrentBox(deps, shiftId, "op1");
    if (result.status !== "closed") {
      throw new Error(`expected the box to close, got ${result.status}`);
    }
    return result;
  }

  async function remainingSerials(extensionDigit: number): Promise<number> {
    return remaining(exec, ISSUER_PREFIX, extensionDigit);
  }

  /** Burns every serial this prefix/digit still has, one at a time, until the pool reports dry. */
  async function drainPool(extensionDigit: number): Promise<void> {
    while ((await burnSerial(exec, ISSUER_PREFIX, extensionDigit)) !== null) {
      // keep burning until burnSerial itself reports null
    }
  }

  /** Adds `count` fresh serials right after whatever this prefix/digit already holds. */
  async function refillPool(extensionDigit: number, count: number): Promise<void> {
    const rows = await exec.all<{ maxTo: number | null }>(
      `SELECT MAX(to_serial) AS maxTo FROM sscc_pool WHERE issuer_prefix = ? AND extension_digit = ?`,
      [ISSUER_PREFIX, extensionDigit],
    );
    const from = (rows[0]?.maxTo ?? 0) + 1;
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit,
      fromSerial: from,
      toSerial: from + count - 1,
    });
  }

  it("closes the pallet when the last box joins it", async () => {
    await givenShift({ boxCapacity: 2, palletBoxCapacity: 2, palletsEnabled: true });
    await fillAndCloseBox("b1");
    const second = await fillAndCloseBox("b2");
    expect(second.pallet).toMatchObject({ status: "closed", boxCount: 2 });
    if (second.pallet?.status !== "closed") throw new Error("unreachable");
    expect(second.pallet.sscc[0]).toBe("1"); // extension digit 1
  });

  it("leaves the pallet open below capacity", async () => {
    await givenShift({ boxCapacity: 2, palletBoxCapacity: 3, palletsEnabled: true });
    const first = await fillAndCloseBox("b1");
    expect(first.pallet).toBeNull();
    expect((await currentPallet(exec, shiftId))!.boxCount).toBe(1);
  });

  it("never opens a pallet for a shift without them", async () => {
    await givenShift({ boxCapacity: 2, palletsEnabled: false });
    const closed = await fillAndCloseBox("b1");
    expect(closed.pallet).toBeNull();
    expect(await currentPallet(exec, shiftId)).toBeNull();
  });

  it("burns no pallet serial for an empty pallet", async () => {
    await givenShift({ boxCapacity: 2, palletBoxCapacity: 2, palletsEnabled: true });
    expect(await closeCurrentPallet(deps, shiftId, "op1")).toEqual({ status: "empty" });
    expect(await remainingSerials(PALLET_EXTENSION_DIGIT)).toBe(200);
  });

  it("closes a short pallet on demand", async () => {
    await givenShift({ boxCapacity: 2, palletBoxCapacity: 12, palletsEnabled: true });
    await fillAndCloseBox("b1");
    expect(await closeCurrentPallet(deps, shiftId, "op1")).toMatchObject({
      status: "closed",
      boxCount: 1,
    });
  });

  it("keeps filling one over-capacity pallet when the pallet pool is dry, then closes it as soon as serials arrive", async () => {
    await givenShift({ boxCapacity: 2, palletBoxCapacity: 1, palletsEnabled: true });
    await drainPool(PALLET_EXTENSION_DIGIT);
    const a = await fillAndCloseBox("b1");
    const b = await fillAndCloseBox("b2");
    expect(a.pallet).toEqual({ status: "no-serials" });
    expect(b.pallet).toEqual({ status: "no-serials" });
    // One pallet, over capacity -- never a second one nobody can number.
    const open = await exec.all("SELECT pallet_id FROM pallets_mirror WHERE closed_at IS NULL");
    expect(open).toHaveLength(1);
    expect((await currentPallet(exec, shiftId))!.boxCount).toBe(2);
    // Boxes closed normally: exhaustion blocks closing a pallet, never scanning.
    expect(a.status).toBe("closed");
    expect(b.status).toBe("closed");

    // Continues the same scenario: the pool now receives a fresh block, and
    // the SAME over-full pallet closes as soon as a bundle brings a block.
    await refillPool(PALLET_EXTENSION_DIGIT, 10);
    expect(await closeCurrentPallet(deps, shiftId, "op1")).toMatchObject({
      status: "closed",
      boxCount: 2,
    });
  });
});
