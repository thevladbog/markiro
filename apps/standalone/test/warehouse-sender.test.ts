import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useHostLink } from "../src/app/host-link.js";
import type { ShellAction } from "../src/app/shell.js";
import { recordStatement, warehouseRecord } from "../src/floor/warehouse/warehouse-store.js";
import { HostError } from "../src/host/client.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import type {
  ChangesResponse,
  DeviceStatus,
  FactReceipt,
  HostStatus,
} from "../src/host/protocol.js";
import { ReceiptMismatchError } from "../src/local/facts-sender.js";
import { MAX_WAREHOUSE_BATCH, sendWarehouseBatch } from "../src/local/warehouse-sender.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { OPERATOR_ID, PAIRING, rows, unsentScans } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { BOX_SSCC, BOX_TEMPLATE } from "./support/warehouse.js";

const AT = "2026-10-09T07:00:00.000Z";
const JOB = {
  id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
  sessionId: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  kind: "box" as const,
  subjectId: "b0000000-0000-4000-8000-000000000001",
  identity: BOX_SSCC,
  repair: null,
  templateId: BOX_TEMPLATE,
  templateRev: 4,
};

function recordId(n: number): string {
  return `6e7f8a9b-0c1d-4e2f-8a3b-${String(n).padStart(12, "0")}`;
}

function record(n: number) {
  return warehouseRecord(JOB, {
    id: recordId(n),
    attempt: n,
    reason: "damaged",
    outcome: "sent",
    errorCode: null,
    operatorId: OPERATOR_ID,
    occurredAt: AT,
  });
}

