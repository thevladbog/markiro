import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { factsFailureOf, RESTORE_HOLD_RETRY_MS, useHostLink } from "../src/app/host-link.js";
import type { ShellAction } from "../src/app/shell.js";
import { remainingSerials } from "../src/floor/work/block-supply.js";
import {
  knownBlocksRequestSchema,
  type KnownBlocksRequest,
  type KnownBlocksResponse,
} from "../src/host/backups.js";
import { HostError } from "../src/host/client.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import type {
  ChangesResponse,
  DeviceStatus,
  FactReceipt,
  HostStatus,
} from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import { ENTITY_SET } from "../src/local/reference-sync.js";
import { NOTE_SQL, noteRestoreEpoch, reconcileRestore } from "../src/local/restore-reconcile.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { PAIRING, PREFIX, rows, seedBlock, unsentScans } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function read(path: string): string {
  return readFileSync(new URL(path, testModuleUrl), "utf8");
}

const [BLOCK] = knownBlocksRequestSchema.parse(
  JSON.parse(read("../proto/fixtures/known-blocks-request.json")),
).blocks;
/** `restoreEpoch` of `hello-restored.json`. */
const EPOCH = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const RESTORED: HostStatus = { ...ONLINE, restoreEpoch: EPOCH };
const HELD = new HostError({
  kind: "api",
  code: "restore_pending",
  status: 503,
  message: "the host was restored from a copy: facts wait until the office resumes them",
  details: { since: "2026-10-09T15:00:00Z" },
});

/**
 * The shell's link as the test drives it: `watch` reports `first` at once,
 * or fails without a status when `first` is `"watch_fails"`.
 */
function fakeConnection(first: HostStatus | "watch_fails") {
  let handlers: ConnectionHandlers | null = null;
  const connection: ConnectionApi = {
    watch: vi.fn(async (next: ConnectionHandlers) => {
      if (first === "watch_fails") throw new Error("no events");
      handlers = next;
      next.onStatus(first);
      return () => {
        handlers = null;
      };
    }),
  };
  return {
    connection,
    status: (status: HostStatus) =>
      act(async () => {
        handlers?.onStatus(status);
      }),
    revision: (rev: number) =>
      act(async () => {
        handlers?.onRevision(rev);
      }),
  };
}

async function acceptAll(records: readonly unknown[]): Promise<FactReceipt[]> {
  return records.map((record) => ({ id: (record as { id: string }).id, outcome: "accepted" }));
}

function knownAll(request: KnownBlocksRequest): Promise<KnownBlocksResponse> {
  return Promise.resolve({
    results: request.blocks.map((block) => ({ id: block.id, outcome: "known", code: null })),
  });
}

