import { readFileSync } from "node:fs";

import { canonicalizeKm, kmHash } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  boxClosedRecord,
  boxExceptionRecord,
  boxLabelRecord,
  MAX_RECORD_BYTES,
  outboxStatement,
  palletClosedRecord,
  palletExceptionRecord,
  palletLabelRecord,
  RecordTooLargeError,
  scanRecord,
  scannedCode,
  shiftClosedRecord,
  type RecordHead,
} from "../src/floor/facts.js";
import {
  boxClosedFactSchema,
  boxExceptionFactSchema,
  boxLabelFactSchema,
  factBatchSchema,
  MAX_FACT_BATCH,
  palletClosedFactSchema,
  palletExceptionFactSchema,
  palletLabelFactSchema,
  scanFactSchema,
  scannedCodeSchema,
  shiftClosedFactSchema,
  type FactRecord,
} from "../src/host/protocol.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const RECORDS = factBatchSchema.parse(fixture("facts-request.json")).records;
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const AT = "2026-10-08T06:15:02.418Z";

/** The fixture's record `index`, asserted to exist rather than cast away. */
function record(index: number): FactRecord {
  const found = RECORDS[index];
  if (found === undefined) throw new Error(`facts-request.json has no record ${index}`);
  return found;
}

/** The code of a fixture's scan record. */
function code(of: FactRecord) {
  const data = scanFactSchema.parse(of.data);
  if (data.code === null) throw new Error("the record carries no code");
  return data.code;
}

function head(of: FactRecord): RecordHead {
  return { id: of.id, shiftId: of.shiftId, operatorId: of.operatorId };
}

// A product code as a scanner hands it over: the AIM prefix `]d2`, the GTIN,
// the serial, then the group separator and the crypto tail.
const SERIAL = "5Yq'Ct;";
const RAW = `]d2010460068200001321${SERIAL}\u001d93dGVz`;

