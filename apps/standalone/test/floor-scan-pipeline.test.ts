import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { buildSscc, canonicalizeKm, kmHash } from "@markiro/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { scanRecord } from "../src/floor/facts.js";
import type { WorkShift } from "../src/floor/shifts/shift-copies.js";
import { HOST_MAX_SERIAL_BYTES, processScan, readScan } from "../src/floor/work/scan-pipeline.js";
import { createWorkQueue } from "../src/floor/work/work-queue.js";
import { HostError, TRANSPORT_CODES } from "../src/host/client.js";
import { factRecordSchema, type CodeCheck } from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import {
  failingWrites,
  GTIN,
  holdingWrites,
  km,
  OPERATOR_ID,
  OTHER_GTIN,
  PAIRING,
  PREFIX,
  rows,
  scanContext,
  SHIFT_ID,
  enteredShift,
  steppingClock,
} from "./support/floor-work.js";
import { openLocalDb, openLocalDbFile } from "./support/local-db.js";

const OTHER_DEVICE = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const TAKEN: CodeCheck = {
  status: "taken",
  owner: {
    shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    shiftNumber: "OCT26-003",
    deviceId: OTHER_DEVICE,
    scannedAt: "2026-10-08T05:58:41.090Z",
    sameDevice: false,
  },
};

async function station() {
  const { db, executor } = openLocalDb();
  const shift = await enteredShift(executor);
  return { db, local: executor, shift };
}

function codeHashOf(raw: string): string {
  return kmHash(canonicalizeKm(raw));
}

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the reading of a raw scan", () => {
  const SSCC = buildSscc(0, PREFIX, 1500);

  it("reads a product's code with its AIM prefix, group separators and crypto tail", () => {
    const reading = readScan(km("5Yq'Ct;"));
    expect(reading).toMatchObject({
      kind: "km",
      km: { gtin14: GTIN, serial: "5Yq'Ct;", raw: `01${GTIN}215Yq'Ct;\u001d93dGVz` },
    });
    // Spaces and tabs around a keyboard scan are not the code's.
    expect(readScan(` ${km("5Yq'Ct;")}\t`)).toEqual(reading);
  });

  it("reads a GTIN, an SSCC and anything else as no code of marking", () => {
    expect(readScan(GTIN)).toEqual({ kind: "gtin" });
    expect(readScan(GTIN.slice(1))).toEqual({ kind: "gtin" });
    expect(readScan(`]C100${SSCC}`)).toEqual({ kind: "sscc" });
    expect(readScan(`(00)${SSCC}`)).toEqual({ kind: "sscc" });
    expect(readScan("MRK-000742")).toEqual({ kind: "unknown" });
    // A group separator with nothing after it, a character the COM decoding
    // replaced, and a serial longer than the host keeps.
    expect(readScan(`01${GTIN}215Yq'Ct;\u001d`)).toEqual({ kind: "unknown" });
    expect(readScan(`01${GTIN}215Yq'Ct�\u001d93dGVz`)).toEqual({ kind: "unknown" });
    expect(readScan(km("x".repeat(HOST_MAX_SERIAL_BYTES + 1)))).toEqual({ kind: "unknown" });
    expect(readScan(km("x".repeat(HOST_MAX_SERIAL_BYTES)))).toMatchObject({ kind: "km" });
    // The limit is in bytes: 32 Cyrillic letters are 64 bytes, 33 are 66.
    expect(readScan(km("ж".repeat(32)))).toMatchObject({ kind: "km" });
    expect(readScan(km("ж".repeat(33)))).toEqual({ kind: "unknown" });
  });
});

describe("the reading of a raw scan against what the host keeps", () => {
  it("takes a serial of 64 bytes and no more, the host's MAX_SERIAL_BYTES", () => {
    expect(HOST_MAX_SERIAL_BYTES).toBe(64);
    expect(readScan(km("x".repeat(64)))).toMatchObject({ kind: "km" });
    expect(readScan(km("x".repeat(65)))).toEqual({ kind: "unknown" });
  });

  it("takes a code of 1 024 bytes and no more, the host's limit for a canonical code", () => {
    // 22 characters of the elements and the separator, then the crypto tail.
    const withTail = (length: number) => km("S", { aim: false, tail: "t".repeat(length) });
    expect(new TextEncoder().encode(withTail(1002)).length).toBe(1024);
    expect(readScan(withTail(1002))).toMatchObject({ kind: "km" });
    expect(readScan(withTail(1003))).toEqual({ kind: "unknown" });
  });

  it("takes no code with a control character in it, or one the host would refuse", () => {
    expect(readScan(km("A\tB"))).toEqual({ kind: "unknown" });
    expect(readScan(km("A\u0000B"))).toEqual({ kind: "unknown" });
    expect(readScan(km("A\u007fB"))).toEqual({ kind: "unknown" });
    // The host refuses every control character (Rust's `is_control`, the
    // category Cc), the C1 range U+0080-U+009F included.
    for (const control of ["\u0080", "\u0085", "\u009f"]) {
      expect(readScan(km(`A${control}B`))).toEqual({ kind: "unknown" });
    }
    // What is no control character stays a code: no-break space, a line
    // separator and a zero-width space are the host's to keep.
    for (const kept of ["\u00a0", "\u2028", "\u200b"]) {
      expect(readScan(km(`A${kept}B`))).toMatchObject({ kind: "km" });
    }
    expect(readScan(km(""))).toEqual({ kind: "unknown" });
    expect(readScan("")).toEqual({ kind: "unknown" });
    expect(readScan("  \t ")).toEqual({ kind: "unknown" });
  });
});

