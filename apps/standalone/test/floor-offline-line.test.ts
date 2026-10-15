import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { boxMembershipDigestV1, buildSscc, kmHash, canonicalizeKm } from "@markiro/domain";

import { readStoredWork, type WorkShift } from "../src/floor/shifts/shift-copies.js";
import { createBlockSupply, type BlockContext } from "../src/floor/work/block-supply.js";
import { closeIfFull, closeOpenBox, type BoxContext } from "../src/floor/work/box-close.js";
import { processScan, type ScanContext } from "../src/floor/work/scan-pipeline.js";
import { createWorkQueue } from "../src/floor/work/work-queue.js";
import { HostError } from "../src/host/client.js";
import {
  factRecordSchema,
  type CodeCheck,
  type FactReceipt,
  type FactRecord,
  type SsccBlock,
  type SsccBlockRequest,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { sendFactBatch } from "../src/local/facts-sender.js";
import {
  enteredShift,
  GTIN,
  km,
  OPERATOR_ID,
  OTHER_GTIN,
  PAIRING,
  PREFIX,
  rows,
  seedBlock,
  SHIFT_ID,
  steppingClock,
} from "./support/floor-work.js";
import { openLocalDbFile } from "./support/local-db.js";

/**
 * The whole offline promise of stage 2a, over the real modules and a file
 * database: the host vanishes in the middle of a shift, the line goes on
 * (scans taken and queued, boxes closed with the next serial of the block
 * the station holds, a block asked for and the request kept), the computer
 * restarts more than once, and when the host is back every record reaches
 * it once, in the order it was made, in batches of at most 100, each with
 * its receipt. The fake host is as strict as the real one on what the
 * station must not do: it refuses a batch over 100, it answers a record it
 * has seen before with the receipt it gave, and a block asked for twice
 * under one request id is one block.
 */

/** The host's limit on a batch, as the wire contract states it (not read from the station's constant). */
const WIRE_BATCH_LIMIT = 100;
const BLOCK_ONE = "b10c0001-0000-4000-8000-000000000001";
const BLOCK_TWO = "b10c0002-0000-4000-8000-000000000002";
const WINNER = {
  shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  shiftNumber: "OCT26-003",
  deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
  scannedAt: "2026-10-08T05:58:41.090Z",
  sameDevice: false,
};

function transport(): HostError {
  return new HostError({ kind: "transport", code: "unreachable", message: "host away" });
}

/** What the host keeps of a scan it received, to check a box's digest by. */
interface HostScan {
  boxId: string | null;
  verdict: string;
  codeHash: string | null;
  outcome: FactReceipt["outcome"];
}

/**
 * The host as the station meets it: idempotent by record id and by block
 * request id, strict about the batch size and the schema, and able to
 * vanish or to lose its answers.
 */
class FakeHost {
  /** Every call fails as a host that is not there. */
  away = false;
  /** The next calls of `sendFacts` store their records and fail before they answer. */
  lostAnswers = 0;
  /** The next call of `requestBlock` issues its block and fails before it answers. */
  lostBlockAnswers = 0;
  /** Ids of the records the host answers with a conflict / a rejection. */
  readonly conflicts = new Set<string>();
  readonly rejections = new Set<string>();
  /** The ids of every call of `sendFacts`, failed or not, in order. */
  readonly calls: string[][] = [];
  /** Receipts by record id: a record the host has seen is answered from here. */
  readonly receipts = new Map<string, FactReceipt>();
  /** The order the host first saw its records in. */
  readonly arrival: string[] = [];
  /** How many times a record it had seen was sent again. */
  repeated = 0;
  readonly records = new Map<string, FactRecord>();
  readonly scans: HostScan[] = [];
  /** Per box: the digest the station said, against the one from the scans received. */
  readonly digests = new Map<string, { said: string; computed: string; seen: number }>();
  /** Blocks by request id, and how many requests were asked for. */
  readonly blocks = new Map<string, SsccBlock>();
  readonly blockAsks: SsccBlockRequest[] = [];
  readonly checks: string[] = [];
  /** Every call of `checkCode`, the ones that found the host away included. */
  checkAttempts = 0;
  private readonly pending: Array<[number, number, string]>;

  constructor(blocks: ReadonlyArray<[number, number, string]>) {
    this.pending = [...blocks];
  }

  checkCode = async (codeHash: string): Promise<CodeCheck> => {
    this.checkAttempts += 1;
    if (this.away) throw transport();
    this.checks.push(codeHash);
    return { status: "free" };
  };

  requestBlock = async (request: SsccBlockRequest): Promise<SsccBlock> => {
    if (this.away) throw transport();
    this.blockAsks.push(request);
    let block = this.blocks.get(request.requestId);
    if (block === undefined) {
      const next = this.pending.shift();
      if (next === undefined) throw new Error("the fake host has no block left to issue");
      const [fromSerial, toSerial, id] = next;
      block = {
        id,
        issuerPrefix: request.issuerPrefix,
        extension: request.extension,
        fromSerial,
        toSerial,
      };
      this.blocks.set(request.requestId, block);
    }
    if (this.lostBlockAnswers > 0) {
      this.lostBlockAnswers -= 1;
      throw transport();
    }
    return block;
  };

  sendFacts = async (records: readonly unknown[]): Promise<FactReceipt[]> => {
    const ids = records.map((record) => (record as { id: string }).id);
    this.calls.push(ids);
    if (this.away) throw transport();
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThanOrEqual(WIRE_BATCH_LIMIT);
    const answers = records.map((raw): FactReceipt => {
      const record = factRecordSchema.parse(raw);
      const known = this.receipts.get(record.id);
      if (known !== undefined) {
        this.repeated += 1;
        return known;
      }
      const receipt = this.receive(record);
      this.receipts.set(record.id, receipt);
      this.records.set(record.id, record);
      this.arrival.push(record.id);
      return receipt;
    });
    if (this.lostAnswers > 0) {
      this.lostAnswers -= 1;
      throw transport();
    }
    return answers;
  };

  private receive(record: FactRecord): FactReceipt {
    const outcome: FactReceipt["outcome"] = this.rejections.has(record.id)
      ? "rejected"
      : this.conflicts.has(record.id)
        ? "conflict"
        : "accepted";
    if (record.kind === "scan") {
      this.scans.push({
        boxId: record.data.boxId,
        verdict: record.data.verdict,
        codeHash: record.data.code?.codeHash ?? null,
        outcome,
      });
    }
    if (record.kind === "box_closed") {
      // A box closes after every code in it was received, whatever the host made of each.
      const members = this.scans.filter(
        (scan) => scan.boxId === record.data.boxId && scan.verdict === "ok",
      );
      expect(members.length).toBeGreaterThanOrEqual(record.data.itemCount);
      const live = members.filter((scan) => scan.outcome === "accepted");
      this.digests.set(record.data.boxId, {
        said: record.data.membershipDigest,
        computed: boxMembershipDigestV1(live.map((scan) => scan.codeHash ?? "")),
        seen: members.length,
      });
    }
    if (outcome === "conflict") return { id: record.id, outcome, details: { winner: WINNER } };
    if (outcome === "rejected") return { id: record.id, outcome, code: "unknown_shift" };
    return { id: record.id, outcome };
  }
}

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One start of the application over the station's file. */
interface Boot {
  db: DatabaseSync;
  executor: LocalExecutor;
  shift: WorkShift;
}

async function start(path: string, first: boolean): Promise<Boot> {
  const { db, executor } = openLocalDbFile(path);
  if (first) return { db, executor, shift: await enteredShift(executor) };
  const stored = await readStoredWork(executor, PAIRING, SHIFT_ID);
  if (stored.kind !== "ready") throw new Error(`the shift reads as ${stored.kind} after a restart`);
  return { db, executor, shift: stored.shift };
}

/**
 * The floor's side of the work screen, as the screen drives it: scans one at
 * a time in a queue; a full box is closed before a scan is read and again
 * after it; serials come by the half rule. (The screen's own tests cover the
 * screen: this drives the modules it is built of.)
 */
function floor(boot: Boot, host: FakeHost, link: { online: boolean }, now: () => Date) {
  const newId = () => crypto.randomUUID();
  const box: BoxContext = {
    local: boot.executor,
    pairing: PAIRING,
    shift: boot.shift,
    operatorId: OPERATOR_ID,
    now,
    newId,
  };
  const scanContext: ScanContext = {
    ...box,
    online: () => link.online,
    checkCode: host.checkCode,
    onHostError: () => undefined,
  };
  const blockContext: BlockContext = {
    local: boot.executor,
    pairing: PAIRING,
    issuerPrefix: PREFIX,
    mode: "aggregation",
    online: () => link.online,
    requestBlock: host.requestBlock,
    onHostError: () => undefined,
    now,
    newId,
  };
  const queue = createWorkQueue();
  const supply = createBlockSupply(blockContext);
  return {
    box,
    supply,
    /** A scan the way the screen's job takes it. */
    scan: (raw: string) =>
      queue.run(async () => {
        const before = await closeIfFull(box);
        if (before !== null && before.kind !== "closed")
          return { before, outcome: null, after: null };
        const outcome = await processScan(scanContext, raw);
        const after = await closeIfFull(box);
        return { before, outcome, after };
      }),
    /** The operator confirms an incomplete box. */
    closeNow: () => queue.run(() => closeOpenBox(box)),
    /** The screen opens: a box left full is closed first. */
    enter: () => queue.run(() => closeIfFull(box)),
  };
}

/** The `n`th code of the product, serial `S001` and on. */
function code(n: number): string {
  return km(`S${String(n).padStart(3, "0")}`);
}

function outbox(db: DatabaseSync) {
  return rows(
    db,
    "SELECT seq, id, kind, outcome, outcome_code, attempts, acked_at, payload FROM outbox ORDER BY seq",
  );
}

describe("the line that loses its host and gets it back", () => {
  it("takes the scans, closes the boxes, asks for serials and sends everything once, in order, whatever restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markiro-offline-line-"));
    temporary.push(dir);
    const path = join(dir, "station.db");
    const host = new FakeHost([[2000, 2005, BLOCK_TWO]]);
    const link = { online: true };
    // One clock for every start of the application: time does not go back on a restart.
    const now = steppingClock();

    // ---- Boot 1: the host is there, the station holds one block of six serials.
    let boot = await start(path, true);
    seedBlock(boot.db, { blockId: BLOCK_ONE, from: 100, to: 105 });
    let line = floor(boot, host, link, now);
    let serial = 0;
    const nextCode = () => {
      serial += 1;
      return code(serial);
    };
    for (let index = 0; index < 12; index += 1) await line.scan(nextCode());
    // Online, every accepted code was asked of the host first.
    expect(host.checks).toHaveLength(12);
    expect(rows(boot.db, "SELECT sscc, serial, item_count FROM floor_boxes")).toEqual([
      { sscc: buildSscc(0, PREFIX, 100), serial: 100, item_count: 12 },
    ]);
    // The first records reach the host while it is there: 12 scans and the box.
    await expect(sendFactBatch(boot.executor, PAIRING, host.sendFacts, now)).resolves.toEqual({
      sent: 13,
      more: false,
    });
    expect(rows(boot.db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([
      { n: 0 },
    ]);
    const delivered = host.arrival.slice();
    expect(delivered).toHaveLength(13);

    // ---- The host vanishes. The line goes on: boxes 2 to 6 take the block's serials.
    host.away = true;
    link.online = false;
    const firstCode = code(1);
    let extras = 0;
    for (let box = 2; box <= 6; box += 1) {
      for (let index = 0; index < 12; index += 1) {
        await line.scan(nextCode());
        if (box === 2 && index === 3) {
          // A code taken already is a local duplicate, a code of another product
          // is wrong, and a badge is nothing the record keeps.
          const duplicate = await line.scan(firstCode);
          expect(duplicate.outcome).toMatchObject({ kind: "duplicate", source: "local" });
          const wrong = await line.scan(km("W1", { gtin: OTHER_GTIN }));
          expect(wrong.outcome).toMatchObject({ kind: "wrong_gtin" });
          const badge = await line.scan("MRK-000742");
          expect(badge.outcome).toMatchObject({ kind: "invalid", rawKind: "unknown" });
          extras += 3;
        }
      }
    }
    expect(
      rows(boot.db, "SELECT serial FROM floor_boxes WHERE closed_at IS NOT NULL ORDER BY serial"),
    ).toEqual([100, 101, 102, 103, 104, 105].map((value) => ({ serial: value })));
    // The block is spent; the host asked for nothing meanwhile.
    expect(host.blockAsks).toEqual([]);

    // ---- Box 7 fills with no serial left: the close finds none and writes nothing.
    for (let index = 0; index < 12; index += 1) {
      const taken = await line.scan(nextCode());
      if (index === 11) expect(taken.after).toEqual({ kind: "no_serials" });
    }
    expect(
      rows(boot.db, "SELECT item_count, closed_at FROM floor_boxes WHERE closed_at IS NULL"),
    ).toEqual([{ item_count: 12, closed_at: null }]);
    // Offline, the host was asked about no code: only the twelve of the first box.
    expect(host.checkAttempts).toBe(12);
    // The link blinks: the block is asked for, the host issues it, the answer is lost.
    link.online = true;
    host.away = false;
    host.lostBlockAnswers = 1;
    await expect(line.supply.topUp()).resolves.toEqual({ kind: "failed" });
    const kept = rows(
      boot.db,
      "SELECT request_id, issuer_prefix, extension FROM floor_block_requests",
    );
    expect(kept).toHaveLength(1);
    const requestId = String(kept[0]?.["request_id"]);
    expect(host.blockAsks).toEqual([{ requestId, issuerPrefix: PREFIX, extension: 0 }]);

    // ---- The computer restarts with the request stored, the box full and the host away again.
    boot.db.close();
    host.away = true;
    link.online = false;
    boot = await start(path, false);
    line = floor(boot, host, link, now);
    // Offline the screen opens on the full box and still finds no serial.
    await expect(line.enter()).resolves.toEqual({ kind: "no_serials" });
    await expect(line.supply.topUp()).resolves.toEqual({ kind: "offline" });
    expect(rows(boot.db, "SELECT request_id FROM floor_block_requests")).toEqual([
      { request_id: requestId },
    ]);
    // The link is back (for the block, not yet for the facts): the SAME request goes out again.
    host.away = false;
    link.online = true;
    await expect(line.supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_TWO });
    expect(host.blockAsks.map((ask) => ask.requestId)).toEqual([requestId, requestId]);
    expect(host.blocks.size).toBe(1);
    expect(rows(boot.db, "SELECT request_id FROM floor_block_requests")).toEqual([]);
    expect(
      rows(
        boot.db,
        "SELECT block_id, from_serial, to_serial, next_serial FROM floor_sscc_blocks ORDER BY from_serial",
      ),
    ).toEqual([
      { block_id: BLOCK_ONE, from_serial: 100, to_serial: 105, next_serial: 106 },
      { block_id: BLOCK_TWO, from_serial: 2000, to_serial: 2005, next_serial: 2000 },
    ]);
    // The screen's entry closes the box a stopped station left full, with the block's first serial.
    const entry = await line.enter();
    expect(entry).toMatchObject({ kind: "closed", box: { serial: 2000, itemCount: 12 } });

    // ---- Boxes 8 to 10 close on the new block; box 11 stays incomplete until the operator confirms.
    for (let box = 8; box <= 10; box += 1) {
      for (let index = 0; index < 12; index += 1) await line.scan(nextCode());
    }
    for (let index = 0; index < 5; index += 1) await line.scan(nextCode());
    const partial = await line.closeNow();
    expect(partial).toMatchObject({ kind: "closed", box: { serial: 2004, itemCount: 5 } });
    expect(
      rows(boot.db, "SELECT serial FROM floor_boxes WHERE closed_at IS NOT NULL ORDER BY serial"),
    ).toEqual(
      [100, 101, 102, 103, 104, 105, 2000, 2001, 2002, 2003, 2004].map((value) => ({
        serial: value,
      })),
    );
    expect(
      rows(boot.db, "SELECT block_id, next_serial FROM floor_sscc_blocks ORDER BY from_serial"),
    ).toEqual([
      { block_id: BLOCK_ONE, next_serial: 106 },
      { block_id: BLOCK_TWO, next_serial: 2005 },
    ]);

    // ---- What the station holds: every accepted code once, every refusal journalled.
    const unsent = outbox(boot.db).filter((row) => row["acked_at"] === null);
    // 125 codes taken + 3 refusals + 10 closed boxes; the first 13 records were delivered.
    expect(serial).toBe(125);
    expect(outbox(boot.db)).toHaveLength(13 + unsent.length);
    expect(rows(boot.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'scan'")[0]?.["n"]).toBe(
      125 + extras,
    );
    expect(
      rows(boot.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'box_closed'")[0]?.["n"],
    ).toBe(11);
    expect(rows(boot.db, "SELECT count(*) AS n FROM floor_codes")[0]?.["n"]).toBe(125);
    expect(rows(boot.db, "SELECT sum(item_count) AS n FROM floor_boxes")[0]?.["n"]).toBe(125);
    // A badge is no text of any record or journal row.
    expect(JSON.stringify(outbox(boot.db))).not.toContain("MRK-000742");
    expect(JSON.stringify(rows(boot.db, "SELECT * FROM floor_scans"))).not.toContain("MRK-000742");

    // ---- Delivery. Which records the host will refuse and contest is fixed now.
    const scanIds = unsent.filter((row) => row["kind"] === "scan").map((row) => String(row["id"]));
    const conflicting = scanIds[20] ?? "";
    const rejected = scanIds[40] ?? "";
    host.conflicts.add(conflicting);
    host.rejections.add(rejected);
    const conflictBox = rows(
      boot.db,
      "SELECT box_id FROM floor_scans WHERE id = ?",
      conflicting,
    )[0]?.["box_id"];
    const rejectedBox = rows(boot.db, "SELECT box_id FROM floor_scans WHERE id = ?", rejected)[0]?.[
      "box_id"
    ];
    expect(typeof conflictBox).toBe("string");

    // The host is away: the head batch is counted and kept, nothing is acknowledged.
    host.away = true;
    const head = unsent.slice(0, WIRE_BATCH_LIMIT).map((row) => String(row["id"]));
    await expect(sendFactBatch(boot.executor, PAIRING, host.sendFacts, now)).rejects.toThrow(
      "host away",
    );
    expect(host.calls.at(-1)).toEqual(head);
    expect(rows(boot.db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([
      { n: unsent.length },
    ]);
    expect(
      rows(
        boot.db,
        "SELECT id FROM outbox WHERE attempts = 1 AND acked_at IS NULL ORDER BY seq",
      ).map((row) => row["id"]),
    ).toEqual(head);

    // The host takes the batch and its answer is lost; the computer restarts meanwhile.
    host.away = false;
    host.lostAnswers = 1;
    await expect(sendFactBatch(boot.executor, PAIRING, host.sendFacts, now)).rejects.toThrow(
      "host away",
    );
    expect(host.arrival.slice(13)).toEqual(head);
    boot.db.close();
    boot = await start(path, false);
    expect(rows(boot.db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([
      { n: unsent.length },
    ]);

    // The same batch goes again with the same ids; the host answers from what it kept.
    const first = await sendFactBatch(boot.executor, PAIRING, host.sendFacts, now);
    expect(first).toEqual({ sent: WIRE_BATCH_LIMIT, more: true });
    expect(host.calls.at(-1)).toEqual(head);
    expect(host.repeated).toBe(WIRE_BATCH_LIMIT);
    expect(
      rows(boot.db, "SELECT attempts FROM outbox WHERE id = ?", head[0] ?? "")[0]?.["attempts"],
    ).toBe(3);

    // The computer restarts once more between the batches: the rest follows, in order.
    boot.db.close();
    boot = await start(path, false);
    const second = await sendFactBatch(boot.executor, PAIRING, host.sendFacts, now);
    expect(second).toEqual({ sent: unsent.length - WIRE_BATCH_LIMIT, more: false });
    await expect(sendFactBatch(boot.executor, PAIRING, host.sendFacts, now)).resolves.toEqual({
      sent: 0,
      more: false,
    });

    // ---- Nothing lost, nothing sent twice, nothing out of order.
    const all = outbox(boot.db);
    const allIds = all.map((row) => String(row["id"]));
    expect(host.arrival).toEqual(allIds);
    expect(new Set(host.arrival).size).toBe(host.arrival.length);
    expect(host.calls.every((ids) => ids.length <= WIRE_BATCH_LIMIT)).toBe(true);
    expect(host.calls.map((ids) => ids.length)).toEqual([
      13,
      WIRE_BATCH_LIMIT,
      WIRE_BATCH_LIMIT,
      WIRE_BATCH_LIMIT,
      unsent.length - WIRE_BATCH_LIMIT,
    ]);
    // Only the batch whose answer was lost was seen twice.
    expect(host.repeated).toBe(WIRE_BATCH_LIMIT);
    expect(all.every((row) => row["acked_at"] !== null)).toBe(true);
    expect(all.filter((row) => row["attempts"] === 1).length).toBe(
      13 + (unsent.length - WIRE_BATCH_LIMIT),
    );
    const outcomes: Record<string, number> = {};
    for (const row of all) {
      const key = String(row["outcome"]);
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    }
    expect(outcomes).toEqual({ accepted: all.length - 2, conflict: 1, rejected: 1 });
    expect(rows(boot.db, "SELECT outcome_code FROM outbox WHERE id = ?", rejected)).toEqual([
      { outcome_code: "unknown_shift" },
    ]);

    // The receipts left their marks: the contested scan and its box, nothing for the refused scan.
    expect(rows(boot.db, "SELECT id FROM floor_scans WHERE conflict = 1")).toEqual([
      { id: conflicting },
    ]);
    expect(rows(boot.db, "SELECT id FROM floor_boxes WHERE needs_fix = 1")).toEqual([
      { id: conflictBox },
    ]);

    // The host's own count of every box agrees with the station's, except where it
    // refused or contested a code (those two boxes, and only those).
    const mismatched = [...host.digests]
      .filter(([, digest]) => digest.said !== digest.computed)
      .map(([boxId]) => boxId)
      .sort();
    expect([conflictBox, rejectedBox].map(String).sort()).toEqual(mismatched);
    expect(host.digests.size).toBe(11);
    for (const [boxId, digest] of host.digests) {
      const held = rows(boot.db, "SELECT item_count FROM floor_boxes WHERE id = ?", boxId)[0];
      expect(digest.seen).toBe(held?.["item_count"]);
    }
    // And each box's digest on the station is the digest of the codes it holds.
    for (const row of rows(boot.db, "SELECT id FROM floor_boxes")) {
      const hashes = rows(
        boot.db,
        "SELECT code_hash FROM floor_codes WHERE box_id = ?",
        String(row["id"]),
      );
      const record = [...host.records.values()].find(
        (candidate) => candidate.kind === "box_closed" && candidate.data.boxId === row["id"],
      );
      expect(record?.kind === "box_closed" ? record.data.membershipDigest : null).toBe(
        boxMembershipDigestV1(hashes.map((hash) => String(hash["code_hash"]))),
      );
    }
    // The hash of a code is the domain's, and the host was handed the canonical text.
    const sample = [...host.records.values()].find(
      (record) => record.kind === "scan" && record.data.code !== null,
    );
    if (sample?.kind !== "scan" || sample.data.code === null) throw new Error("no scan sent");
    expect(kmHash(canonicalizeKm(sample.data.code.canonical))).toBe(sample.data.code.codeHash);
    expect(sample.data.code.gtin14).toBe(GTIN);
    boot.db.close();
  });
});
