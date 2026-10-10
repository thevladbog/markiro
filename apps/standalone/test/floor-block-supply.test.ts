import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBlockSupply,
  remainingSerials,
  type BlockContext,
} from "../src/floor/work/block-supply.js";
import { closeOpenBox } from "../src/floor/work/box-close.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
import { HostError } from "../src/host/client.js";
import type { SsccBlock, SsccBlockRequest } from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import {
  countingIds,
  enteredShift,
  km,
  PAIRING,
  PREFIX,
  rows,
  scanContext,
  seedBlock,
  steppingClock,
} from "./support/floor-work.js";
import { openLocalDb, openLocalDbFile } from "./support/local-db.js";

const BLOCK_ID = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const FIRST_REQUEST = "00000000-0000-4000-8000-000000000001";
const SECOND_REQUEST = "00000000-0000-4000-8000-000000000002";

function blockFor(request: SsccBlockRequest, fromSerial = 3500): SsccBlock {
  return {
    id: BLOCK_ID,
    issuerPrefix: request.issuerPrefix,
    extension: request.extension,
    fromSerial,
    toSerial: fromSerial + 1999,
  };
}

function supplyContext(local: LocalExecutor, overrides: Partial<BlockContext> = {}): BlockContext {
  return {
    local,
    pairing: PAIRING,
    issuerPrefix: PREFIX,
    online: () => true,
    requestBlock: vi.fn(async (request: SsccBlockRequest) => blockFor(request)),
    onHostError: vi.fn(),
    now: steppingClock(),
    newId: countingIds(),
    ...overrides,
  };
}

function requests(db: DatabaseSync) {
  return rows(db, "SELECT request_id, issuer_prefix, extension FROM floor_block_requests");
}