describe("a scan of the work screen", () => {
  it("counts the length of the scan as the scanner sent it, and keeps the code without the edges", async () => {
    const { db, local, shift } = await station();
    const raw = ` ${km("5Yq'Ct;")}\t`;
    await processScan(scanContext(local, shift), raw);
    const [scan] = rows(db, "SELECT raw_length, canonical, serial FROM floor_scans");
    expect(scan).toEqual({
      raw_length: raw.length,
      canonical: `01${GTIN}215Yq'Ct;\u001d93dGVz`,
      serial: "5Yq'Ct;",
    });
    expect(
      rows(db, "SELECT payload FROM outbox").map((row) => String(row["payload"]))[0],
    ).toContain(`"rawLength":${raw.length}`);
  });

  it("accepts a code into a new box, with its journal row and outbox record in one write", async () => {
    const { db, local, shift } = await station();
    const raw = km("5Yq'Ct;");
    const context = scanContext(local, shift);
    const scanId = "00000000-0000-4000-8000-000000000001";
    const boxId = "00000000-0000-4000-8000-000000000002";
    await expect(processScan(context, raw)).resolves.toEqual({
      kind: "accepted",
      boxId,
      itemCount: 1,
      scannedAt: "2026-10-08T06:15:00.000Z",
      code: { gtin14: GTIN, serial: "5Yq'Ct;" },
    });
    const code = {
      codeHash: codeHashOf(raw),
      gtin14: GTIN,
      serial: "5Yq'Ct;",
      canonical: `01${GTIN}215Yq'Ct;\u001d93dGVz`,
    };
    expect(
      rows(db, "SELECT id, shift_id, opened_at, item_count, closed_at FROM floor_boxes"),
    ).toEqual([
      {
        id: boxId,
        shift_id: SHIFT_ID,
        opened_at: "2026-10-08T06:15:00.000Z",
        item_count: 1,
        closed_at: null,
      },
    ]);
    expect(
      rows(db, "SELECT code_hash, shift_id, box_id, scan_id, scanned_at FROM floor_codes"),
    ).toEqual([
      {
        code_hash: code.codeHash,
        shift_id: SHIFT_ID,
        box_id: boxId,
        scan_id: scanId,
        scanned_at: "2026-10-08T06:15:00.000Z",
      },
    ]);
    expect(
      rows(
        db,
        "SELECT id, box_id, verdict, duplicate_source, raw_kind, raw_length, code_hash, " +
          "canonical, operator_id, conflict FROM floor_scans",
      ),
    ).toEqual([
      {
        id: scanId,
        box_id: boxId,
        verdict: "ok",
        duplicate_source: null,
        raw_kind: "km",
        raw_length: raw.length,
        code_hash: code.codeHash,
        canonical: code.canonical,
        operator_id: OPERATOR_ID,
        conflict: 0,
      },
    ]);
    const [outbox] = rows(db, "SELECT id, kind, shift_id, payload, acked_at FROM outbox");
    expect(outbox).toMatchObject({ id: scanId, kind: "scan", shift_id: SHIFT_ID, acked_at: null });
    expect(JSON.parse(String(outbox?.["payload"]))).toEqual(
      scanRecord(
        { id: scanId, shiftId: SHIFT_ID, operatorId: OPERATOR_ID },
        {
          scannedAt: "2026-10-08T06:15:00.000Z",
          verdict: "ok",
          duplicateSource: null,
          rawKind: "km",
          rawLength: raw.length,
          code,
          boxId,
        },
      ),
    );
  });

  it("puts the next code into the same open box", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    const first = await processScan(context, km("A1"));
    await expect(processScan(context, km("A2"))).resolves.toEqual({
      kind: "accepted",
      boxId: first.kind === "accepted" ? first.boxId : "",
      itemCount: 2,
      scannedAt: "2026-10-08T06:15:01.000Z",
      code: { gtin14: GTIN, serial: "A2" },
    });
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 2 }]);
  });

  it("journals what is no code of marking by its length and kind only, never its text", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift);
    await expect(processScan(context, "MRK-000742")).resolves.toEqual({
      kind: "invalid",
      rawKind: "unknown",
      scannedAt: "2026-10-08T06:15:00.000Z",
      code: null,
    });
    await expect(processScan(context, GTIN)).resolves.toEqual({
      kind: "invalid",
      rawKind: "gtin",
      scannedAt: "2026-10-08T06:15:01.000Z",
      code: null,
    });
    expect(
      rows(
        db,
        "SELECT verdict, raw_kind, raw_length, code_hash, canonical, box_id FROM floor_scans",
      ),
    ).toEqual([
      {
        verdict: "invalid",
        raw_kind: "unknown",
        raw_length: 10,
        code_hash: null,
        canonical: null,
        box_id: null,
      },
      {
        verdict: "invalid",
        raw_kind: "gtin",
        raw_length: 14,
        code_hash: null,
        canonical: null,
        box_id: null,
      },
    ]);
    const payloads = rows(db, "SELECT payload FROM outbox").map((row) => String(row["payload"]));
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) expect(payload).not.toContain("MRK");
    expect(rows(db, "SELECT count(*) AS n FROM floor_boxes")).toEqual([{ n: 0 }]);
  });

  it("refuses a code of another product into no box", async () => {
    const { db, local, shift } = await station();
    await expect(
      processScan(scanContext(local, shift), km("B1", { gtin: OTHER_GTIN })),
    ).resolves.toEqual({
      kind: "wrong_gtin",
      gtin14: OTHER_GTIN,
      scannedAt: "2026-10-08T06:15:00.000Z",
      code: { gtin14: OTHER_GTIN, serial: "B1" },
    });
    expect(rows(db, "SELECT verdict, box_id, gtin14 FROM floor_scans")).toEqual([
      { verdict: "wrong_gtin", box_id: null, gtin14: OTHER_GTIN },
    ]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 0 }]);
  });

  it("finds a code it holds, under another AIM prefix or tail too, without asking the host", async () => {
    const { db, local, shift } = await station();
    const checkCode = vi.fn(async (): Promise<CodeCheck> => ({ status: "free" }));
    const context = scanContext(local, shift, { online: () => true, checkCode });
    await processScan(context, km("C1"));
    await expect(processScan(context, km("C1", { aim: false, tail: "xxxx" }))).resolves.toEqual({
      kind: "duplicate",
      source: "local",
      firstScannedAt: "2026-10-08T06:15:00.000Z",
      scannedAt: "2026-10-08T06:15:01.000Z",
      code: { gtin14: GTIN, serial: "C1" },
    });
    expect(checkCode).toHaveBeenCalledTimes(1);
    expect(
      rows(db, "SELECT verdict, duplicate_source, box_id FROM floor_scans ORDER BY scanned_at"),
    ).toEqual([
      { verdict: "ok", duplicate_source: null, box_id: expect.any(String) },
      { verdict: "duplicate", duplicate_source: "local", box_id: null },
    ]);
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 1 }]);
  });

  it("asks the host while online, and takes a code another device's scan owns as its duplicate", async () => {
    const { db, local, shift } = await station();
    const checkCode = vi.fn(async (): Promise<CodeCheck> => TAKEN);
    const raw = km("D1");
    await expect(
      processScan(scanContext(local, shift, { online: () => true, checkCode }), raw),
    ).resolves.toEqual({
      kind: "duplicate",
      source: "host",
      firstScannedAt: "2026-10-08T05:58:41.090Z",
      shiftNumber: "OCT26-003",
      scannedAt: "2026-10-08T06:15:00.000Z",
      code: { gtin14: GTIN, serial: "D1" },
    });
    expect(checkCode).toHaveBeenCalledWith(codeHashOf(raw));
    expect(rows(db, "SELECT verdict, duplicate_source FROM floor_scans")).toEqual([
      { verdict: "duplicate", duplicate_source: "host" },
    ]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 0 }]);
  });

  it("preserves explicit cloud origin for an online duplicate without creating local ownership", async () => {
    const { db, local, shift } = await station();
    const owner = { ...TAKEN.owner, deviceId: "00000000-0000-0000-0000-000000000000" };
    const outcome = await processScan(
      scanContext(local, shift, {
        online: () => true,
        checkCode: async () => ({ status: "taken", owner }),
      }),
      km("CLOUD1"),
    );
    expect(outcome).toMatchObject({
      kind: "duplicate",
      source: "host",
      cloudHistory: true,
      shiftNumber: owner.shiftNumber,
      firstScannedAt: owner.scannedAt,
    });
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 0 }]);
    expect(rows(db, "SELECT verdict, duplicate_source FROM floor_scans")).toEqual([
      { verdict: "duplicate", duplicate_source: "host" },
    ]);
  });

  it("accepts without the host when offline, when the check fails or times out, and over its own scan", async () => {
    const { db, local, shift } = await station();
    const timeout = new HostError({ kind: "transport", code: "timeout", message: "300 ms" });
    const offline = vi.fn(async (): Promise<CodeCheck> => TAKEN);
    const onHostError = vi.fn();
    await processScan(scanContext(local, shift, { checkCode: offline }), km("E1"));
    expect(offline).not.toHaveBeenCalled();
    const failing = scanContext(local, shift, {
      online: () => true,
      checkCode: async () => {
        throw timeout;
      },
      onHostError,
      newId: () => crypto.randomUUID(),
    });
    await expect(processScan(failing, km("E2"))).resolves.toMatchObject({
      kind: "accepted",
      itemCount: 2,
    });
    expect(onHostError).toHaveBeenCalledWith(timeout);
    const own = scanContext(local, shift, {
      online: () => true,
      checkCode: async () => ({ ...TAKEN, owner: { ...TAKEN.owner, sameDevice: true } }),
      newId: () => crypto.randomUUID(),
    });
    await expect(processScan(own, km("E3"))).resolves.toMatchObject({
      kind: "accepted",
      itemCount: 3,
    });
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 3 }]);
  });

  it("lets no host hiccup lose a scan: a callback that throws decides nothing", async () => {
    const { db, local, shift } = await station();
    const timeout = new HostError({ kind: "transport", code: "timeout", message: "300 ms" });
    const onHostError = vi.fn(() => {
      throw new Error("the shell's reaction failed");
    });
    const context = scanContext(local, shift, {
      online: () => true,
      checkCode: async () => {
        throw timeout;
      },
      onHostError,
    });
    await expect(processScan(context, km("T1"))).resolves.toMatchObject({
      kind: "accepted",
      itemCount: 1,
    });
    expect(onHostError).toHaveBeenCalledTimes(1);
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 1 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 1 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 1 }]);
  });

  it("opens one box at most in an empty shift: the second of two racing scans writes nothing", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    const context = scanContext(held.executor, shift, { newId: () => crypto.randomUUID() });
    // Both scans read no open box; the first holds its write, the second opens
    // the box, and the first then fails whole on the box's key.
    held.holdNext();
    const first = processScan(context, km("M1"));
    await held.reached();
    await expect(processScan(context, km("M2"))).resolves.toMatchObject({
      kind: "accepted",
      itemCount: 1,
    });
    held.release();
    await expect(first).rejects.toBeInstanceOf(LocalDbError);
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 1 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 1 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 1 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 1 }]);
  });

  it("holds a code in one box at most: a second accept the check missed writes nothing", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    const context = scanContext(held.executor, shift, { newId: () => crypto.randomUUID() });
    await processScan(context, km("F0"));
    // The first scan of F1 holds its write; the second, which the queue would
    // have kept behind it, reads meanwhile, finds the code free and writes.
    held.holdNext();
    const first = processScan(context, km("F1"));
    await held.reached();
    await expect(processScan(context, km("F1"))).resolves.toMatchObject({
      kind: "accepted",
      itemCount: 2,
    });
    held.release();
    await expect(first).rejects.toMatchObject({ code: "changes_mismatch" });
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 2 }]);
  });

  it("never puts a code into a box that closed while the scan was on its way", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    const context = scanContext(held.executor, shift, { newId: () => crypto.randomUUID() });
    await processScan(context, km("K0"));
    held.holdNext();
    const late = processScan(context, km("K1"));
    await held.reached();
    db.prepare(
      "UPDATE floor_boxes SET closed_at = '2026-10-08T06:20:00.000Z', sscc = ?, " +
        "block_id = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a', serial = 1500",
    ).run(buildSscc(0, PREFIX, 1500));
    held.release();
    await expect(late).rejects.toMatchObject({ code: "changes_mismatch" });
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 1 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 1 }]);
  });

  it("writes the journal row, the code, the box and the outbox record together or not at all", async () => {
    const { db, local, shift } = await station();
    // The outbox already has a record with the id the scan gets: its insert
    // fails, and so must the rest of the scan.
    const taken = "00000000-0000-4000-8000-000000000001";
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES (?, ?, ?, 'scan', ?, '{}', '2026-10-08T06:00:00.000Z')",
    ).run(taken, PAIRING.hostId, PAIRING.deviceId, SHIFT_ID);
    await expect(processScan(scanContext(local, shift), km("G1"))).rejects.toBeInstanceOf(
      LocalDbError,
    );
    expect(rows(db, "SELECT count(*) AS n FROM floor_boxes")).toEqual([{ n: 0 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 0 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 0 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 1 }]);
  });

  it("rejects when this computer cannot write, and takes nothing", async () => {
    const { db, local, shift } = await station();
    await expect(
      processScan(scanContext(failingWrites(local), shift), km("H1")),
    ).rejects.toMatchObject({
      code: "statement_failed",
    });
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 0 }]);
  });

  it("keeps what it took across a restart: the same box, and the code still its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markiro-floor-"));
    temporary.push(dir);
    const path = join(dir, "station.db");
    const before = openLocalDbFile(path);
    const shift = await enteredShift(before.executor);
    const first = await processScan(scanContext(before.executor, shift), km("J1"));
    before.db.close();
    const after = openLocalDbFile(path);
    const context = scanContext(after.executor, shift, { newId: () => crypto.randomUUID() });
    await expect(processScan(context, km("J1"))).resolves.toMatchObject({
      kind: "duplicate",
      source: "local",
    });
    await expect(processScan(context, km("J2"))).resolves.toEqual({
      kind: "accepted",
      boxId: first.kind === "accepted" ? first.boxId : "",
      itemCount: 2,
      scannedAt: "2026-10-08T06:15:01.000Z",
      code: { gtin14: GTIN, serial: "J2" },
    });
    expect(rows(after.db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([
      { n: 3 },
    ]);
    after.db.close();
  });
});