/** The link over `db` with the station's block and two records waiting; `order` says what reached the host when. */
async function link(options: {
  first: HostStatus | "watch_fails";
  register?: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse>;
  send?: (records: readonly unknown[]) => Promise<FactReceipt[]>;
  database?: { db: DatabaseSync; executor: LocalExecutor };
  /** Every write of the link answers a turn later, as the shell's `local_transaction` does. */
  slowWrites?: boolean;
}) {
  const { db, executor: stored } = options.database ?? openLocalDb();
  const executor: LocalExecutor = options.slowWrites
    ? {
        query: (sql, params, row) => stored.query(sql, params, row),
        transaction: async (statements) => {
          await new Promise((resolve) => setImmediate(resolve));
          return stored.transaction(statements);
        },
      }
    : stored;
  if (BLOCK === undefined) throw new Error("the fixture names a block");
  seedBlock(db, { blockId: BLOCK.id, from: BLOCK.fromSerial, to: BLOCK.toSerial });
  await unsentScans(stored, 2);
  const order: string[] = [];
  const connection = fakeConnection(options.first);
  const dispatch = vi.fn<(action: ShellAction) => void>();
  const changes = vi.fn(async (since: number): Promise<ChangesResponse> => {
    order.push(`changes ${since}`);
    return { hostId: HOST_ID, rev: 30, hasMore: false, items: [] };
  });
  const refresh = vi.fn(async (): Promise<DeviceStatus> => DEVICE_STATUS);
  const registerImpl = options.register ?? knownAll;
  // The host's answer takes a turn, as over the network.
  const register = vi.fn(async (request: KnownBlocksRequest) => {
    order.push("blocks");
    await new Promise((resolve) => setImmediate(resolve));
    const answer = await registerImpl(request);
    order.push("blocks answered");
    return answer;
  });
  const sendImpl = options.send ?? acceptAll;
  const send = vi.fn(async (records: readonly unknown[]) => {
    order.push("facts");
    return sendImpl(records);
  });
  const hook = renderHook(() =>
    useHostLink({
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      connection: connection.connection,
      local: executor,
      changes,
      refresh,
      deviceShifts: async () => [],
      sendFacts: send,
      registerKnownBlocks: register,
      dispatch,
    }),
  );
  const unsent = () =>
    rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")[0]?.["n"];
  const failures = () =>
    dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "facts_failed");
  return {
    db,
    executor,
    connection,
    dispatch,
    changes,
    register,
    send,
    hook,
    order,
    unsent,
    failures,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the link after a restore of the host", () => {
  it("gives the blocks back first, then syncs from zero and sends the records", async () => {
    const { db, executor } = openLocalDb();
    // The copies reached revision 20 before the restore.
    db.prepare(
      "INSERT INTO sync_state (key, value) VALUES ('last_rev', '20'), ('host_id', ?), " +
        "('device_id', ?), ('entity_set', ?)",
    ).run(HOST_ID, DEVICE_ID, ENTITY_SET);
    const station = await link({ first: RESTORED, database: { db, executor }, slowWrites: true });
    await waitFor(() => expect(station.unsent()).toBe(0));
    await waitFor(() => expect(station.order).toContain("changes 0"));
    expect(station.register).toHaveBeenCalledTimes(1);
    expect(station.register.mock.calls[0]?.[0]).toEqual({ blocks: [BLOCK] });
    const answered = station.order.indexOf("blocks answered");
    expect(answered).toBeGreaterThan(-1);
    expect(station.order.indexOf("facts")).toBeGreaterThan(answered);
    expect(station.order.lastIndexOf("changes 0")).toBeGreaterThan(answered);
    expect(
      rows(db, "SELECT epoch, reconciled_at IS NOT NULL AS done FROM floor_restore_epochs"),
    ).toEqual([{ epoch: EPOCH, done: 1 }]);
    expect(station.dispatch).toHaveBeenCalledWith({ type: "outbox_changed" });
    station.hook.unmount();
  });

  it("sends no record while the blocks are owed, across a restart, and retries the blocks after 2 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { db, executor } = openLocalDb();
    // Noted before a restart; this connection's read of `hello` failed.
    await noteRestoreEpoch(executor, PAIRING, EPOCH, new Date());
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    let answer: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse> = () =>
      Promise.reject(down);
    const station = await link({
      first: ONLINE,
      register: (request) => answer(request),
      database: { db, executor },
    });
    await waitFor(() => expect(station.register).toHaveBeenCalledTimes(1));
    await settle();
    expect(station.send).not.toHaveBeenCalled();
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).not.toHaveBeenCalled();
    expect(station.unsent()).toBe(2);
    answer = knownAll;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.register).toHaveBeenCalledTimes(2);
    station.hook.unmount();
  });

  it("asks nothing of the host for an epoch it already settled", async () => {
    const { db, executor } = openLocalDb();
    await noteRestoreEpoch(executor, PAIRING, EPOCH, new Date());
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: knownAll,
      now: () => new Date(),
    });
    // The records the reconciliation reopened are none: two new ones wait.
    const station = await link({ first: RESTORED, database: { db, executor } });
    await waitFor(() => expect(station.unsent()).toBe(0));
    await settle();
    expect(station.register).not.toHaveBeenCalled();
    station.hook.unmount();
  });
});

