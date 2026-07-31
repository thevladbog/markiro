import { DatabaseSync } from "node:sqlite";
import { buildSscc, isValidSscc } from "@markiro/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { boxLabelFields } from "../src/lib/box-label.js";
import { currentBox, openBox } from "../src/lib/boxes.js";
import { closeCurrentBox, type CloseBoxDeps } from "../src/lib/close-box.js";
import { recordScan, type AcceptedCode, type ScanEventRow } from "../src/lib/journal.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { addRange, remaining } from "../src/lib/sscc-pool.js";
import { makeExec } from "./support/sqlite-exec.js";

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
    deps = { exec, issuerPrefix: ISSUER_PREFIX, now: () => new Date(ISO).getTime() };
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
    const rows = await exec.all<{ sscc: string; closed_by: string | null; closed_at: string }>(
      `SELECT sscc, closed_by, closed_at FROM boxes_mirror WHERE box_id = ?`,
      ["b1"],
    );
    expect(rows[0]).toEqual({ sscc: res.sscc, closed_by: "op-1", closed_at: ISO });
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
});

describe("boxLabelFields", () => {
  it("maps every input to its own labelled slot, leaving km.code and shift.no blank", () => {
    const fields = boxLabelFields({
      sscc: SSCC,
      itemCount: 12,
      productName: "Кола",
      gtin14: GTIN,
      operatorName: "Иванов",
      counterpartyName: "Клиент",
      closedAt: "2026-07-29T10:15:00.000Z",
    });
    expect(fields).toEqual({
      "product.name": "Кола",
      "product.gtin": GTIN,
      "km.code": "",
      sscc: SSCC,
      "shift.no": "",
      date: "2026-07-29",
      qty: "12",
      operator: "Иванов",
      "counterparty.name": "Клиент",
    });
  });

  it("defaults a missing operator or counterparty to an empty string", () => {
    const fields = boxLabelFields({
      sscc: SSCC,
      itemCount: 1,
      productName: "",
      gtin14: GTIN,
      operatorName: null,
      counterpartyName: null,
      closedAt: ISO,
    });
    expect(fields.operator).toBe("");
    expect(fields["counterparty.name"]).toBe("");
  });

  it("puts no application identifier in the field record", () => {
    const fields = boxLabelFields({
      sscc: SSCC,
      itemCount: 1,
      productName: "",
      gtin14: GTIN,
      operatorName: null,
      counterpartyName: null,
      closedAt: ISO,
    });
    expect(fields.sscc).toHaveLength(18);
    expect(fields.sscc.startsWith("00")).toBe(false);
  });
});