describe("the builders of the outbox's records", () => {
  it("build every record of facts-request.json exactly", () => {
    expect(scanRecord(head(record(0)), scanFactSchema.parse(record(0).data))).toEqual(record(0));
    expect(scanRecord(head(record(1)), scanFactSchema.parse(record(1).data))).toEqual(record(1));
    expect(boxClosedRecord(head(record(2)), boxClosedFactSchema.parse(record(2).data))).toEqual(
      record(2),
    );
    expect(boxLabelRecord(head(record(3)), boxLabelFactSchema.parse(record(3).data))).toEqual(
      record(3),
    );
    expect(
      boxExceptionRecord(head(record(4)), boxExceptionFactSchema.parse(record(4).data)),
    ).toEqual(record(4));
    expect(shiftClosedRecord(head(record(5)), shiftClosedFactSchema.parse(record(5).data))).toEqual(
      record(5),
    );
  });

  it("name their kind, key by key, and keep the envelope and the data apart", () => {
    // `toEqual` would let a key with an undefined value through; the keys are exact.
    const built = [
      scanRecord(head(record(0)), scanFactSchema.parse(record(0).data)),
      boxClosedRecord(head(record(2)), boxClosedFactSchema.parse(record(2).data)),
      boxLabelRecord(head(record(3)), boxLabelFactSchema.parse(record(3).data)),
      boxExceptionRecord(head(record(4)), boxExceptionFactSchema.parse(record(4).data)),
      shiftClosedRecord(head(record(5)), shiftClosedFactSchema.parse(record(5).data)),
    ];
    expect(built.map((made) => made.kind)).toEqual([
      "scan",
      "box_closed",
      "box_label",
      "box_exception",
      "shift_closed",
    ]);
    for (const made of built) {
      expect(Object.keys(made).sort()).toEqual(["data", "id", "kind", "operatorId", "shiftId"]);
    }
  });

  it("keep an absent operator as null, not as a missing key", () => {
    const made = scanRecord(
      { id: record(1).id, shiftId: record(1).shiftId, operatorId: null },
      scanFactSchema.parse(record(1).data),
    );
    expect(made.operatorId).toBeNull();
    expect(JSON.parse(JSON.stringify(made))).toHaveProperty("operatorId", null);
  });

  it("build every record of facts-request-pallets.json exactly (plan ПЛ-Ц)", () => {
    const pallets = factBatchSchema.parse(fixture("facts-request-pallets.json")).records;
    const [box, closed, label, exception] = pallets;
    if (box === undefined || closed === undefined || label === undefined) throw new Error("short");
    if (exception === undefined) throw new Error("short");
    expect(boxClosedRecord(head(box), boxClosedFactSchema.parse(box.data))).toEqual(box);
    expect(palletClosedRecord(head(closed), palletClosedFactSchema.parse(closed.data))).toEqual(
      closed,
    );
    expect(palletLabelRecord(head(label), palletLabelFactSchema.parse(label.data))).toEqual(label);
    expect(
      palletExceptionRecord(head(exception), palletExceptionFactSchema.parse(exception.data)),
    ).toEqual(exception);
  });

  it("carry a code as the domain read it: the hash without the tail, the canonical text with it", () => {
    const km = canonicalizeKm(RAW);
    expect(scannedCode(km)).toEqual({
      codeHash: kmHash(km),
      gtin14: "04600682000013",
      serial: SERIAL,
      canonical: `010460068200001321${SERIAL}\u001d93dGVz`,
    });
    // The same code without the AIM prefix, or with another tail, is the same code.
    const bare = scannedCode(canonicalizeKm(`010460068200001321${SERIAL}\u001d93dGVz`));
    const otherTail = scannedCode(canonicalizeKm(`010460068200001321${SERIAL}\u001d93xxxx`));
    expect(bare.codeHash).toBe(scannedCode(km).codeHash);
    expect(otherTail.codeHash).toBe(scannedCode(km).codeHash);
    expect(otherTail.canonical).not.toBe(bare.canonical);
    expect(scannedCode(km).codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("carry a code the host's schema reads back, group separator and all", () => {
    const made = scannedCode(canonicalizeKm(RAW));
    expect(scannedCodeSchema.parse(made)).toEqual(made);
    expect(Object.keys(made).sort()).toEqual(["canonical", "codeHash", "gtin14", "serial"]);
    expect(made.canonical).toContain("\u001d");
    expect(made.canonical.startsWith("]d2")).toBe(false);
    // Another serial is another code; another GTIN too.
    const other = scannedCode(canonicalizeKm(RAW.replace(SERIAL, "5Yq'Ct<")));
    expect(other.codeHash).not.toBe(made.codeHash);
    expect(other.serial).toBe("5Yq'Ct<");
  });
});

describe("the outbox row of a record", () => {
  it("keeps the whole record as its payload, under the pairing, in one row", async () => {
    const { db, executor } = openLocalDb();
    const statement = outboxStatement(record(0), PAIRING, AT);
    expect(statement.expectedChanges).toBe(1);
    await executor.transaction([statement]);
    const rows = db
      .prepare(
        "SELECT id, host_id, device_id, kind, shift_id, payload, created_at, attempts, acked_at FROM outbox",
      )
      .all();
    expect(rows).toEqual([
      {
        id: record(0).id,
        host_id: HOST_ID,
        device_id: DEVICE_ID,
        kind: "scan",
        shift_id: record(0).shiftId,
        payload: JSON.stringify(record(0)),
        created_at: AT,
        attempts: 0,
        acked_at: null,
      },
    ]);
    const payload = z.string().parse(rows[0]?.["payload"]);
    expect(JSON.parse(payload)).toEqual(record(0));
  });

  it("keeps a record of every kind under its own kind, shift and id, in the order written", async () => {
    const { db, executor } = openLocalDb();
    for (const [index, made] of RECORDS.entries()) {
      await executor.transaction([
        outboxStatement(made, PAIRING, `2026-10-08T06:15:0${index}.000Z`),
      ]);
    }
    const rows = db
      .prepare("SELECT seq, id, kind, shift_id, payload, created_at FROM outbox ORDER BY seq")
      .all();
    expect(rows.map((row) => row["kind"])).toEqual(RECORDS.map((made) => made.kind));
    expect(rows.map((row) => row["id"])).toEqual(RECORDS.map((made) => made.id));
    expect(rows.map((row) => row["shift_id"])).toEqual(RECORDS.map((made) => made.shiftId));
    expect(rows.map((row) => row["payload"])).toEqual(RECORDS.map((made) => JSON.stringify(made)));
    expect(rows.map((row) => row["created_at"])).toEqual(
      RECORDS.map((_made, index) => `2026-10-08T06:15:0${index}.000Z`),
    );
    expect(rows.map((row) => row["seq"])).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("is a plain insert: the same record twice is refused and keeps the first row", async () => {
    const { db, executor } = openLocalDb();
    await executor.transaction([outboxStatement(record(0), PAIRING, AT)]);
    await expect(
      executor.transaction([outboxStatement(record(0), PAIRING, "2026-10-08T07:00:00.000Z")]),
    ).rejects.toMatchObject({ code: "statement_failed" });
    expect(db.prepare("SELECT created_at FROM outbox").all()).toEqual([{ created_at: AT }]);
  });

  it("keeps the record as the schema reads it, whatever order its keys came in", () => {
    const scan = record(0);
    const shuffled = {
      data: Object.fromEntries(Object.entries(scan.data).reverse()),
      operatorId: scan.operatorId,
      kind: scan.kind,
      id: scan.id,
      shiftId: scan.shiftId,
    } as unknown as FactRecord;
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(scan));
    const [, , , , , payload] = outboxStatement(shuffled, PAIRING, AT).values ?? [];
    expect(payload).toBe(JSON.stringify(scan));
  });

  it("refuses a record this build cannot form, and writes nothing", () => {
    const { db } = openLocalDb();
    const bad = { ...record(2), operatorId: "0042" };
    expect(() => outboxStatement(bad, PAIRING, AT)).toThrow();
    const notMine = { ...record(0), kind: "box_closed" } as FactRecord;
    expect(() => outboxStatement(notMine, PAIRING, AT)).toThrow();
    // A head that carries more than the envelope is no record either.
    const wide = { ...record(0), formState: { typed: "1" } } as unknown as FactRecord;
    expect(() => outboxStatement(wide, PAIRING, AT)).toThrow();
    const noCode = {
      ...record(0),
      data: { ...record(0).data, code: undefined },
    } as unknown as FactRecord;
    expect(() => outboxStatement(noCode, PAIRING, AT)).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM outbox").get()).toEqual({ n: 0 });
  });

  it("keeps no record larger than a batch of 100 can carry under the host's 2 MiB", () => {
    expect(MAX_RECORD_BYTES).toBe(16 * 1024);
    expect(MAX_FACT_BATCH).toBe(100);
    expect(MAX_RECORD_BYTES * MAX_FACT_BATCH).toBeLessThan(2 * 1024 * 1024);
    const scan = record(0);
    const sized = (canonical: string): FactRecord =>
      scanRecord(head(scan), {
        ...scanFactSchema.parse(scan.data),
        code: { ...code(scan), canonical },
      });
    const base = JSON.stringify(sized("")).length;
    // Cyrillic letters are two bytes each: the limit is in bytes, not characters.
    const fits = sized("ж".repeat((MAX_RECORD_BYTES - base) / 2));
    expect(new TextEncoder().encode(JSON.stringify(fits)).length).toBe(MAX_RECORD_BYTES);
    expect(() => outboxStatement(fits, PAIRING, AT)).not.toThrow();
    const over = sized(`${"ж".repeat((MAX_RECORD_BYTES - base) / 2)}x`);
    expect(() => outboxStatement(over, PAIRING, AT)).toThrow(RecordTooLargeError);
    // The error names the size in bytes, and what it is.
    expect(() => outboxStatement(over, PAIRING, AT)).toThrow(
      new RecordTooLargeError(MAX_RECORD_BYTES + 1),
    );
    expect(new RecordTooLargeError(1).name).toBe("RecordTooLargeError");
    expect(new RecordTooLargeError(1)).toBeInstanceOf(Error);
  });

  it("keeps a scan of the longest code the host takes, far under that limit", () => {
    // The host takes a canonical code of at most 1024 bytes.
    const scan = record(0);
    const longest: FactRecord = scanRecord(head(scan), {
      ...scanFactSchema.parse(scan.data),
      code: { ...code(scan), canonical: "x".repeat(1024) },
    });
    const bytes = new TextEncoder().encode(JSON.stringify(longest)).length;
    expect(bytes).toBeLessThan(2 * 1024);
    expect(() => outboxStatement(longest, PAIRING, AT)).not.toThrow();
  });
});