function refusal(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 400, message: code, details });
}

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the supply of SSCC serials", () => {
  it("asks for a block when it has none, keeping the request before it asks and the block with its removal", async () => {
    const { db, executor } = openLocalDb();
    const kept: Record<string, unknown>[][] = [];
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => {
      kept.push(requests(db));
      return blockFor(request);
    });
    const supply = createBlockSupply(supplyContext(executor, { requestBlock }));
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(requestBlock.mock.calls).toEqual([
      [{ requestId: FIRST_REQUEST, issuerPrefix: PREFIX, extension: 0 }],
    ]);
    expect(kept).toEqual([[{ request_id: FIRST_REQUEST, issuer_prefix: PREFIX, extension: 0 }]]);
    expect(requests(db)).toEqual([]);
    expect(
      rows(
        db,
        "SELECT block_id, issuer_prefix, extension, from_serial, to_serial, next_serial FROM floor_sscc_blocks",
      ),
    ).toEqual([
      {
        block_id: BLOCK_ID,
        issuer_prefix: PREFIX,
        extension: 0,
        from_serial: 3500,
        to_serial: 5499,
        next_serial: 3500,
      },
    ]);
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(2000);
  });

  it("asks once the newest block has less than half left, and not at half", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b", from: 1, to: 2000, next: 1 });
    seedBlock(db, {
      blockId: "7f6e5d4c-3b2a-4f1e-8d9c-8b7a6f5e4d3c",
      from: 2001,
      to: 4000,
      next: 3001,
    });
    // The host's next block follows the two kept (the plan's 3500 lies inside the second).
    const context = supplyContext(executor, {
      requestBlock: vi.fn(async (request: SsccBlockRequest) => blockFor(request, 4001)),
    });
    const supply = createBlockSupply(context);
    await expect(supply.topUp()).resolves.toEqual({ kind: "enough" });
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 3002 WHERE from_serial = 2001").run();
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(context.requestBlock).toHaveBeenCalledTimes(1);
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(2000 + 999 + 2000);
  });

  it("counts the serials of this pairing's blocks of the prefix and extension only", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b", from: 1, to: 10, next: 4 });
    seedBlock(db, { blockId: "7f6e5d4c-3b2a-4f1e-8d9c-8b7a6f5e4d3c", from: 11, to: 20, next: 21 });
    seedBlock(db, {
      blockId: "8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d",
      from: 0,
      to: 99,
      extension: 1,
    });
    seedBlock(db, {
      blockId: "9b8c7d6e-5f4a-4b3c-9d2e-1f0a9b8c7d6e",
      from: 0,
      to: 99,
      prefix: "460068201",
    });
    seedBlock(db, {
      blockId: "0c9d8e7f-6a5b-4c4d-8e3f-2a1b0c9d8e7f",
      from: 0,
      to: 99,
      deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f",
    });
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(7);
  });

  it("asks nothing while offline, and keeps no request for it", async () => {
    const { db, executor } = openLocalDb();
    const context = supplyContext(executor, { online: () => false });
    await expect(createBlockSupply(context).topUp()).resolves.toEqual({ kind: "offline" });
    expect(context.requestBlock).not.toHaveBeenCalled();
    expect(requests(db)).toEqual([]);
  });

  it("repeats the same request after a failure, even when no block is wanted any more", async () => {
    const { db, executor } = openLocalDb();
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const requestBlock = vi
      .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
      .mockRejectedValueOnce(down)
      .mockImplementation(async (request) => blockFor(request));
    const context = supplyContext(executor, { requestBlock });
    const supply = createBlockSupply(context);
    await expect(supply.topUp()).resolves.toEqual({ kind: "failed" });
    expect(context.onHostError).toHaveBeenCalledWith(down);
    expect(requests(db)).toEqual([
      { request_id: FIRST_REQUEST, issuer_prefix: PREFIX, extension: 0 },
    ]);
    seedBlock(db, { blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b", from: 1, to: 2000 });
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(requestBlock.mock.calls.map(([request]) => request.requestId)).toEqual([
      FIRST_REQUEST,
      FIRST_REQUEST,
    ]);
    expect(requests(db)).toEqual([]);
  });

  it("repeats the same request after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markiro-supply-"));
    temporary.push(dir);
    const path = join(dir, "station.db");
    const before = openLocalDbFile(path);
    const lost = vi.fn(async (): Promise<SsccBlock> => {
      throw new HostError({ kind: "transport", code: "unreachable", message: "down" });
    });
    await createBlockSupply(supplyContext(before.executor, { requestBlock: lost })).topUp();
    before.db.close();
    const after = openLocalDbFile(path);
    const context = supplyContext(after.executor, { newId: () => crypto.randomUUID() });
    await expect(createBlockSupply(context).topUp()).resolves.toMatchObject({ kind: "stored" });
    expect(context.requestBlock).toHaveBeenCalledWith({
      requestId: FIRST_REQUEST,
      issuerPrefix: PREFIX,
      extension: 0,
    });
    after.db.close();
  });

  it("drops a request the host refuses as another prefix's and sends a new one, once", async () => {
    const { db, executor } = openLocalDb();
    const requestBlock = vi
      .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
      .mockRejectedValueOnce(refusal("validation_failed", { field: "requestId" }))
      .mockImplementation(async (request) => blockFor(request));
    const supply = createBlockSupply(supplyContext(executor, { requestBlock }));
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(requestBlock.mock.calls.map(([request]) => request.requestId)).toEqual([
      FIRST_REQUEST,
      SECOND_REQUEST,
    ]);
    expect(requests(db)).toEqual([]);
    // Refuses every request twice over, then answers: a top-up that asked
    // again and again would end with a block instead of hanging.
    const refusing = vi
      .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
      .mockRejectedValueOnce(refusal("validation_failed", { field: "requestId" }))
      .mockRejectedValueOnce(refusal("validation_failed", { field: "requestId" }))
      .mockImplementation(async (request) => blockFor(request));
    db.prepare("DELETE FROM floor_sscc_blocks").run();
    await expect(
      createBlockSupply(supplyContext(executor, { requestBlock: refusing })).topUp(),
    ).resolves.toEqual({ kind: "failed" });
    expect(refusing).toHaveBeenCalledTimes(2);
    expect(requests(db)).toEqual([]);
  });

  it("drops the request when the host has no serials left for the prefix", async () => {
    const { db, executor } = openLocalDb();
    const requestBlock = vi.fn(async (): Promise<SsccBlock> => {
      throw new HostError({
        kind: "api",
        code: "sscc_exhausted",
        status: 409,
        message: "exhausted",
        details: { issuerPrefix: PREFIX, extension: 0 },
      });
    });
    await expect(
      createBlockSupply(supplyContext(executor, { requestBlock })).topUp(),
    ).resolves.toEqual({ kind: "exhausted" });
    expect(requests(db)).toEqual([]);
  });

  it("keeps no block of another prefix or extension than it asked for", async () => {
    const { db, executor } = openLocalDb();
    for (const other of [
      (request: SsccBlockRequest) => ({ ...blockFor(request), issuerPrefix: "460068201" }),
      (request: SsccBlockRequest) => ({ ...blockFor(request), extension: 1 }),
      (request: SsccBlockRequest) => ({ ...blockFor(request), toSerial: 3499 }),
    ]) {
      const supply = createBlockSupply(
        supplyContext(executor, {
          requestBlock: async (request) => other(request),
          newId: () => crypto.randomUUID(),
        }),
      );
      await expect(supply.topUp()).resolves.toEqual({ kind: "failed" });
    }
    expect(rows(db, "SELECT count(*) AS n FROM floor_sscc_blocks")).toEqual([{ n: 0 }]);
    expect(requests(db)).toEqual([]);
  });

  it("hands a refused key to the shell", async () => {
    const { executor } = openLocalDb();
    const refused = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const context = supplyContext(executor, {
      requestBlock: async () => {
        throw refused;
      },
    });
    await expect(createBlockSupply(context).topUp()).resolves.toEqual({ kind: "failed" });
    expect(context.onHostError).toHaveBeenCalledWith(refused);
  });

  it("runs one top-up at a time: a second call while one runs shares it", async () => {
    const { db, executor } = openLocalDb();
    let answer: () => void = () => undefined;
    const requestBlock = vi.fn(
      (request: SsccBlockRequest) =>
        new Promise<SsccBlock>((resolve) => {
          answer = () => resolve(blockFor(request));
        }),
    );
    const supply = createBlockSupply(supplyContext(executor, { requestBlock }));
    const first = supply.topUp();
    const second = supply.topUp();
    await vi.waitFor(() => expect(requestBlock).toHaveBeenCalledTimes(1));
    answer();
    await expect(first).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    await expect(second).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(requestBlock).toHaveBeenCalledTimes(1);
    expect(rows(db, "SELECT count(*) AS n FROM floor_sscc_blocks")).toEqual([{ n: 1 }]);
    await expect(supply.topUp()).resolves.toEqual({ kind: "enough" });
  });
});