describe("the work queue", () => {
  it("runs one job at a time, in order, and goes on after a failed one", async () => {
    const queue = createWorkQueue();
    const log: string[] = [];
    let release: () => void = () => undefined;
    const first = queue.run(
      () =>
        new Promise<string>((resolve) => {
          log.push("first started");
          release = () => resolve("first");
        }),
    );
    const failed = queue.run(async () => {
      log.push("second started");
      throw new Error("disk");
    });
    const third = queue.run(async () => {
      log.push("third started");
      return "third";
    });
    await Promise.resolve();
    expect(log).toEqual(["first started"]);
    expect(queue.pending()).toBe(3);
    release();
    await expect(first).resolves.toBe("first");
    await expect(failed).rejects.toThrow("disk");
    await expect(third).resolves.toBe("third");
    expect(log).toEqual(["first started", "second started", "third started"]);
    expect(queue.pending()).toBe(0);
  });
});

const SECOND_SHIFT = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_HOST = "6e5d4c3b-2a19-4f8e-9d7c-0b1a2c3d4e5f";

/** Every value of every table of the floor and the outbox, as one text. */
function everythingStored(db: DatabaseSync): string {
  const tables = ["floor_boxes", "floor_codes", "floor_scans", "outbox"];
  return tables.map((table) => JSON.stringify(rows(db, `SELECT * FROM ${table}`))).join("\n");
}