describe("the outbox while the restored host holds the facts", () => {
  it("says the host holds the records, waits a minute, and sends them once the hold ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let held = true;
    const station = await link({
      first: ONLINE,
      send: async (records) => {
        if (held) throw HELD;
        return acceptAll(records);
      },
    });
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(station.failures()).toEqual([{ type: "facts_failed", failure: "held" }]),
    );
    // The usual 2 s, 4 s, … would knock every few seconds; the host said a minute.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTORE_HOLD_RETRY_MS - 1_000);
    });
    expect(station.send).toHaveBeenCalledTimes(1);
    expect(station.unsent()).toBe(2);
    held = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(2);
    expect(station.dispatch).toHaveBeenCalledWith({ type: "facts_sent" });
    station.hook.unmount();
  });

  it("tells the hold apart from the host's other failures", () => {
    expect(factsFailureOf(HELD)).toBe("held");
    expect(
      factsFailureOf(new HostError({ kind: "api", code: "internal", status: 500, message: "" })),
    ).toBe("host");
    expect(
      factsFailureOf(new HostError({ kind: "transport", code: "unreachable", message: "" })),
    ).toBe("offline");
  });

  it("waits exactly as long as the host's Retry-After says", () => {
    const server = read("../host/src/server.rs");
    const seconds = /pub const RESTORE_RETRY_AFTER_SECS: u64 = (\d+);/.exec(server)?.[1];
    expect(seconds).toBeDefined();
    expect(RESTORE_HOLD_RETRY_MS).toBe(Number(seconds) * 1000);
  });
});