const OLD_BLOCK = "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b";
const NEWER_BLOCK = "7f6e5d4c-3b2a-4f1e-8d9c-8b7a6f5e4d3c";
const OTHER_HOST = "6e5d4c3b-2a19-4f8e-9d7c-0b1a2c3d4e5f";
const OTHER_DEVICE = "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f";
const THIRD_REQUEST = "00000000-0000-4000-8000-000000000003";

interface SeededRequest {
  id: string;
  at?: string;
  prefix?: string;
  extension?: number;
  hostId?: string;
  deviceId?: string;
}

/** A request this station kept before it asked, as `keepRequest` writes one. */
function seedRequest(db: DatabaseSync, request: SeededRequest): void {
  db.prepare(
    "INSERT INTO floor_block_requests (request_id, host_id, device_id, issuer_prefix, " +
      "extension, requested_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    request.id,
    request.hostId ?? PAIRING.hostId,
    request.deviceId ?? PAIRING.deviceId,
    request.prefix ?? PREFIX,
    request.extension ?? 0,
    request.at ?? "2026-10-08T06:00:00.000Z",
  );
}

const foreign: [string, Partial<Parameters<typeof seedBlock>[1]>][] = [
  ["prefix", { prefix: "460068201" }],
  ["extension", { extension: 1 }],
  ["device", { deviceId: OTHER_DEVICE }],
  ["host", { hostId: OTHER_HOST }],
];

function blocks(db: DatabaseSync) {
  return rows(
    db,
    "SELECT block_id, from_serial, to_serial, next_serial FROM floor_sscc_blocks ORDER BY from_serial",
  );
}

/** An executor whose transactions that write `match` fail, as a full disk does, until `heal()`. */
function breakingOn(local: LocalExecutor, match: RegExp) {
  let broken = true;
  const executor: LocalExecutor = {
    query: (sql, params, row) => local.query(sql, params, row),
    transaction: async (statements) => {
      if (broken && statements.some((statement) => match.test(statement.sql))) {
        throw new LocalDbError("statement_failed", "database or disk is full");
      }
      return local.transaction(statements);
    },
  };
  return {
    executor,
    heal: () => {
      broken = false;
    },
  };
}