describe("a scan of the work screen, beyond the accepted one", () => {
  it("keeps one instant for the whole scan: the clock is read once, the rows agree", async () => {
    const { db, local, shift } = await station();
    const stepping = steppingClock();
    const now = vi.fn(stepping);
    const context = scanContext(local, shift, { now });
    await processScan(context, km("N1"));
    expect(now).toHaveBeenCalledTimes(1);
    const at = "2026-10-08T06:15:00.000Z";
    const [scan] = rows(db, "SELECT scanned_at FROM floor_scans");
    const [code] = rows(db, "SELECT scanned_at FROM floor_codes");
    const [box] = rows(db, "SELECT opened_at FROM floor_boxes");
    const [outbox] = rows(db, "SELECT created_at, payload FROM outbox");
    expect([scan?.["scanned_at"], code?.["scanned_at"], box?.["opened_at"]]).toEqual([at, at, at]);
    expect(outbox?.["created_at"]).toBe(at);
    expect(JSON.parse(String(outbox?.["payload"])).data.scannedAt).toBe(at);
    // Each later scan is read at its own instant, whatever becomes of it.
    await processScan(context, "MRK-1");
    await processScan(context, km("N1"));
    expect(now).toHaveBeenCalledTimes(3);
    expect(rows(db, "SELECT scanned_at FROM floor_scans ORDER BY rowid")).toEqual([
      { scanned_at: at },
      { scanned_at: "2026-10-08T06:15:01.000Z" },
      { scanned_at: "2026-10-08T06:15:02.000Z" },
    ]);
  });

  it("writes every row of a scan under the pairing and the shift it was taken in", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift, { newId: () => crypto.randomUUID() });
    await processScan(context, km("K1"));
    await processScan(context, "MRK-000742");
    for (const table of ["floor_boxes", "floor_codes", "floor_scans", "outbox"]) {
      const stored = rows(db, `SELECT host_id, device_id, shift_id FROM ${table}`);
      expect(stored.length, table).toBeGreaterThan(0);
      for (const row of stored) {
        expect(row, table).toEqual({
          host_id: PAIRING.hostId,
          device_id: PAIRING.deviceId,
          shift_id: SHIFT_ID,
        });
      }
    }
    // The pairing's two ids are not the same text, so a swap shows.
    expect(PAIRING.hostId).not.toBe(PAIRING.deviceId);
  });

  it("gives every outbox record the scan's own id and the place of its scan in the order", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift, { newId: () => crypto.randomUUID() });
    await processScan(context, km("O1"));
    await processScan(context, "MRK-000742");
    await processScan(context, km("O2", { gtin: OTHER_GTIN }));
    await processScan(context, km("O1"));
    await processScan(context, km("O3"));
    const scans = rows(db, "SELECT id, verdict FROM floor_scans ORDER BY scanned_at");
    const outbox = rows(
      db,
      "SELECT seq, id, kind, shift_id, payload, acked_at, outcome, attempts, sent_at " +
        "FROM outbox ORDER BY seq",
    );
    expect(scans.map((scan) => scan["verdict"])).toEqual([
      "ok",
      "invalid",
      "wrong_gtin",
      "duplicate",
      "ok",
    ]);
    expect(outbox.map((row) => row["id"])).toEqual(scans.map((scan) => scan["id"]));
    for (const row of outbox) {
      expect(row).toMatchObject({
        kind: "scan",
        shift_id: SHIFT_ID,
        acked_at: null,
        outcome: null,
        attempts: 0,
        sent_at: null,
      });
      const record = factRecordSchema.parse(JSON.parse(String(row["payload"])));
      expect(record).toMatchObject({ id: row["id"], kind: "scan", shiftId: SHIFT_ID });
    }
    const seqs = outbox.map((row) => Number(row["seq"]));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(5);
  });

  it("stores nothing of a scan that is no code of marking but its length and kind", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift, { online: () => true });
    const badge = "BADGE-7731-SECRET";
    const sscc = buildSscc(0, PREFIX, 1500);
    await expect(processScan(context, badge)).resolves.toEqual({
      kind: "invalid",
      rawKind: "unknown",
      scannedAt: "2026-10-08T06:15:00.000Z",
      code: null,
    });
    await expect(processScan(context, `]C100${sscc}`)).resolves.toEqual({
      kind: "invalid",
      rawKind: "sscc",
      scannedAt: "2026-10-08T06:15:01.000Z",
      code: null,
    });
    await expect(processScan(context, GTIN)).resolves.toEqual({
      kind: "invalid",
      rawKind: "gtin",
      scannedAt: "2026-10-08T06:15:02.000Z",
      code: null,
    });
    // The host is not asked about a scan that is no code.
    expect(context.checkCode).not.toHaveBeenCalled();
    const stored = everythingStored(db);
    expect(stored).not.toContain("SECRET");
    expect(stored).not.toContain(sscc);
    expect(stored).not.toContain(GTIN);
    expect(rows(db, "SELECT raw_kind, raw_length FROM floor_scans ORDER BY scanned_at")).toEqual([
      { raw_kind: "unknown", raw_length: badge.length },
      { raw_kind: "sscc", raw_length: `]C100${sscc}`.length },
      { raw_kind: "gtin", raw_length: GTIN.length },
    ]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_boxes")).toEqual([{ n: 0 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 0 }]);
  });

  it("refuses another product's code before it looks at what it holds, and never asks the host", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift, { newId: () => crypto.randomUUID() });
    await processScan(context, km("W1"));
    // The same code, in a shift of another product: its GTIN is the verdict.
    const milk = { ...shift.snapshot.product, gtin14: OTHER_GTIN };
    const other: WorkShift = {
      copy: { ...shift.copy, id: SECOND_SHIFT },
      snapshot: { ...shift.snapshot, product: milk },
    };
    const checkCode = vi.fn(async (): Promise<CodeCheck> => ({ status: "free" }));
    const onOther = scanContext(local, other, {
      online: () => true,
      checkCode,
      newId: () => crypto.randomUUID(),
    });
    await expect(processScan(onOther, km("W1"))).resolves.toEqual({
      kind: "wrong_gtin",
      gtin14: GTIN,
      scannedAt: "2026-10-08T06:15:00.000Z",
      code: { gtin14: GTIN, serial: "W1" },
    });
    expect(checkCode).not.toHaveBeenCalled();
    expect(
      rows(
        db,
        "SELECT shift_id, verdict, duplicate_source, box_id FROM floor_scans ORDER BY rowid",
      ),
    ).toEqual([
      { shift_id: SHIFT_ID, verdict: "ok", duplicate_source: null, box_id: expect.any(String) },
      { shift_id: SECOND_SHIFT, verdict: "wrong_gtin", duplicate_source: null, box_id: null },
    ]);
  });

  it("finds a code the station took in another shift, and opens no box for the repeat", async () => {
    const { db, local, shift } = await station();
    const ids = () => crypto.randomUUID();
    await processScan(scanContext(local, shift, { newId: ids }), km("S1"));
    const second: WorkShift = { ...shift, copy: { ...shift.copy, id: SECOND_SHIFT } };
    await expect(
      processScan(scanContext(local, second, { newId: ids }), km("S1")),
    ).resolves.toEqual({
      kind: "duplicate",
      source: "local",
      firstScannedAt: "2026-10-08T06:15:00.000Z",
      scannedAt: "2026-10-08T06:15:00.000Z",
      code: { gtin14: GTIN, serial: "S1" },
    });
    expect(rows(db, "SELECT shift_id, verdict FROM floor_scans ORDER BY rowid")).toEqual([
      { shift_id: SHIFT_ID, verdict: "ok" },
      { shift_id: SECOND_SHIFT, verdict: "duplicate" },
    ]);
    expect(rows(db, "SELECT shift_id FROM floor_boxes")).toEqual([{ shift_id: SHIFT_ID }]);
    expect(rows(db, "SELECT shift_id FROM floor_codes")).toEqual([{ shift_id: SHIFT_ID }]);
    const payloads = rows(db, "SELECT shift_id, payload FROM outbox ORDER BY seq");
    expect(payloads.map((row) => row["shift_id"])).toEqual([SHIFT_ID, SECOND_SHIFT]);
    expect(JSON.parse(String(payloads[1]?.["payload"]))).toMatchObject({
      shiftId: SECOND_SHIFT,
      data: { verdict: "duplicate", duplicateSource: "local", boxId: null },
    });
  });

  it("does not take another pairing's rows for its own: codes and boxes kept by a forget", async () => {
    const { db, local, shift } = await station();
    const raw = km("Z1");
    const hash = codeHashOf(raw);
    // What an earlier pairing, on another device and on another host, left behind.
    for (const [host, device] of [
      [PAIRING.hostId, OTHER_DEVICE],
      [OTHER_HOST, PAIRING.deviceId],
    ] as const) {
      db.prepare(
        "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, " +
          "scanned_at) VALUES (?, ?, ?, ?, 'old-box', 'old-scan', '2026-10-01T06:00:00.000Z')",
      ).run(host, device, hash, SHIFT_ID);
      db.prepare(
        "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, item_count) " +
          `VALUES ('old-${device.slice(0, 4)}', ?, ?, ?, '2026-10-01T06:00:00.000Z', 9)`,
      ).run(host, device, SHIFT_ID);
    }
    const checkCode = vi.fn(async (): Promise<CodeCheck> => ({ status: "free" }));
    const context = scanContext(local, shift, { online: () => true, checkCode });
    const boxId = "00000000-0000-4000-8000-000000000002";
    await expect(processScan(context, raw)).resolves.toEqual({
      kind: "accepted",
      boxId,
      itemCount: 1,
      scannedAt: "2026-10-08T06:15:00.000Z",
      code: { gtin14: GTIN, serial: "Z1" },
    });
    expect(checkCode).toHaveBeenCalledTimes(1);
    expect(
      rows(db, `SELECT host_id, device_id, item_count FROM floor_boxes WHERE id = '${boxId}'`),
    ).toEqual([{ host_id: PAIRING.hostId, device_id: PAIRING.deviceId, item_count: 1 }]);
    expect(
      rows(db, "SELECT item_count FROM floor_boxes WHERE id LIKE 'old-%' ORDER BY item_count"),
    ).toEqual([{ item_count: 9 }, { item_count: 9 }]);
  });

  it("goes on in the open box, not in a closed one, and opens a new box after a closed one", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift, { newId: () => crypto.randomUUID() });
    const first = await processScan(context, km("X1"));
    db.prepare(
      "UPDATE floor_boxes SET closed_at = '2026-10-08T06:20:00.000Z', sscc = ?, " +
        "block_id = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a', serial = 1500",
    ).run(buildSscc(0, PREFIX, 1500));
    const next = await processScan(context, km("X2"));
    expect(next).toMatchObject({ kind: "accepted", itemCount: 1 });
    expect(
      next.kind === "accepted" && first.kind === "accepted" && next.boxId !== first.boxId,
    ).toBe(true);
    expect(
      rows(db, "SELECT item_count, closed_at IS NULL AS open FROM floor_boxes ORDER BY opened_at"),
    ).toEqual([
      { item_count: 1, open: 0 },
      { item_count: 1, open: 1 },
    ]);
  });
});

