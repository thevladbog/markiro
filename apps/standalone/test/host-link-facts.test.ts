import type { DatabaseSync } from "node:sqlite";

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { factsFailureOf, useHostLink } from "../src/app/host-link.js";
import type { ShellAction } from "../src/app/shell.js";
import { HostError } from "../src/host/client.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import { ReceiptMismatchError } from "../src/local/facts-sender.js";
import type {
  ChangesResponse,
  DeviceStatus,
  FactReceipt,
  HostStatus,
} from "../src/host/protocol.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { rows, unsentScans } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

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

/** Accepts every record it is sent. */
async function acceptAll(records: readonly unknown[]): Promise<FactReceipt[]> {
  return records.map((record) => ({ id: (record as { id: string }).id, outcome: "accepted" }));
}

/** The link over a fresh database holding `waiting` unsent records before it starts. */
async function link(
  sendFacts: Send,
  hostId: string | null = HOST_ID,
  waiting = 0,
  database: { db: DatabaseSync; executor: LocalExecutor } = openLocalDb(),
  through: (executor: LocalExecutor) => LocalExecutor = (executor) => executor,
) {
  const { db, executor: stored } = database;
  const executor = through(stored);
  if (waiting > 0) await unsentScans(stored, waiting);
  const connection = fakeConnection();
  const dispatch = vi.fn<(action: ShellAction) => void>();
  const changes = vi.fn(async (): Promise<ChangesResponse> => ({
    hostId: HOST_ID,
    rev: 1,
    hasMore: false,
    items: [],
  }));
  const refresh = vi.fn(async (): Promise<DeviceStatus> => DEVICE_STATUS);
  const send = vi.fn(sendFacts);
  const hook = renderHook(
    ({ host }) =>
      useHostLink({
        hostId: host,
        deviceId: host === null ? null : DEVICE_ID,
        connection: connection.connection,
        local: executor,
        changes,
        refresh,
        deviceShifts: async () => [],
        sendFacts: send,
        dispatch,
      }),
    { initialProps: { host: hostId } },
  );
  const changed = () =>
    dispatch.mock.calls.filter(([action]) => action.type === "outbox_changed").length;
  const deliveries = () =>
    dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "facts_sent" || action.type === "facts_failed");
  const unsent = () =>
    rows(db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")[0]?.["n"];
  return { db, local: stored, connection, dispatch, send, hook, changed, unsent, deliveries };
}