describe("the half rule at its edges", () => {
  it("asks at less than half of an odd-sized block and not at more", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: OLD_BLOCK, from: 1, to: 7, next: 4 });
    const context = supplyContext(executor);
    const supply = createBlockSupply(context);
    // 4 of 7 left: more than half.
    await expect(supply.topUp()).resolves.toEqual({ kind: "enough" });
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 5").run();
    // 3 of 7 left: less than half.
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(context.requestBlock).toHaveBeenCalledTimes(1);
  });

  it("asks only when the last serial of a one-serial block is gone", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: OLD_BLOCK, from: 1, to: 1, next: 1 });
    const supply = createBlockSupply(supplyContext(executor));
    await expect(supply.topUp()).resolves.toEqual({ kind: "enough" });
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 2").run();
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
  });

  it("asks when the newest block is used up, with an older one still holding serials", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: OLD_BLOCK, from: 1, to: 2000, next: 500 });
    seedBlock(db, { blockId: NEWER_BLOCK, from: 2001, to: 4000, next: 4001 });
    const later = supplyContext(executor, {
      requestBlock: async (request) => blockFor(request, 4001),
    });
    await expect(createBlockSupply(later).topUp()).resolves.toEqual({
      kind: "stored",
      blockId: BLOCK_ID,
    });
    // Nothing of the older block is given up.
    expect(blocks(db)).toEqual([
      { block_id: OLD_BLOCK, from_serial: 1, to_serial: 2000, next_serial: 500 },
      { block_id: NEWER_BLOCK, from_serial: 2001, to_serial: 4000, next_serial: 4001 },
      { block_id: BLOCK_ID, from_serial: 4001, to_serial: 6000, next_serial: 4001 },
    ]);
  });

  it("judges the block with the greatest first serial, whatever the order it was received or written in", async () => {
    const { db, executor } = openLocalDb();
    // The newest by serial is nearly used and was received first and written first.
    seedBlock(db, {
      blockId: NEWER_BLOCK,
      from: 2001,
      to: 4000,
      next: 3990,
      receivedAt: "2026-10-08T05:00:00.000Z",
    });
    seedBlock(db, {
      blockId: OLD_BLOCK,
      from: 1,
      to: 2000,
      receivedAt: "2026-10-08T07:00:00.000Z",
    });
    const context = supplyContext(executor, {
      requestBlock: async (request) => blockFor(request, 4001),
    });
    await expect(createBlockSupply(context).topUp()).resolves.toMatchObject({ kind: "stored" });
  });

  it.each(foreign)(
    "does not take a newer block of another %s for the newest of its own",
    async (_name, other) => {
      const { db, executor } = openLocalDb();
      seedBlock(db, { blockId: OLD_BLOCK, from: 1, to: 2000 });
      seedBlock(db, { blockId: NEWER_BLOCK, from: 2001, to: 4000, next: 3999, ...other });
      const context = supplyContext(executor);
      await expect(createBlockSupply(context).topUp()).resolves.toEqual({ kind: "enough" });
      expect(context.requestBlock).not.toHaveBeenCalled();
    },
  );

  it.each(foreign)(
    "does not take a newer, full block of another %s for serials of its own",
    async (_name, other) => {
      const { db, executor } = openLocalDb();
      seedBlock(db, { blockId: OLD_BLOCK, from: 1, to: 2000, next: 1990 });
      seedBlock(db, { blockId: NEWER_BLOCK, from: 2001, to: 4000, ...other });
      await expect(createBlockSupply(supplyContext(executor)).topUp()).resolves.toMatchObject({
        kind: "stored",
      });
    },
  );

  it("counts no serial where there is no block, and the serials of an extension on request", async () => {
    const { db, executor } = openLocalDb();
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(0);
    seedBlock(db, { blockId: OLD_BLOCK, from: 0, to: 99, extension: 1, next: 90 });
    seedBlock(db, { blockId: NEWER_BLOCK, from: 0, to: 99, hostId: OTHER_HOST });
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(0);
    await expect(remainingSerials(executor, PAIRING, PREFIX, 1)).resolves.toBe(10);
  });
});