describe("the link's guards around a restore", () => {
  const refusedAll = (request: KnownBlocksRequest): Promise<KnownBlocksResponse> =>
    Promise.resolve({
      results: request.blocks.map((block) => ({
        id: block.id,
        outcome: "refused" as const,
        code: "block_overlap",
      })),
    });
  const down = () => new HostError({ kind: "transport", code: "unreachable", message: "down" });

  it("asks the host held for the facts once a minute, whatever else asks meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let held = true;
    const station = await link({
      first: ONLINE,
      send: async (records) => {
        if (held) throw HELD;
        return acceptAll(records);
      },
    });
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(station.failures()).toHaveLength(1));
    // A scan written, a revision of the host, a request of a screen: none knocks.
    station.hook.result.current.requestFacts();
    station.hook.result.current.requestSync();
    await station.connection.revision(31);
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTORE_HOLD_RETRY_MS - 1_000);
    });
    expect(station.send).toHaveBeenCalledTimes(1);
    expect(station.failures()).toHaveLength(1);
    // The wait ends: one knock; the hold is over, and everything goes.
    held = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(2);
    // The next scan's request goes at once again.
    await unsentScans(station.executor, 1, PAIRING, 100);
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).toHaveBeenCalledTimes(3);
    station.hook.unmount();
  });

  it("asks again at once when the link comes back, even in the minute the host asked for", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let held = true;
    const station = await link({
      first: ONLINE,
      send: async (records) => {
        if (held) throw HELD;
        return acceptAll(records);
      },
    });
    await waitFor(() => expect(station.failures()).toHaveLength(1));
    await station.connection.status({ ...ONLINE, state: "offline" });
    held = false;
    await station.connection.status(ONLINE);
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(2);
    station.hook.unmount();
  });

  it("asks nothing more of a host held for the facts after the link is gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const station = await link({
      first: ONLINE,
      send: async () => {
        throw HELD;
      },
    });
    await waitFor(() => expect(station.failures()).toHaveLength(1));
    station.hook.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTORE_HOLD_RETRY_MS * 2);
    });
    expect(station.send).toHaveBeenCalledTimes(1);
  });

  it("tells the status bar at once that the station owes its blocks", async () => {
    let finish: (answer: KnownBlocksResponse) => void = () => undefined;
    const station = await link({
      first: RESTORED,
      register: () =>
        new Promise<KnownBlocksResponse>((resolve) => {
          finish = resolve;
        }),
    });
    await waitFor(() => expect(station.register).toHaveBeenCalledTimes(1));
    // The blocks are not back yet, and the obligation is on the disk and on the screen.
    expect(station.dispatch).toHaveBeenCalledWith({ type: "outbox_changed" });
    expect(
      rows(station.db, "SELECT reconciled_at IS NULL AS due FROM floor_restore_epochs"),
    ).toEqual([{ due: 1 }]);
    expect(station.send).not.toHaveBeenCalled();
    finish({ results: [{ id: BLOCK?.id ?? "", outcome: "known", code: null }] });
    await waitFor(() => expect(station.unsent()).toBe(0));
    station.hook.unmount();
  });

  it("writes an epoch down once, not at every event of the link", async () => {
    const { db, executor: stored } = openLocalDb();
    let notes = 0;
    const executor: LocalExecutor = {
      query: (sql, params, row) => stored.query(sql, params, row),
      transaction: (statements) => {
        notes += statements.filter((statement) => statement.sql === NOTE_SQL).length;
        return stored.transaction(statements);
      },
    };
    const station = await link({ first: RESTORED, database: { db, executor } });
    await waitFor(() => expect(station.unsent()).toBe(0));
    await station.connection.status({ ...RESTORED, seq: 2 });
    await station.connection.revision(31);
    await unsentScans(stored, 1, PAIRING, 100);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.unsent()).toBe(0));
    await settle();
    expect(notes).toBe(1);
    station.hook.unmount();
  });

  it("writes the epoch again after a write of it failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { db, executor: stored } = openLocalDb();
    let failures = 1;
    const executor: LocalExecutor = {
      query: (sql, params, row) => stored.query(sql, params, row),
      transaction: (statements) => {
        if (failures > 0 && statements.some((statement) => statement.sql === NOTE_SQL)) {
          failures -= 1;
          return Promise.reject(new LocalDbError("statement_failed", "busy"));
        }
        return stored.transaction(statements);
      },
    };
    const station = await link({ first: RESTORED, database: { db, executor } });
    // The failed write is not remembered: the next ask writes the epoch, and the blocks go back.
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.register).toHaveBeenCalledTimes(1);
    station.hook.unmount();
  });

  it("sends nothing to a host that was never restored, and asks it for no block", async () => {
    const station = await link({ first: ONLINE });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.register).not.toHaveBeenCalled();
    expect(rows(station.db, "SELECT count(*) AS n FROM floor_restore_epochs")).toEqual([{ n: 0 }]);
    station.hook.unmount();
  });

  it("stops using the blocks the host refused, and still sends the records", async () => {
    const station = await link({ first: RESTORED, register: refusedAll });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(await remainingSerials(station.executor, PAIRING, PREFIX)).toBe(0);
    expect(
      rows(
        station.db,
        "SELECT refused, reconciled_at IS NOT NULL AS done FROM floor_restore_epochs",
      ),
    ).toEqual([{ refused: 1, done: 1 }]);
    expect(station.dispatch).toHaveBeenCalledWith({ type: "outbox_changed" });
    station.hook.unmount();
  });

  it("settles another epoch the host shows later, and gives the blocks back again", async () => {
    const station = await link({ first: RESTORED });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.register).toHaveBeenCalledTimes(1);
    // The same epoch on a reconnect asks nothing; another one is a new restore.
    await station.connection.status({ ...RESTORED, seq: 2 });
    await settle();
    expect(station.register).toHaveBeenCalledTimes(1);
    await station.connection.status({
      ...ONLINE,
      seq: 3,
      restoreEpoch: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    });
    await waitFor(() => expect(station.register).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(rows(station.db, "SELECT epoch FROM floor_restore_epochs")).toEqual([
        { epoch: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" },
      ]),
    );
    await waitFor(() => expect(station.unsent()).toBe(0));
    // The records of the first restore were sent again, with the second.
    expect(station.send.mock.calls.length).toBeGreaterThanOrEqual(2);
    station.hook.unmount();
  });

  it("does not knock while the link is down, and asks at once when it is back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { db, executor } = openLocalDb();
    await noteRestoreEpoch(executor, PAIRING, EPOCH, new Date());
    let answer: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse> = () =>
      Promise.reject(down());
    const station = await link({
      first: ONLINE,
      register: (request) => answer(request),
      database: { db, executor },
    });
    await waitFor(() => expect(station.register).toHaveBeenCalledTimes(1));
    await station.connection.status({ ...ONLINE, state: "offline" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(station.register).toHaveBeenCalledTimes(1);
    answer = knownAll;
    await station.connection.status(ONLINE);
    await waitFor(() => expect(station.register).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(station.unsent()).toBe(0));
    station.hook.unmount();
  });

  it("asks nothing more of the host for the blocks after the link ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { db, executor } = openLocalDb();
    await noteRestoreEpoch(executor, PAIRING, EPOCH, new Date());
    const station = await link({
      first: ONLINE,
      register: () => Promise.reject(down()),
      database: { db, executor },
    });
    await waitFor(() => expect(station.register).toHaveBeenCalledTimes(1));
    station.hook.unmount();
    // No timer of the link outlives it.
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(station.register).toHaveBeenCalledTimes(1);
  });

  it("retries a settling whose answer does not answer the blocks sent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { db, executor } = openLocalDb();
    await noteRestoreEpoch(executor, PAIRING, EPOCH, new Date());
    let answers = 0;
    const station = await link({
      first: ONLINE,
      register: async (request) => {
        answers += 1;
        // The first answer names another block than the one sent.
        if (answers === 1) {
          return { results: [{ id: "not-the-block", outcome: "known", code: null }] };
        }
        return knownAll(request);
      },
      database: { db, executor },
    });
    await waitFor(() => expect(station.register).toHaveBeenCalledTimes(1));
    await settle();
    expect(station.unsent()).toBe(2);
    expect(station.send).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.register).toHaveBeenCalledTimes(2);
    station.hook.unmount();
  });

  it("ends the link when the host rejects the key while the blocks go back", async () => {
    const station = await link({
      first: RESTORED,
      register: () =>
        Promise.reject(
          new HostError({
            kind: "api",
            code: "unauthorized",
            status: 401,
            message: "",
            details: { credential: "device" },
          }),
        ),
    });
    await waitFor(() =>
      expect(station.dispatch).toHaveBeenCalledWith({
        type: "device_rejected",
        reason: "key_rejected",
      }),
    );
    await settle();
    expect(station.register).toHaveBeenCalledTimes(1);
    expect(station.send).not.toHaveBeenCalled();
    station.hook.unmount();
  });
});