/** Two turns of React's effect scheduler and the promises they started. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the outbox on the link", () => {
  it("goes once the link is watched, a full batch asking for the next at once", async () => {
    const station = await link(acceptAll, HOST_ID, 150);
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send.mock.calls.map(([records]) => records.length)).toEqual([100, 50]);
    expect(station.changed()).toBe(2);
    station.hook.unmount();
  });

  it("goes when a screen asks after a local write, and asks nothing when there is nothing", async () => {
    const station = await link(acceptAll);
    await settle();
    expect(station.send).not.toHaveBeenCalled();
    await unsentScans(station.local, 1);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(1);
    expect(station.changed()).toBe(1);
    station.hook.unmount();
  });

  it("is sent again after 2 s, then 4 s, while the link is online", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const station = await link(
      async () => {
        throw down;
      },
      HOST_ID,
      1,
    );
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    // The clock also runs with real time: every check keeps 800 ms from the
    // retry it must not reach yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(station.send).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(station.send).toHaveBeenCalledTimes(2);
    station.send.mockImplementation(acceptAll);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(3);
    station.hook.unmount();
  });

  it("waits while the link is down, and goes at once when it is back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const station = await link(
      async () => {
        throw down;
      },
      HOST_ID,
      1,
    );
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    await station.connection.status(OFFLINE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(station.send).toHaveBeenCalledTimes(1);
    station.send.mockImplementation(acceptAll);
    await station.connection.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(2);
    station.hook.unmount();
  });

  it("stops the link on a refused key: nothing more is sent", async () => {
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
    await unsentScans(station.local, 1);
    station.hook.result.current.requestFacts();
    await waitFor(() =>
      expect(station.dispatch).toHaveBeenCalledWith({
        type: "device_rejected",
        reason: "key_rejected",
      }),
    );
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).toHaveBeenCalledTimes(1);
    expect(station.unsent()).toBe(1);
    station.hook.unmount();
  });

  it("sends nothing while the link is stopped", async () => {
    const station = await link(acceptAll, null);
    await unsentScans(station.local, 1);
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).not.toHaveBeenCalled();
    station.hook.rerender({ host: HOST_ID });
    await waitFor(() => expect(station.unsent()).toBe(0));
    station.hook.rerender({ host: null });
    await unsentScans(station.local, 1, undefined, 10);
    station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).toHaveBeenCalledTimes(1);
    station.hook.unmount();
  });

  it("says whether a failed send was the link's, the host's or this computer's, until one goes through", async () => {
    const station = await link(
      async () => {
        throw new HostError({ kind: "api", code: "internal", status: 500, message: "boom" });
      },
      HOST_ID,
      1,
    );
    await waitFor(() =>
      expect(station.deliveries()).toEqual([{ type: "facts_failed", failure: "host" }]),
    );
    station.send.mockImplementation(acceptAll);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.deliveries().at(-1)).toEqual({ type: "facts_sent" }));
    station.hook.unmount();
  });
});

describe("why a send of the outbox failed", () => {
  it("is the link's when the host was not reached, and the host's when it answered wrong", () => {
    for (const code of ["unreachable", "timeout"]) {
      expect(factsFailureOf(new HostError({ kind: "transport", code, message: code }))).toBe(
        "offline",
      );
    }
    for (const error of [
      new HostError({ kind: "api", code: "internal", status: 500, message: "boom" }),
      new HostError({ kind: "api", code: "payload_too_large", status: 413, message: "big" }),
      new HostError({ kind: "transport", code: "invalid_response", message: "garbled" }),
      new ReceiptMismatchError("1 receipt for 2 records"),
    ]) {
      expect(factsFailureOf(error)).toBe("host");
    }
    expect(factsFailureOf(new LocalDbError("statement_failed", "disk full"))).toBe("local");
  });
});

const DOWN = () => new HostError({ kind: "transport", code: "unreachable", message: "down" });

/** The ids a mock of `sendFacts` was called with, call by call. */
function batches(send: ReturnType<typeof vi.fn<Send>>): string[][] {
  return send.mock.calls.map(([records]) => records.map((record) => (record as { id: string }).id));
}