describe("a request that waits", () => {
  it("is not sent while offline, and stays; and nothing is wanted while offline with serials enough", async () => {
    const { db, executor } = openLocalDb();
    seedRequest(db, { id: FIRST_REQUEST });
    const context = supplyContext(executor, { online: () => false });
    await expect(createBlockSupply(context).topUp()).resolves.toEqual({ kind: "offline" });
    expect(context.requestBlock).not.toHaveBeenCalled();
    expect(requests(db)).toEqual([
      { request_id: FIRST_REQUEST, issuer_prefix: PREFIX, extension: 0 },
    ]);
    const plenty = openLocalDb();
    seedBlock(plenty.db, { blockId: OLD_BLOCK, from: 1, to: 2000 });
    await expect(
      createBlockSupply(supplyContext(plenty.executor, { online: () => false })).topUp(),
    ).resolves.toEqual({ kind: "enough" });
  });

  it("is the one sent when a block is wanted, and no second request is made beside it", async () => {
    const { db, executor } = openLocalDb();
    seedRequest(db, { id: FIRST_REQUEST });
    const newId = vi.fn(countingIds());
    const context = supplyContext(executor, { newId });
    await expect(createBlockSupply(context).topUp()).resolves.toEqual({
      kind: "stored",
      blockId: BLOCK_ID,
    });
    expect(newId).not.toHaveBeenCalled();
    expect(vi.mocked(context.requestBlock).mock.calls).toEqual([
      [{ requestId: FIRST_REQUEST, issuerPrefix: PREFIX, extension: 0 }],
    ]);
    expect(requests(db)).toEqual([]);
  });

  it("is the oldest of the pending ones, by the time it was kept", async () => {
    const { db, executor } = openLocalDb();
    seedRequest(db, { id: FIRST_REQUEST, at: "2026-10-08T06:10:00.000Z" });
    seedRequest(db, { id: SECOND_REQUEST, at: "2026-10-08T06:05:00.000Z" });
    const context = supplyContext(executor);
    await createBlockSupply(context).topUp();
    expect(vi.mocked(context.requestBlock).mock.calls.map(([sent]) => sent.requestId)).toEqual([
      SECOND_REQUEST,
    ]);
    expect(requests(db)).toEqual([
      { request_id: FIRST_REQUEST, issuer_prefix: PREFIX, extension: 0 },
    ]);
  });

  it("does not take the request of another pairing, prefix or extension for its own", async () => {
    const { db, executor } = openLocalDb();
    seedRequest(db, { id: SECOND_REQUEST, hostId: OTHER_HOST });
    seedRequest(db, { id: THIRD_REQUEST, deviceId: OTHER_DEVICE });
    seedRequest(db, { id: "00000000-0000-4000-8000-000000000004", prefix: "460068201" });
    seedRequest(db, { id: "00000000-0000-4000-8000-000000000005", extension: 1 });
    const context = supplyContext(executor, { newId: () => FIRST_REQUEST });
    await expect(createBlockSupply(context).topUp()).resolves.toMatchObject({ kind: "stored" });
    expect(vi.mocked(context.requestBlock).mock.calls).toEqual([
      [{ requestId: FIRST_REQUEST, issuerPrefix: PREFIX, extension: 0 }],
    ]);
    expect(rows(db, "SELECT request_id FROM floor_block_requests ORDER BY request_id")).toEqual([
      { request_id: SECOND_REQUEST },
      { request_id: THIRD_REQUEST },
      { request_id: "00000000-0000-4000-8000-000000000004" },
      { request_id: "00000000-0000-4000-8000-000000000005" },
    ]);
  });

  it("is kept with the time it was made, and the block with the time it was received, under this pairing", async () => {
    const { db, executor } = openLocalDb();
    const kept: Record<string, unknown>[][] = [];
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => {
      kept.push(
        rows(
          db,
          "SELECT host_id, device_id, requested_at FROM floor_block_requests WHERE request_id = ?",
          request.requestId,
        ),
      );
      return blockFor(request);
    });
    await createBlockSupply(supplyContext(executor, { requestBlock })).topUp();
    expect(kept).toEqual([
      [
        {
          host_id: PAIRING.hostId,
          device_id: PAIRING.deviceId,
          requested_at: "2026-10-08T06:15:00.000Z",
        },
      ],
    ]);
    expect(rows(db, "SELECT host_id, device_id, received_at FROM floor_sscc_blocks")).toEqual([
      {
        host_id: PAIRING.hostId,
        device_id: PAIRING.deviceId,
        received_at: "2026-10-08T06:15:01.000Z",
      },
    ]);
  });
});