describe("the outbox before the link is online", () => {
  const CONNECTING: HostStatus = {
    state: "connecting",
    lastContactAt: null,
    lastError: null,
    seq: 1,
  };
  const OFFLINE: HostStatus = { ...ONLINE, state: "offline", lastError: "unreachable", seq: 2 };

  it("sends no record until the link is online, so a restored host's blocks go back first", async () => {
    const station = await link({ first: CONNECTING });
    await station.connection.status({ ...RESTORED, seq: 2 });
    await waitFor(() => expect(station.unsent()).toBe(0));
    const answered = station.order.indexOf("blocks answered");
    expect(answered).toBeGreaterThan(-1);
    expect(station.order.indexOf("facts"), station.order.join(", ")).toBeGreaterThan(answered);
    station.hook.unmount();
  });

  it("keeps a local write while the link is connecting or offline, and sends it once online", async () => {
    const station = await link({ first: CONNECTING });
    await settle();
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).not.toHaveBeenCalled();
    await station.connection.status(OFFLINE);
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).not.toHaveBeenCalled();
    expect(station.unsent()).toBe(2);
    // Online, and no revision follows: going online alone sends the outbox.
    await station.connection.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(1);
    station.hook.unmount();
  });

  it("still sends when the shell's link cannot be watched at all", async () => {
    const station = await link({ first: "watch_fails" });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(1);
    station.hook.unmount();
  });

  it("does not knock again on a repeated online status before the retry's wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let fail = true;
    const station = await link({
      first: ONLINE,
      send: async (records) => {
        if (fail) throw new HostError({ kind: "api", code: "internal", status: 500, message: "" });
        return acceptAll(records);
      },
    });
    await waitFor(() => expect(station.failures()).toHaveLength(1));
    await station.connection.status({ ...ONLINE, seq: 2 });
    await settle();
    expect(station.send).toHaveBeenCalledTimes(1);
    fail = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(2);
    station.hook.unmount();
  });
});