async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("a send that does not go through", () => {
  const FAILURES: [string, () => Promise<FactReceipt[]>, string][] = [
    [
      "a 400 of a batch that was correct",
      async () => {
        throw new HostError({
          kind: "api",
          code: "validation_failed",
          status: 400,
          message: "records",
        });
      },
      "host",
    ],
    [
      "a 413",
      async () => {
        throw new HostError({
          kind: "api",
          code: "payload_too_large",
          status: 413,
          message: "big",
        });
      },
      "host",
    ],
    [
      "a 500",
      async () => {
        throw new HostError({ kind: "api", code: "internal", status: 500, message: "boom" });
      },
      "host",
    ],
    [
      "a timeout",
      async () => {
        throw new HostError({ kind: "transport", code: "timeout", message: "slow" });
      },
      "offline",
    ],
    [
      "no link",
      async () => {
        throw DOWN();
      },
      "offline",
    ],
    [
      "an answer this build cannot read",
      async () => {
        throw new HostError({ kind: "transport", code: "invalid_response", message: "garbled" });
      },
      "host",
    ],
    ["receipts that do not answer the records", async () => [], "host"],
  ];

  it.each(FAILURES)(
    "keeps every record and sends the same batch again after %s",
    async (_name, failing, failure) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      const station = await link(failing, HOST_ID, 3);
      await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(station.deliveries()).toEqual([{ type: "facts_failed", failure }]),
      );
      expect(station.unsent()).toBe(3);
      expect(station.changed()).toBe(0);
      station.send.mockImplementation(acceptAll);
      await elapse(2_100);
      await waitFor(() => expect(station.unsent()).toBe(0));
      const [first, second] = batches(station.send);
      expect(second).toEqual(first);
      expect(second).toHaveLength(3);
      station.hook.unmount();
    },
  );

  it("is this computer's, and sends nothing, while the receipts cannot be kept", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let broken = true;
    const station = await link(acceptAll, HOST_ID, 2, openLocalDb(), (executor) => ({
      query: (sql, params, row) => executor.query(sql, params, row),
      transaction: async (statements) => {
        if (broken) throw new LocalDbError("statement_failed", "disk full");
        return executor.transaction(statements);
      },
    }));
    await waitFor(() =>
      expect(station.deliveries()).toEqual([{ type: "facts_failed", failure: "local" }]),
    );
    // A send that could not be counted does not leave.
    expect(station.send).not.toHaveBeenCalled();
    broken = false;
    await elapse(2_100);
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(1);
    station.hook.unmount();
  });

  it("waits again from the first pause after a send that went through", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const station = await link(async () => Promise.reject(DOWN()), HOST_ID, 1);
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    await elapse(2_100);
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(2));
    station.send.mockImplementation(acceptAll);
    await elapse(4_100);
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(3);
    station.send.mockImplementation(async () => Promise.reject(DOWN()));
    await unsentScans(station.local, 1, undefined, 10);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(4));
    // Two failures in a row had made the next pause 8 s; a send that went through began again.
    await elapse(1_200);
    expect(station.send).toHaveBeenCalledTimes(4);
    await elapse(1_000);
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(5));
    station.hook.unmount();
  });

  it("sends at once when a screen asks during a pause, and the pause it cut short does not send again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const station = await link(async () => Promise.reject(DOWN()), HOST_ID, 1);
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    await elapse(800);
    station.hook.result.current.requestFacts();
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(2));
    // The first pause (2 s) ends here, 800 ms from where the cut-short one began
    // plus the second failure's own 4 s still ahead: nothing is due.
    await elapse(1_800);
    expect(station.send).toHaveBeenCalledTimes(2);
    await elapse(3_000);
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(3));
    station.hook.unmount();
  });

  it("goes one batch at a time and asks once more for what was written meanwhile", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let inFlight = 0;
    let most = 0;
    const station = await link(
      async (records) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await gate;
        inFlight -= 1;
        return acceptAll(records);
      },
      HOST_ID,
      1,
    );
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    await unsentScans(station.local, 1, undefined, 10);
    for (let ask = 0; ask < 3; ask += 1) station.hook.result.current.requestFacts();
    await settle();
    expect(station.send).toHaveBeenCalledTimes(1);
    open();
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(most).toBe(1);
    expect(batches(station.send)).toEqual([
      ["00000000-0000-4000-8000-000000000001"],
      ["00000000-0000-4000-8000-000000000010"],
    ]);
    station.hook.unmount();
  });

  it("does not schedule a pause for a failure that came after the link was lost", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let fail: (error: unknown) => void = () => undefined;
    const station = await link(
      () =>
        new Promise<FactReceipt[]>((_resolve, reject) => {
          fail = reject;
        }),
      HOST_ID,
      1,
    );
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    await station.connection.status(OFFLINE);
    await act(async () => {
      fail(DOWN());
    });
    await waitFor(() => expect(station.deliveries()).toHaveLength(1));
    await elapse(10_000);
    expect(station.send).toHaveBeenCalledTimes(1);
    station.send.mockImplementation(acceptAll);
    await station.connection.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(station.unsent()).toBe(0));
    expect(station.send).toHaveBeenCalledTimes(2);
    station.hook.unmount();
  });

  it("reports nothing once the link is gone, though the batch is still on its way", async () => {
    let answer: (receipts: FactReceipt[]) => void = () => undefined;
    const station = await link(
      () =>
        new Promise<FactReceipt[]>((resolve) => {
          answer = resolve;
        }),
      HOST_ID,
      1,
    );
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    station.hook.unmount();
    answer([{ id: "00000000-0000-4000-8000-000000000001", outcome: "accepted" }]);
    await settle();
    expect(station.deliveries()).toEqual([]);
    expect(station.changed()).toBe(0);
  });

  it("reports nothing and schedules nothing for a failure that comes after the link is gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let fail: (error: unknown) => void = () => undefined;
    const station = await link(
      () =>
        new Promise<FactReceipt[]>((_resolve, reject) => {
          fail = reject;
        }),
      HOST_ID,
      1,
    );
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    station.hook.unmount();
    await act(async () => {
      fail(DOWN());
    });
    await settle();
    expect(station.deliveries()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await elapse(70_000);
    expect(station.send).toHaveBeenCalledTimes(1);
  });

  it("goes on with what is left after a restart, each record once to a host that answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const database = openLocalDb();
    let calls = 0;
    const first = await link(
      async (records) => {
        calls += 1;
        if (calls === 2) throw DOWN();
        return acceptAll(records);
      },
      HOST_ID,
      150,
      database,
    );
    await waitFor(() => expect(first.send).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(first.deliveries().at(-1)?.type).toBe("facts_failed"));
    expect(first.unsent()).toBe(50);
    first.hook.unmount();
    const all = rows(database.db, "SELECT id FROM outbox ORDER BY seq").map((row) =>
      String(row["id"]),
    );
    const second = await link(acceptAll, HOST_ID, 0, database);
    await waitFor(() => expect(second.unsent()).toBe(0));
    expect(batches(first.send)).toEqual([all.slice(0, 100), all.slice(100)]);
    expect(batches(second.send)).toEqual([all.slice(100)]);
    second.hook.unmount();
  });
});