describe("the block that comes", () => {
  it("is kept once when the host answers it twice, and its cursor stays where the work left it", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, {
      blockId: BLOCK_ID,
      from: 3500,
      to: 5499,
      next: 3510,
      receivedAt: "2026-10-08T05:00:00.000Z",
    });
    seedRequest(db, { id: FIRST_REQUEST });
    await expect(createBlockSupply(supplyContext(executor)).topUp()).resolves.toEqual({
      kind: "stored",
      blockId: BLOCK_ID,
    });
    expect(blocks(db)).toEqual([
      { block_id: BLOCK_ID, from_serial: 3500, to_serial: 5499, next_serial: 3510 },
    ]);
    expect(rows(db, "SELECT received_at FROM floor_sscc_blocks")).toEqual([
      { received_at: "2026-10-08T05:00:00.000Z" },
    ]);
    expect(requests(db)).toEqual([]);
  });

  it("is kept when it is a single serial", async () => {
    const { db, executor } = openLocalDb();
    const supply = createBlockSupply(
      supplyContext(executor, {
        requestBlock: async (request) => ({ ...blockFor(request), toSerial: 3500 }),
      }),
    );
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(blocks(db)).toEqual([
      { block_id: BLOCK_ID, from_serial: 3500, to_serial: 3500, next_serial: 3500 },
    ]);
  });

  it("is not kept when it shares a serial with a block already kept, and the request goes", async () => {
    const { db, executor } = openLocalDb();
    for (const [from, to] of [
      [3000, 3500],
      [3500, 3500],
      [5499, 6000],
      [3600, 3700],
      [3000, 6000],
    ] as const) {
      db.prepare("DELETE FROM floor_sscc_blocks").run();
      seedBlock(db, { blockId: OLD_BLOCK, from, to, next: to + 1 });
      const supply = createBlockSupply(supplyContext(executor));
      await expect(supply.topUp(), `${from}-${to}`).resolves.toEqual({ kind: "failed" });
      expect(blocks(db), `${from}-${to}`).toEqual([
        { block_id: OLD_BLOCK, from_serial: from, to_serial: to, next_serial: to + 1 },
      ]);
      expect(requests(db)).toEqual([]);
    }
  });

  it("is kept beside a block whose serials end right before it or start right after it", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: OLD_BLOCK, from: 1500, to: 3499, next: 3500 });
    seedBlock(db, { blockId: NEWER_BLOCK, from: 5500, to: 7499, next: 7499 });
    await expect(createBlockSupply(supplyContext(executor)).topUp()).resolves.toMatchObject({
      kind: "stored",
    });
    expect(blocks(db)).toHaveLength(3);
  });

  it.each(foreign)(
    "is kept beside a block of another %s with the same serials",
    async (_name, other) => {
      const { db, executor } = openLocalDb();
      seedBlock(db, { blockId: OLD_BLOCK, from: 3500, to: 5499, next: 5500, ...other });
      await expect(createBlockSupply(supplyContext(executor)).topUp()).resolves.toMatchObject({
        kind: "stored",
      });
      expect(blocks(db)).toHaveLength(2);
    },
  );

  it("is never kept without its request going, nor the request gone without the block kept", async () => {
    for (const [name, broken] of [
      ["the request's removal fails", /DELETE FROM floor_block_requests/],
      ["the block's write fails", /INSERT INTO floor_sscc_blocks/],
    ] as const) {
      const { db, executor } = openLocalDb();
      const breaking = breakingOn(executor, broken);
      const supply = createBlockSupply(supplyContext(breaking.executor));
      await expect(supply.topUp(), name).rejects.toMatchObject({ code: "statement_failed" });
      expect(blocks(db), name).toEqual([]);
      expect(requests(db), name).toEqual([
        { request_id: FIRST_REQUEST, issuer_prefix: PREFIX, extension: 0 },
      ]);
      // The same supply goes on after the failure, with the same request.
      breaking.heal();
      await expect(supply.topUp(), name).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
      expect(blocks(db), name).toHaveLength(1);
      expect(requests(db), name).toEqual([]);
    }
  });

  it("is asked for once more after the host has none to give, and nothing kept is touched", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: OLD_BLOCK, from: 1, to: 2000, next: 1500 });
    const exhausted = new HostError({
      kind: "api",
      code: "sscc_exhausted",
      status: 409,
      message: "exhausted",
      details: { issuerPrefix: PREFIX, extension: 0 },
    });
    const requestBlock = vi
      .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
      .mockRejectedValueOnce(exhausted)
      .mockImplementation(async (request) => blockFor(request));
    const context = supplyContext(executor, { requestBlock });
    const supply = createBlockSupply(context);
    await expect(supply.topUp()).resolves.toEqual({ kind: "exhausted" });
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(501);
    expect(context.onHostError).not.toHaveBeenCalled();
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    expect(requestBlock.mock.calls.map(([sent]) => sent.requestId)).toEqual([
      FIRST_REQUEST,
      SECOND_REQUEST,
    ]);
    expect(blocks(db)[0]).toEqual({
      block_id: OLD_BLOCK,
      from_serial: 1,
      to_serial: 2000,
      next_serial: 1500,
    });
  });
});