describe("a scan while the host may not answer", () => {
  const free = async (): Promise<CodeCheck> => ({ status: "free" });

  it("asks once per scan, after the station's own check, with the hash the domain gives", async () => {
    const { local, shift } = await station();
    const checkCode = vi.fn(free);
    let online = true;
    const context = scanContext(local, shift, {
      online: () => online,
      checkCode,
      newId: () => crypto.randomUUID(),
    });
    await processScan(context, km("Q1"));
    await processScan(context, km("Q2"));
    expect(checkCode.mock.calls).toEqual([[codeHashOf(km("Q1"))], [codeHashOf(km("Q2"))]]);
    // A repeat is the station's own duplicate: the host is not asked again.
    await processScan(context, km("Q1", { tail: "bm90aGVy" }));
    expect(checkCode).toHaveBeenCalledTimes(2);
    // The link is read at every scan: it dropped, the next one is taken without the host.
    online = false;
    await expect(processScan(context, km("Q3"))).resolves.toMatchObject({ kind: "accepted" });
    expect(checkCode).toHaveBeenCalledTimes(2);
  });

  it("takes the code, asks nobody, and reports nothing when the host says free or owns it itself", async () => {
    const { local, shift } = await station();
    const onHostError = vi.fn();
    const context = scanContext(local, shift, {
      online: () => true,
      onHostError,
      newId: () => crypto.randomUUID(),
    });
    await expect(processScan(context, km("V1"))).resolves.toMatchObject({ kind: "accepted" });
    await expect(
      processScan(
        {
          ...context,
          checkCode: async () => ({ ...TAKEN, owner: { ...TAKEN.owner, sameDevice: true } }),
        },
        km("V2"),
      ),
    ).resolves.toMatchObject({ kind: "accepted" });
    await expect(
      processScan({ ...context, checkCode: async () => TAKEN }, km("V3")),
    ).resolves.toMatchObject({ kind: "duplicate", source: "host" });
    expect(onHostError).not.toHaveBeenCalled();
  });

  const failures: [string, unknown][] = [
    ...TRANSPORT_CODES.map((code): [string, unknown] => [
      `transport ${code}`,
      new HostError({ kind: "transport", code, message: code }),
    ]),
    [
      "unauthorized",
      new HostError({ kind: "api", code: "unauthorized", message: "no", status: 401 }),
    ],
    ["host fault", new HostError({ kind: "api", code: "internal", message: "no", status: 500 })],
    [
      "protocol",
      new HostError({ kind: "api", code: "protocol_unsupported", message: "no", status: 426 }),
    ],
    ["an answer this build cannot read", new TypeError("not an answer")],
  ];

  it.each(failures)(
    "takes the code and hands the failure on, when the check fails: %s",
    async (_name, failure) => {
      const { db, local, shift } = await station();
      const onHostError = vi.fn();
      const context = scanContext(local, shift, {
        online: () => true,
        checkCode: async () => {
          throw failure;
        },
        onHostError,
      });
      await expect(processScan(context, km("Y1"))).resolves.toMatchObject({
        kind: "accepted",
        itemCount: 1,
      });
      expect(onHostError).toHaveBeenCalledTimes(1);
      expect(onHostError.mock.calls[0]?.[0]).toBe(failure);
      expect(rows(db, "SELECT verdict, duplicate_source FROM floor_scans")).toEqual([
        { verdict: "ok", duplicate_source: null },
      ]);
      expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([
        { n: 1 },
      ]);
    },
  );

  it("queues what it took offline, in order, for the host to settle later", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift, { newId: () => crypto.randomUUID() });
    for (const serial of ["L1", "L2", "L3"]) await processScan(context, km(serial));
    const queued = rows(db, "SELECT payload, acked_at, outcome FROM outbox ORDER BY seq");
    expect(queued.map((row) => JSON.parse(String(row["payload"])).data.code.serial)).toEqual([
      "L1",
      "L2",
      "L3",
    ]);
    expect(queued.every((row) => row["acked_at"] === null && row["outcome"] === null)).toBe(true);
    // A host duplicate the check did not see is the host's later receipt: the
    // scan stays `ok` here until that receipt comes (plan 2a6 Task 6).
    expect(rows(db, "SELECT verdict, conflict FROM floor_scans")).toEqual([
      { verdict: "ok", conflict: 0 },
      { verdict: "ok", conflict: 0 },
      { verdict: "ok", conflict: 0 },
    ]);
  });
});