describe("a refusal of the device", () => {
  const REFUSED = new HostError({
    kind: "api",
    code: "unauthorized",
    status: 401,
    message: "no",
    details: { credential: "device" },
  });

  it("ends the link without a failure of delivery or a pause to send again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const station = await link(async () => Promise.reject(REFUSED), HOST_ID, 1);
    await waitFor(() =>
      expect(station.dispatch).toHaveBeenCalledWith({
        type: "device_rejected",
        reason: "key_rejected",
      }),
    );
    await elapse(70_000);
    expect(station.send).toHaveBeenCalledTimes(1);
    expect(station.deliveries()).toEqual([]);
    expect(station.unsent()).toBe(1);
    station.hook.unmount();
  });

  it("is a changed certificate when the host presented another one", async () => {
    const changed = new HostError({
      kind: "transport",
      code: "certificate_mismatch",
      message: "other host",
    });
    const station = await link(async () => Promise.reject(changed), HOST_ID, 1);
    await waitFor(() =>
      expect(station.dispatch).toHaveBeenCalledWith({
        type: "device_rejected",
        reason: "host_changed",
      }),
    );
    expect(station.deliveries()).toEqual([]);
    station.hook.unmount();
  });

  it("leaves a pairing that is gone to the shell: no failure, no pause", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const gone = new HostError({ kind: "transport", code: "not_paired", message: "no pairing" });
    const station = await link(async () => Promise.reject(gone), HOST_ID, 1);
    await waitFor(() => expect(station.send).toHaveBeenCalledTimes(1));
    await settle();
    await elapse(70_000);
    expect(station.send).toHaveBeenCalledTimes(1);
    expect(station.deliveries()).toEqual([]);
    station.hook.unmount();
  });
});