describe("a call to the host that does not end in a block", () => {
  const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
  const failures: [string, unknown][] = [
    ["no answer", down],
    [
      "a revoked device",
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "no",
        details: { credential: "device" },
      }),
    ],
    ["a host error", new HostError({ kind: "api", code: "internal", status: 500, message: "no" })],
    [
      "a transport failure that carries a code of the host",
      new HostError({ kind: "transport", code: "validation_failed", message: "odd" }),
    ],
    [
      "a transport failure that carries the code of exhaustion",
      new HostError({ kind: "transport", code: "sscc_exhausted", message: "odd" }),
    ],
    ["an answer that cannot be read", new Error("unreadable")],
  ];

  it.each(failures)(
    "(%s) is handed to the shell, and the request stays to be repeated whole",
    async (_name, failure) => {
      const { db, executor } = openLocalDb();
      const requestBlock = vi
        .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
        .mockRejectedValueOnce(failure)
        .mockImplementation(async (request) => blockFor(request));
      const context = supplyContext(executor, { requestBlock });
      const supply = createBlockSupply(context);
      await expect(supply.topUp()).resolves.toEqual({ kind: "failed" });
      expect(context.onHostError).toHaveBeenCalledTimes(1);
      expect(context.onHostError).toHaveBeenCalledWith(failure);
      expect(requests(db)).toEqual([
        { request_id: FIRST_REQUEST, issuer_prefix: PREFIX, extension: 0 },
      ]);
      await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
      expect(requestBlock.mock.calls.map(([sent]) => sent.requestId)).toEqual([
        FIRST_REQUEST,
        FIRST_REQUEST,
      ]);
    },
  );

  it.each(["issuerPrefix", "extension", null])(
    "(validation_failed on %s) drops the request and asks no more in this call",
    async (field) => {
      const { db, executor } = openLocalDb();
      const requestBlock = vi
        .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
        .mockRejectedValueOnce(refusal("validation_failed", field === null ? {} : { field }))
        .mockImplementation(async (request) => blockFor(request));
      const context = supplyContext(executor, { requestBlock });
      await expect(createBlockSupply(context).topUp()).resolves.toEqual({ kind: "failed" });
      expect(requestBlock).toHaveBeenCalledTimes(1);
      expect(context.onHostError).not.toHaveBeenCalled();
      expect(requests(db)).toEqual([]);
    },
  );

  it.each([
    [
      "exhaustion",
      async (): Promise<SsccBlock> => {
        throw new HostError({ kind: "api", code: "sscc_exhausted", status: 409, message: "no" });
      },
    ],
    [
      "a refusal",
      async (): Promise<SsccBlock> => {
        throw refusal("validation_failed", { field: "issuerPrefix" });
      },
    ],
    [
      "another prefix's block",
      async (request: SsccBlockRequest): Promise<SsccBlock> => ({
        ...blockFor(request),
        issuerPrefix: "460068201",
      }),
    ],
  ])("(%s) drops its own request and no other", async (_name, answer) => {
    const { db, executor } = openLocalDb();
    seedRequest(db, { id: SECOND_REQUEST, hostId: OTHER_HOST });
    seedRequest(db, { id: THIRD_REQUEST, prefix: "460068201" });
    await createBlockSupply(supplyContext(executor, { requestBlock: answer })).topUp();
    expect(rows(db, "SELECT request_id FROM floor_block_requests ORDER BY request_id")).toEqual([
      { request_id: SECOND_REQUEST },
      { request_id: THIRD_REQUEST },
    ]);
  });

  it("does not tell the shell of a request the host refused on requestId", async () => {
    const { executor } = openLocalDb();
    const requestBlock = vi
      .fn<(request: SsccBlockRequest) => Promise<SsccBlock>>()
      .mockRejectedValueOnce(refusal("validation_failed", { field: "requestId" }))
      .mockImplementation(async (request) => blockFor(request));
    const context = supplyContext(executor, { requestBlock });
    await createBlockSupply(context).topUp();
    expect(context.onHostError).not.toHaveBeenCalled();
  });

  it("is not a reason to run a second top-up forever: the next call after a rejection runs afresh", async () => {
    const { db, executor } = openLocalDb();
    const breaking = breakingOn(executor, /INSERT INTO floor_block_requests/);
    const supply = createBlockSupply(supplyContext(breaking.executor));
    await expect(supply.topUp()).rejects.toMatchObject({ code: "statement_failed" });
    expect(requests(db)).toEqual([]);
    breaking.heal();
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
  });
});