describe("a scan whose write does not happen", () => {
  it("leaves the code free: the same scan, written later, is taken as new", async () => {
    const { db, local, shift } = await station();
    const raw = km("R1");
    await expect(processScan(scanContext(failingWrites(local), shift), raw)).rejects.toBeInstanceOf(
      LocalDbError,
    );
    expect(everythingStored(db)).not.toContain(codeHashOf(raw));
    await expect(processScan(scanContext(local, shift), raw)).resolves.toMatchObject({
      kind: "accepted",
      itemCount: 1,
    });
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 1 }]);
  });

  it("writes a scan that is not a code with its outbox record in one write too", async () => {
    const { db, local, shift } = await station();
    const taken = "00000000-0000-4000-8000-000000000001";
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES (?, ?, ?, 'scan', ?, '{}', '2026-10-08T06:00:00.000Z')",
    ).run(taken, PAIRING.hostId, PAIRING.deviceId, SHIFT_ID);
    for (const raw of ["MRK-000742", km("U1", { gtin: OTHER_GTIN })]) {
      await expect(processScan(scanContext(local, shift), raw)).rejects.toBeInstanceOf(
        LocalDbError,
      );
    }
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 0 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 1 }]);
  });

  it("writes a duplicate with its outbox record in one write too", async () => {
    const { db, local, shift } = await station();
    await processScan(scanContext(local, shift, { newId: () => crypto.randomUUID() }), km("D9"));
    const taken = "00000000-0000-4000-8000-000000000001";
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES (?, ?, ?, 'scan', ?, '{}', '2026-10-08T06:00:00.000Z')",
    ).run(taken, PAIRING.hostId, PAIRING.deviceId, SHIFT_ID);
    await expect(processScan(scanContext(local, shift), km("D9"))).rejects.toBeInstanceOf(
      LocalDbError,
    );
    expect(rows(db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 1 }]);
  });

  it("takes no scan its record cannot be formed for, and writes nothing", async () => {
    const { db, local, shift } = await station();
    await expect(
      processScan(scanContext(local, shift, { operatorId: "not-a-uuid" }), km("M1")),
    ).rejects.toThrow();
    await expect(
      processScan(scanContext(local, shift, { newId: () => "not-a-uuid" }), km("M1")),
    ).rejects.toThrow();
    for (const table of ["floor_boxes", "floor_codes", "floor_scans", "outbox"]) {
      expect(rows(db, `SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: 0 }]);
    }
  });

  it("keeps the open box and the count when a later scan fails to write", async () => {
    const { db, local, shift } = await station();
    const context = scanContext(local, shift, { newId: () => crypto.randomUUID() });
    await processScan(context, km("C1"));
    await processScan(context, km("C2"));
    await expect(
      processScan(scanContext(failingWrites(local), shift), km("C3")),
    ).rejects.toBeInstanceOf(LocalDbError);
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 2 }]);
  });
});

describe("scans through the work queue", () => {
  it("takes two scans of one code in a row once: the second sees the first", async () => {
    const { db, local, shift } = await station();
    const held = holdingWrites(local);
    const context = scanContext(held.executor, shift, { newId: () => crypto.randomUUID() });
    const queue = createWorkQueue();
    held.holdNext();
    const first = queue.run(() => processScan(context, km("QQ")));
    await held.reached();
    // The second arrives while the first writes: it waits, and reads afterwards.
    const second = queue.run(() => processScan(context, km("QQ", { aim: false })));
    held.release();
    await expect(first).resolves.toMatchObject({ kind: "accepted", itemCount: 1 });
    await expect(second).resolves.toMatchObject({ kind: "duplicate", source: "local" });
    expect(rows(db, "SELECT item_count FROM floor_boxes")).toEqual([{ item_count: 1 }]);
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 1 }]);
    expect(rows(db, "SELECT verdict FROM floor_scans ORDER BY rowid")).toEqual([
      { verdict: "ok" },
      { verdict: "duplicate" },
    ]);
  });

  it("goes on with the scans after one whose write failed, and loses none of them", async () => {
    const { db, local, shift } = await station();
    let broken = true;
    const flaky: LocalExecutor = {
      query: (sql, params, row) => local.query(sql, params, row),
      transaction: (statements) => {
        if (broken) {
          broken = false;
          return Promise.reject(new LocalDbError("statement_failed", "disk is full"));
        }
        return local.transaction(statements);
      },
    };
    const context = scanContext(flaky, shift, { newId: () => crypto.randomUUID() });
    const queue = createWorkQueue();
    const outcomes = [km("F1"), km("F2"), km("F3")].map((raw) =>
      queue.run(() => processScan(context, raw)),
    );
    await expect(outcomes[0]).rejects.toBeInstanceOf(LocalDbError);
    await expect(outcomes[1]).resolves.toMatchObject({ kind: "accepted", itemCount: 1 });
    await expect(outcomes[2]).resolves.toMatchObject({ kind: "accepted", itemCount: 2 });
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 2 }]);
  });
});