describe("the warehouse records on their way to the host (plan СКЛ)", () => {
  it("sends the unsent records in their order, as kept, and keeps each receipt", async () => {
    const { db, executor } = openLocalDb();
    await executor.transaction([
      recordStatement(PAIRING, record(1), AT),
      recordStatement(PAIRING, record(2), AT),
    ]);
    const send = vi.fn(async (records: readonly unknown[]): Promise<FactReceipt[]> => [
      { id: (records[0] as { id: string }).id, outcome: "accepted" },
      { id: (records[1] as { id: string }).id, outcome: "rejected", code: "subject_unknown" },
    ]);
    expect(await sendWarehouseBatch(executor, PAIRING, send, () => new Date(AT))).toEqual({
      sent: 2,
      more: false,
    });
    expect(send).toHaveBeenCalledWith([record(1), record(2)]);
    expect(rows(db, "SELECT attempts, outcome, outcome_code FROM wh_outbox ORDER BY seq")).toEqual([
      { attempts: 1, outcome: "accepted", outcome_code: null },
      { attempts: 1, outcome: "rejected", outcome_code: "subject_unknown" },
    ]);
    // Nothing more to send: the host is not asked.
    expect(await sendWarehouseBatch(executor, PAIRING, send, () => new Date(AT))).toEqual({
      sent: 0,
      more: false,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps nothing of receipts that do not answer the records, and sends the same batch again", async () => {
    const { db, executor } = openLocalDb();
    await executor.transaction([recordStatement(PAIRING, record(1), AT)]);
    for (const answer of [
      [],
      [{ id: "another", outcome: "accepted" as const }],
      [{ id: null, outcome: "conflict" as const }],
    ]) {
      await expect(
        sendWarehouseBatch(
          executor,
          PAIRING,
          async () => answer,
          () => new Date(AT),
        ),
      ).rejects.toBeInstanceOf(ReceiptMismatchError);
    }
    expect(rows(db, "SELECT attempts, outcome FROM wh_outbox")).toEqual([
      { attempts: 3, outcome: null },
    ]);
  });
});

const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const ids = (records: readonly unknown[]): string[] =>
  records.map((one) => (one as { id: string }).id);
const acceptAll = async (records: readonly unknown[]): Promise<FactReceipt[]> =>
  ids(records).map((id) => ({ id, outcome: "accepted" }));

describe("the warehouse sender's guards (plan СКЛ)", () => {
  it("sends at most 100 records, the oldest first, and asks for the next batch when 100 went", async () => {
    const { db, executor } = openLocalDb();
    const total = MAX_WAREHOUSE_BATCH + 1;
    // Kept in a scrambled id order: the order of keeping is `seq`, not the id.
    const order = Array.from({ length: total }, (_, index) => total - index);
    for (let from = 0; from < total; from += 25) {
      await executor.transaction(
        order.slice(from, from + 25).map((n) => recordStatement(PAIRING, record(n), AT)),
      );
    }
    const send = vi.fn(acceptAll);
    expect(MAX_WAREHOUSE_BATCH).toBe(100);
    expect(await sendWarehouseBatch(executor, PAIRING, send, () => new Date(AT))).toEqual({
      sent: 100,
      more: true,
    });
    expect(ids(send.mock.calls[0]?.[0] ?? [])).toEqual(order.slice(0, 100).map(recordId));
    expect(await sendWarehouseBatch(executor, PAIRING, send, () => new Date(AT))).toEqual({
      sent: 1,
      more: false,
    });
    expect(ids(send.mock.calls[1]?.[0] ?? [])).toEqual([recordId(order[100] ?? 0)]);
    expect(rows(db, "SELECT count(*) AS n FROM wh_outbox WHERE acked_at IS NULL")).toEqual([
      { n: 0 },
    ]);
  });

  it("sends only this pairing's records that wait, and touches no other", async () => {
    const { db, executor } = openLocalDb();
    const other = { hostId: HOST_ID, deviceId: OTHER_DEVICE };
    const foreign = { hostId: "another-host", deviceId: DEVICE_ID };
    await executor.transaction([
      recordStatement(PAIRING, record(1), AT),
      recordStatement(other, record(2), AT),
      recordStatement(foreign, record(3), AT),
      recordStatement(PAIRING, record(4), AT),
      recordStatement(PAIRING, record(5), AT),
    ]);
    // Record 4 was answered `accepted`, record 5 `rejected`: neither goes again.
    db.prepare("UPDATE wh_outbox SET outcome = 'accepted', acked_at = ? WHERE id = ?").run(
      AT,
      recordId(4),
    );
    db.prepare(
      "UPDATE wh_outbox SET outcome = 'rejected', outcome_code = 'subject_unknown', acked_at = ? WHERE id = ?",
    ).run(AT, recordId(5));
    const send = vi.fn(acceptAll);
    expect(await sendWarehouseBatch(executor, PAIRING, send, () => new Date(AT))).toEqual({
      sent: 1,
      more: false,
    });
    expect(ids(send.mock.calls[0]?.[0] ?? [])).toEqual([recordId(1)]);
    expect(rows(db, "SELECT id, attempts, outcome FROM wh_outbox ORDER BY seq")).toEqual([
      { id: recordId(1), attempts: 1, outcome: "accepted" },
      { id: recordId(2), attempts: 0, outcome: null },
      { id: recordId(3), attempts: 0, outcome: null },
      { id: recordId(4), attempts: 0, outcome: "accepted" },
      { id: recordId(5), attempts: 0, outcome: "rejected" },
    ]);
  });

  it("counts the send before it leaves, and keeps the record waiting when the send fails", async () => {
    const { db, executor } = openLocalDb();
    await executor.transaction([recordStatement(PAIRING, record(1), AT)]);
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    let attemptsDuringSend: unknown = null;
    await expect(
      sendWarehouseBatch(
        executor,
        PAIRING,
        async () => {
          attemptsDuringSend = rows(db, "SELECT attempts, sent_at FROM wh_outbox")[0];
          throw down;
        },
        () => new Date(AT),
      ),
    ).rejects.toBe(down);
    expect(attemptsDuringSend).toEqual({ attempts: 1, sent_at: AT });
    expect(rows(db, "SELECT attempts, outcome, acked_at FROM wh_outbox")).toEqual([
      { attempts: 1, outcome: null, acked_at: null },
    ]);
    // The next delivery sends the same record, the second attempt.
    const send = vi.fn(acceptAll);
    await sendWarehouseBatch(executor, PAIRING, send, () => new Date(AT));
    expect(send).toHaveBeenCalledWith([record(1)]);
    expect(rows(db, "SELECT attempts, outcome FROM wh_outbox")).toEqual([
      { attempts: 2, outcome: "accepted" },
    ]);
  });

  it("stamps the send and the receipt with their own instants", async () => {
    const { db, executor } = openLocalDb();
    await executor.transaction([recordStatement(PAIRING, record(1), AT)]);
    const instants = ["2026-10-09T07:00:01.000Z", "2026-10-09T07:00:02.000Z"];
    let call = 0;
    await sendWarehouseBatch(executor, PAIRING, acceptAll, () => new Date(instants[call++] ?? AT));
    expect(rows(db, "SELECT sent_at, acked_at FROM wh_outbox")).toEqual([
      { sent_at: instants[0], acked_at: instants[1] },
    ]);
  });

  it("answers a receipt without an id by its place, and keeps a rejection's code only", async () => {
    const { db, executor } = openLocalDb();
    await executor.transaction([
      recordStatement(PAIRING, record(1), AT),
      recordStatement(PAIRING, record(2), AT),
    ]);
    await sendWarehouseBatch(
      executor,
      PAIRING,
      async () => [
        { id: null, outcome: "accepted" },
        { id: null, outcome: "rejected", code: "invalid_record" },
      ],
      () => new Date(AT),
    );
    expect(rows(db, "SELECT outcome, outcome_code FROM wh_outbox ORDER BY seq")).toEqual([
      { outcome: "accepted", outcome_code: null },
      { outcome: "rejected", outcome_code: "invalid_record" },
    ]);
  });

  it("refuses more receipts than records, a receipt in another record's place, and keeps nothing", async () => {
    const { db, executor } = openLocalDb();
    await executor.transaction([
      recordStatement(PAIRING, record(1), AT),
      recordStatement(PAIRING, record(2), AT),
    ]);
    const swapped = async (records: readonly unknown[]): Promise<FactReceipt[]> => [
      { id: ids(records)[1] ?? null, outcome: "accepted" },
      { id: ids(records)[0] ?? null, outcome: "accepted" },
    ];
    const tooMany = async (records: readonly unknown[]): Promise<FactReceipt[]> => [
      ...(await acceptAll(records)),
      { id: null, outcome: "accepted" },
    ];
    const conflict = async (records: readonly unknown[]): Promise<FactReceipt[]> => [
      { id: ids(records)[0] ?? null, outcome: "accepted" },
      { id: ids(records)[1] ?? null, outcome: "conflict" },
    ];
    for (const answer of [swapped, tooMany, conflict]) {
      await expect(
        sendWarehouseBatch(executor, PAIRING, answer, () => new Date(AT)),
      ).rejects.toBeInstanceOf(ReceiptMismatchError);
    }
    expect(rows(db, "SELECT attempts, outcome, acked_at FROM wh_outbox ORDER BY seq")).toEqual([
      { attempts: 3, outcome: null, acked_at: null },
      { attempts: 3, outcome: null, acked_at: null },
    ]);
    // The same batch goes again and is kept whole.
    await sendWarehouseBatch(executor, PAIRING, acceptAll, () => new Date(AT));
    expect(rows(db, "SELECT attempts, outcome FROM wh_outbox ORDER BY seq")).toEqual([
      { attempts: 4, outcome: "accepted" },
      { attempts: 4, outcome: "accepted" },
    ]);
  });

  it("does not overwrite a receipt a record got meanwhile", async () => {
    const { db, executor } = openLocalDb();
    await executor.transaction([recordStatement(PAIRING, record(1), AT)]);
    await sendWarehouseBatch(
      executor,
      PAIRING,
      async (records) => {
        // Another delivery's answer landed while this one was on its way.
        db.prepare(
          "UPDATE wh_outbox SET outcome = 'accepted', acked_at = '2026-10-09T06:00:00.000Z'",
        ).run();
        return ids(records).map((id) => ({ id, outcome: "rejected" as const, code: "late" }));
      },
      () => new Date(AT),
    );
    expect(rows(db, "SELECT outcome, outcome_code, acked_at FROM wh_outbox")).toEqual([
      { outcome: "accepted", outcome_code: null, acked_at: "2026-10-09T06:00:00.000Z" },
    ]);
  });

  it("writes the receipts of a batch whole or not at all", async () => {
    const { db, executor } = openLocalDb();
    await executor.transaction([
      recordStatement(PAIRING, record(1), AT),
      recordStatement(PAIRING, record(2), AT),
    ]);
    // A receipt the table refuses (an outcome outside its list) fails the one statement.
    await expect(
      sendWarehouseBatch(
        executor,
        PAIRING,
        async (records) =>
          ids(records).map((id, index) => ({
            id,
            outcome: (index === 0 ? "accepted" : "maybe") as FactReceipt["outcome"],
          })),
        () => new Date(AT),
      ),
    ).rejects.toThrow();
    expect(rows(db, "SELECT outcome FROM wh_outbox ORDER BY seq")).toEqual([
      { outcome: null },
      { outcome: null },
    ]);
  });
});

const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const OFFLINE: HostStatus = {
  state: "offline",
  lastContactAt: 1,
  lastError: "unreachable",
  seq: 2,
};

/** The shell's link as the test drives it: `watch` reports "online" at once. */
function fakeConnection() {
  let handlers: ConnectionHandlers | null = null;
  const connection: ConnectionApi = {
    watch: vi.fn(async (next: ConnectionHandlers) => {
      handlers = next;
      next.onStatus(ONLINE);
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
  };
}

type Send = (records: readonly unknown[]) => Promise<FactReceipt[]>;

/** The link over a fresh database with `waiting` warehouse records and `facts` facts waiting. */
async function link(
  sendWarehouse: Send | undefined,
  { waiting = 1, facts = 0, sendFacts = acceptAll as Send } = {},
) {
  const { db, executor } = openLocalDb();
  if (waiting > 0) {
    for (let from = 0; from < waiting; from += 25) {
      await executor.transaction(
        Array.from({ length: Math.min(25, waiting - from) }, (_, index) =>
          recordStatement(PAIRING, record(from + index + 1), AT),
        ),
      );
    }
  }
  if (facts > 0) await unsentScans(executor, facts);
  const connection = fakeConnection();
  const dispatch = vi.fn<(action: ShellAction) => void>();
  const facted = vi.fn(sendFacts);
  const warehouse = sendWarehouse === undefined ? undefined : vi.fn(sendWarehouse);
  // Stable between renders, so that only the route can restart the link.
  const changes = async (): Promise<ChangesResponse> => ({
    hostId: HOST_ID,
    rev: 1,
    hasMore: false,
    items: [],
  });
  const refresh = async (): Promise<DeviceStatus> => DEVICE_STATUS;
  const deviceShifts = async () => [];
  const registerKnownBlocks = async () => ({ results: [] });
  const hook = renderHook(
    ({ route }: { route: Send | undefined }) =>
      useHostLink({
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        connection: connection.connection,
        local: executor,
        changes,
        refresh,
        deviceShifts,
        sendFacts: facted,
        registerKnownBlocks,
        ...(route === undefined ? {} : { sendWarehouseRecords: route }),
        dispatch,
      }),
    { initialProps: { route: warehouse } },
  );
  const types = () => dispatch.mock.calls.map(([action]) => action.type);
  const unsent = () =>
    rows(db, "SELECT count(*) AS n FROM wh_outbox WHERE acked_at IS NULL")[0]?.["n"];
  return { db, local: executor, connection, dispatch, facted, warehouse, hook, types, unsent };
}

/** Two turns of React's effect scheduler and the promises they started. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

const NOT_FOUND = new HostError({ kind: "api", code: "not_found", status: 404, message: "no" });

afterEach(() => {
  vi.useRealTimers();
});

describe("the warehouse records on the link (plan СКЛ)", () => {
  it("go once the link is online, keep the host's receipt, and tell the app the outbox changed", async () => {
    const station = await link(acceptAll);
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.warehouse).toHaveBeenCalledWith([record(1)]);
    expect(rows(station.db, "SELECT outcome FROM wh_outbox")).toEqual([{ outcome: "accepted" }]);
    expect(station.types()).toContain("outbox_changed");
    expect(station.types()).toContain("facts_sent");
    // No fact waited: the facts' route was not asked.
    expect(station.facted).not.toHaveBeenCalled();
    station.hook.unmount();
  });

  it("go after the last batch of facts, not between batches of them", async () => {
    const calls: string[] = [];
    const station = await link(
      async (records) => {
        calls.push("warehouse");
        return acceptAll(records);
      },
      {
        facts: 150,
        sendFacts: async (records) => {
          calls.push(`facts ${records.length}`);
          return acceptAll(records);
        },
      },
    );
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(calls).toEqual(["facts 100", "facts 50", "warehouse"]);
    station.hook.unmount();
  });

  it("ask for the next batch at once when a batch of 100 went", async () => {
    const station = await link(acceptAll, { waiting: 150 });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.warehouse?.mock.calls.map(([records]) => records.length)).toEqual([100, 50]);
    station.hook.unmount();
  });

  it("wait when the link has no route for them", async () => {
    const station = await link(undefined);
    await settle();
    expect(station.unsent()).toBe(1);
    expect(station.types()).not.toContain("facts_failed");
    // Not even counted as a send: nothing was tried.
    expect(rows(station.db, "SELECT attempts FROM wh_outbox")).toEqual([{ attempts: 0 }]);
    station.hook.unmount();
  });

  it("are no failure of the facts when the host refuses the route: it waits 2 s, 4 s, and goes on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const station = await link(async () => {
      throw NOT_FOUND;
    });
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(1));
    expect(station.types()).toContain("facts_sent");
    expect(station.types()).not.toContain("facts_failed");
    expect(station.unsent()).toBe(1);
    // Not hot: nothing before the first wait is over.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(station.warehouse).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(station.warehouse).toHaveBeenCalledTimes(2);
    station.warehouse?.mockImplementation(acceptAll);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.warehouse).toHaveBeenCalledTimes(3);
    expect(station.types()).not.toContain("facts_failed");
    station.hook.unmount();
  });

  it("start their waits again after a delivery that went through", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let failing = true;
    const station = await link(async (records) => {
      if (failing) throw NOT_FOUND;
      return acceptAll(records);
    });
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(2));
    // The second failure waited 4 s; the third would wait 8 s. A delivery that
    // goes through ends the series: the next failure waits 2 s again.
    failing = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });
    await waitFor(() => expect(station.unsent()).toBe(0));
    failing = true;
    // A second reprint keeps one more record.
    await station.local.transaction([recordStatement(PAIRING, record(50), AT)]);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(4));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await settle();
    expect(station.warehouse).toHaveBeenCalledTimes(5);
    station.hook.unmount();
  });

  it("ends the link on a refused key, as the facts do, and sends nothing more", async () => {
    const refused = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const station = await link(async () => {
      throw refused;
    });
    await waitFor(() =>
      expect(station.dispatch).toHaveBeenCalledWith({
        type: "device_rejected",
        reason: "key_rejected",
      }),
    );
    expect(station.types()).not.toContain("facts_sent");
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.warehouse).toHaveBeenCalledTimes(1);
    station.hook.unmount();
  });

  it("wait for the host's own time when it holds the stations' records after a restore", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const held = new HostError({
      kind: "api",
      code: "restore_pending",
      status: 503,
      message: "held",
    });
    const station = await link(async () => {
      throw held;
    });
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    station.hook.result.current.requestFacts();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(station.warehouse).toHaveBeenCalledTimes(1);
    station.warehouse?.mockImplementation(acceptAll);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await waitFor(() => expect(station.unsent()).toBe(0));
    station.hook.unmount();
  });

  it("are not retried for a host that does not know the device any more", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const station = await link(async () => {
      throw new HostError({ kind: "api", code: "not_paired", status: 409, message: "no" });
    });
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(station.warehouse).toHaveBeenCalledTimes(1);
    station.hook.unmount();
  });

  it("wait for the link when it drops while they are on their way", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let fail: (error: unknown) => void = () => undefined;
    const station = await link(
      () =>
        new Promise<FactReceipt[]>((_, reject) => {
          fail = reject;
        }),
    );
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(1));
    await station.connection.status(OFFLINE);
    await act(async () => {
      fail(NOT_FOUND);
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(station.warehouse).toHaveBeenCalledTimes(1);
    station.warehouse?.mockImplementation(acceptAll);
    await station.connection.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.warehouse).toHaveBeenCalledTimes(2);
    station.hook.unmount();
  });

  it("go by the route the link is given now, not the one it started with", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const station = await link(async () => {
      throw NOT_FOUND;
    });
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(1));
    const better = vi.fn(acceptAll);
    station.hook.rerender({ route: better });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(better).toHaveBeenCalledTimes(1);
    expect(station.warehouse).toHaveBeenCalledTimes(1);
    station.hook.unmount();
  });

  it("set no wait of their own while the link is down", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let fail: (error: unknown) => void = () => undefined;
    const station = await link(
      () =>
        new Promise<FactReceipt[]>((_, reject) => {
          fail = reject;
        }),
    );
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(1));
    await station.connection.status(OFFLINE);
    const waiting = vi.getTimerCount();
    await act(async () => {
      fail(NOT_FOUND);
    });
    await settle();
    expect(vi.getTimerCount()).toBe(waiting);
    station.hook.unmount();
  });

  it("tell the app nothing once the link is gone", async () => {
    let answer: (receipts: FactReceipt[]) => void = () => undefined;
    const station = await link(
      (records) =>
        new Promise<FactReceipt[]>((resolve) => {
          answer = () => resolve(ids(records).map((id) => ({ id, outcome: "accepted" })));
        }),
    );
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(1));
    const before = station.types().length;
    station.hook.unmount();
    await act(async () => {
      answer([]);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(station.types().length).toBe(before);
  });
});

// The records' failures have a pause of their own (final review of plan СКЛ, I2): a failing
// reprint route neither delays the facts nor is asked again by every scan, and a pause of the
// facts neither cuts nor stretches the records' one. Only `restore_pending` — the host holds
// both routes — holds the facts too.
describe("the warehouse records' own pause (plan СКЛ)", () => {
  const SERVER = new HostError({ kind: "api", code: "internal", status: 500, message: "no" });
  const factsUnsent = (db: ReturnType<typeof openLocalDb>["db"]) =>
    rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")[0]?.["n"];
  const attempts = (db: ReturnType<typeof openLocalDb>["db"]) =>
    rows(db, "SELECT attempts FROM wh_outbox")[0]?.["attempts"];
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  /** A link whose reprint route has failed three times in a row: its next try is 8 s away. */
  async function failedThreeTimes(sendFacts: Send) {
    const station = await link(
      async () => {
        throw NOT_FOUND;
      },
      { sendFacts },
    );
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(1));
    await advance(2_100);
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(2));
    await advance(4_100);
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(3));
    return station;
  }

  it("send a scan at once while the records' route fails, and ask that route only when its pause ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const station = await link(async () => {
      throw NOT_FOUND;
    });
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(1));
    await settle();
    // Two scans in the records' first pause: each goes at once, the records do not.
    await unsentScans(station.local, 1, PAIRING, 100);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.facted).toHaveBeenCalledTimes(1));
    await unsentScans(station.local, 1, PAIRING, 101);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.facted).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(factsUnsent(station.db)).toBe(0));
    await settle();
    expect(station.warehouse).toHaveBeenCalledTimes(1);
    // Counted once: a scan is no retry of the records.
    expect(attempts(station.db)).toBe(1);
    expect(station.types()).not.toContain("facts_failed");
    await advance(2_100);
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(2));
    expect(attempts(station.db)).toBe(2);
    station.hook.unmount();
  });

  // Merge gate of plans СКЛ and ОЧ: ОЧ's `requestFacts` does nothing while a failed send's pause
  // (`factRetry`) runs, so a warehouse failure must never be written into that pause.
  it("send a new fact at once after the records' route failed three times in a row, under the outbox queue's guard", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const station = await failedThreeTimes(acceptAll);
    // The records' next try is 8 s away; the facts were never held.
    expect(station.facted).not.toHaveBeenCalled();
    expect(station.types()).not.toContain("facts_failed");
    await unsentScans(station.local, 1, PAIRING, 100);
    station.hook.result.current.requestFacts();
    // No timer advanced: the fact goes at once, the records keep their pause.
    await waitFor(() => expect(station.facted).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(factsUnsent(station.db)).toBe(0));
    await settle();
    expect(station.warehouse).toHaveBeenCalledTimes(3);
    expect(station.types()).not.toContain("facts_failed");
    // A second write in the same pause goes at once as well.
    await unsentScans(station.local, 1, PAIRING, 101);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.facted).toHaveBeenCalledTimes(2));
    expect(station.warehouse).toHaveBeenCalledTimes(3);
    station.hook.unmount();
  });

  it("keep their pause when the facts fail meanwhile, and wait for it after the facts went", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let factsDown = true;
    const station = await failedThreeTimes(async (records) => {
      if (factsDown) throw SERVER;
      return acceptAll(records);
    });
    // A scan while the facts' route fails: its own pauses, 2 s then 4 s.
    await unsentScans(station.local, 1, PAIRING, 100);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.facted).toHaveBeenCalledTimes(1));
    await advance(2_100);
    await waitFor(() => expect(station.facted).toHaveBeenCalledTimes(2));
    factsDown = false;
    station.warehouse?.mockImplementation(acceptAll);
    await advance(4_100);
    await waitFor(() => expect(factsUnsent(station.db)).toBe(0));
    await settle();
    // The facts went; the records' 8 s pause is not over.
    expect(station.warehouse).toHaveBeenCalledTimes(3);
    await advance(2_000);
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.warehouse).toHaveBeenCalledTimes(4);
    station.hook.unmount();
  });

  it("end their pause without cutting the facts' one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const station = await failedThreeTimes(async () => {
      throw SERVER;
    });
    // The facts fail at 0 s, 2 s and 6 s: their next try is at 14 s.
    await unsentScans(station.local, 1, PAIRING, 100);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.facted).toHaveBeenCalledTimes(1));
    await advance(2_100);
    await waitFor(() => expect(station.facted).toHaveBeenCalledTimes(2));
    await advance(4_100);
    await waitFor(() => expect(station.facted).toHaveBeenCalledTimes(3));
    // The records' pause ends at 8 s: the facts wait for their own.
    await advance(3_000);
    await settle();
    expect(station.facted).toHaveBeenCalledTimes(3);
    expect(station.warehouse).toHaveBeenCalledTimes(3);
    station.facted.mockImplementation(acceptAll);
    station.warehouse?.mockImplementation(acceptAll);
    await advance(5_100);
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.facted).toHaveBeenCalledTimes(4);
    expect(station.warehouse).toHaveBeenCalledTimes(4);
    station.hook.unmount();
  });

  it("hold the facts too when the host holds the stations' records after a restore", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const held = new HostError({ kind: "api", code: "restore_pending", status: 503, message: "" });
    const station = await link(async () => {
      throw held;
    });
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(1));
    await unsentScans(station.local, 1, PAIRING, 100);
    station.hook.result.current.requestFacts();
    await advance(30_000);
    expect(station.facted).not.toHaveBeenCalled();
    station.warehouse?.mockImplementation(acceptAll);
    await advance(30_000);
    await waitFor(() => expect(station.unsent()).toBe(0));
    await waitFor(() => expect(factsUnsent(station.db)).toBe(0));
    expect(station.facted).toHaveBeenCalledTimes(1);
    station.hook.unmount();
  });

  it("drop their pause when the link goes down or ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const station = await link(async () => {
      throw NOT_FOUND;
    });
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(1));
    await settle();
    const withPause = vi.getTimerCount();
    await station.connection.status(OFFLINE);
    expect(vi.getTimerCount()).toBe(withPause - 1);
    await station.connection.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(station.warehouse).toHaveBeenCalledTimes(2));
    await settle();
    expect(vi.getTimerCount()).toBe(withPause);
    station.hook.unmount();
    expect(vi.getTimerCount()).toBe(withPause - 1);
  });
});