describe("the supply and the close of a box", () => {
  it("leave the older block to the close until it is used up, then the new one", async () => {
    const { db, executor } = openLocalDb();
    const shift = await enteredShift(executor);
    seedBlock(db, { blockId: OLD_BLOCK, from: 1500, to: 1509, next: 1505 });
    // 5 of 10 left: half, so nothing wanted.
    const supply = createBlockSupply(supplyContext(executor));
    await expect(supply.topUp()).resolves.toEqual({ kind: "enough" });
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 1506").run();
    await expect(supply.topUp()).resolves.toEqual({ kind: "stored", blockId: BLOCK_ID });
    const work = scanContext(executor, shift, { newId: () => crypto.randomUUID() });
    const closes: unknown[] = [];
    for (const serial of ["A1", "A2", "A3", "A4", "A5"]) {
      await processScan(work, km(serial));
      const closed = await closeOpenBox(work);
      closes.push(closed.kind === "closed" ? [closed.box.blockId, closed.box.serial] : closed);
    }
    expect(closes).toEqual([
      [OLD_BLOCK, 1506],
      [OLD_BLOCK, 1507],
      [OLD_BLOCK, 1508],
      [OLD_BLOCK, 1509],
      [BLOCK_ID, 3500],
    ]);
    await expect(remainingSerials(executor, PAIRING, PREFIX)).resolves.toBe(1999);
  });
});

describe("the statements a top-up repeats", () => {
  // node:sqlite's planner (3.53); the shell's own (3.46) is pinned in
  // `tests/local_db.rs` (`the_floors_repeating_reads_search_an_index`), whose
  // list carries the same statements.
  it("search an index of the floor's tables, and scan only the table of waiting requests", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: OLD_BLOCK, from: 1, to: 2000, next: 1500 });
    const seen: [string, readonly unknown[]][] = [];
    const recorder: LocalExecutor = {
      query: (sql, params, row) => {
        seen.push([sql, params]);
        return executor.query(sql, params, row);
      },
      transaction: (statements) => {
        for (const statement of statements) seen.push([statement.sql, statement.values ?? []]);
        return executor.transaction(statements);
      },
    };
    const exhausted = new HostError({
      kind: "api",
      code: "sscc_exhausted",
      status: 409,
      message: "exhausted",
    });
    // The host has no serials: the request is dropped. Then it answers: the block is kept.
    await createBlockSupply(
      supplyContext(recorder, {
        requestBlock: async () => {
          throw exhausted;
        },
      }),
    ).topUp();
    await createBlockSupply(supplyContext(recorder, { newId: () => SECOND_REQUEST })).topUp();
    await remainingSerials(recorder, PAIRING, PREFIX);
    const plan = (sql: string, values: readonly unknown[]): string[] =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...values.map((value) => (typeof value === "number" ? value : String(value))))
        .map((step) => String(step["detail"]));
    const prefixIndex =
      "INDEX floor_sscc_blocks_prefix (host_id=? AND device_id=? AND issuer_prefix=? AND extension=?)";
    // (the statement, how many times the scenario sends it, the index its plan names)
    const expected: [string, number, string | null][] = [
      ["SELECT from_serial, to_serial, next_serial FROM floor_sscc_blocks", 2, prefixIndex],
      ["SELECT 1 AS n FROM floor_sscc_blocks", 1, prefixIndex],
      [
        "SELECT coalesce(sum(to_serial + 1 - next_serial), 0) AS n FROM floor_sscc_blocks",
        1,
        prefixIndex,
      ],
      // The table holds at most one request per pairing and prefix: read whole, no index.
      ["SELECT request_id, issuer_prefix, extension FROM floor_block_requests", 2, null],
      [
        "DELETE FROM floor_block_requests WHERE request_id = ?",
        2,
        "INDEX sqlite_autoindex_floor_block_requests_1 (request_id=?)",
      ],
    ];
    const statements = seen.filter(([sql]) => /^(SELECT|DELETE|UPDATE)/.test(sql));
    expect(statements.length).toBe(expected.reduce((sum, [, times]) => sum + times, 0));
    for (const [start, times, index] of expected) {
      const found = statements.filter(([sql]) => sql.startsWith(start));
      expect(found, start).toHaveLength(times);
      for (const [sql, values] of found) {
        const steps = plan(sql, values);
        const scans = steps.filter((step) => step.startsWith("SCAN "));
        if (index === null) {
          expect(scans, sql).toEqual(["SCAN floor_block_requests"]);
        } else {
          expect(steps.join("\n"), sql).toContain(index);
          expect(scans, sql).toEqual([]);
        }
      }
    }
  });
});
