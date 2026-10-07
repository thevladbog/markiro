import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorNotice, SyncState } from "../src/app/shell.js";
import { FloorOperatorScreen } from "../src/floor/FloorOperatorScreen.js";
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "../src/floor/idle-lock.js";
import { signInWithPin, type FloorOperator } from "../src/floor/sign-in.js";
import type { ChangeItem } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const ANNA = {
  id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
  login: "0042",
  name: "Анна Кузнецова",
  role: "Упаковщик",
};
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const SYNCED: SyncState = { kind: "done", synced: 1, failure: null, quarantined: 0 };
const OPERATOR: ChangeItem = {
  entity: "operators",
  id: ANNA.id,
  rev: 5,
  deleted: false,
  data: { login: "0042", name: ANNA.name, role: ANNA.role, pinPhc: PIN_PHC },
};

async function syncedDb(items: ChangeItem[]) {
  const opened = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items }),
    local: opened.executor,
    ...PAIRING,
  });
  return opened;
}

async function synced(items: ChangeItem[]): Promise<LocalExecutor> {
  return (await syncedDb(items)).executor;
}

interface FloorOptions {
  sync?: SyncState;
  operator?: FloorOperator;
  idleTimeoutMs?: number;
}

function floorOf(
  local: LocalExecutor,
  onSignOut: (notice: FloorNotice | null) => void,
  { sync = SYNCED, operator = ANNA, idleTimeoutMs }: FloorOptions = {},
) {
  return (
    <ThemeProvider>
      <FloorOperatorScreen
        operator={operator}
        local={local}
        pairing={PAIRING}
        sync={sync}
        {...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs })}
        onSignOut={onSignOut}
      />
    </ThemeProvider>
  );
}

function renderFloor(local: LocalExecutor, sync: SyncState = SYNCED) {
  const onSignOut = vi.fn<(notice: FloorNotice | null) => void>();
  render(floorOf(local, onSignOut, { sync }));
  return onSignOut;
}

/** The copies as they are, but once `hold()` is called every query waits for `release()`. */
function gatedExecutor(real: LocalExecutor) {
  let pending: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const local: LocalExecutor = {
    query: (sql, params, row) => {
      const wait = pending;
      return wait === null
        ? real.query(sql, params, row)
        : wait.then(() => real.query(sql, params, row));
    },
    transaction: (statements) => real.transaction(statements),
  };
  return {
    local,
    hold() {
      pending = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open();
    },
  };
}

/** Two turns of React's effect scheduler, so a read started in an effect has settled. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

describe("the floor with an operator signed in", () => {
  it("names the operator and their role, and signs out on «Сменить оператора»", async () => {
    const onSignOut = renderFloor(await synced([OPERATOR]));
    expect(screen.getByText("Вошёл: Анна Кузнецова, табельный номер 0042.")).toBeTruthy();
    expect(screen.getByText("Упаковщик")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сменить оператора" }));
    expect(onSignOut).toHaveBeenCalledWith(null);
  });

  it("signs the operator out once the copies no longer hold them", async () => {
    const onSignOut = renderFloor(await synced([]));
    await waitFor(() => expect(onSignOut).toHaveBeenCalledWith("removed"));
  });

  it("keeps the operator when the copies cannot be read or are not this pairing's yet", async () => {
    const failing: LocalExecutor = {
      query: () => Promise.reject(new Error("disk")),
      transaction: () => Promise.reject(new Error("disk")),
    };
    const kept = renderFloor(failing);
    const { executor } = openLocalDb();
    const unsynced = renderFloor(executor);
    await settle();
    expect(kept).not.toHaveBeenCalled();
    expect(unsynced).not.toHaveBeenCalled();
  });
});

describe("the checks of the signed-in floor after a sync", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps an operator the copies hold", async () => {
    const onSignOut = renderFloor(await synced([OPERATOR]));
    await settle();
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it("reads nothing before the first sync of this run", async () => {
    const onSignOut = renderFloor(await synced([]), { ...SYNCED, synced: 0 });
    await settle();
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it("checks again after every later sync", async () => {
    const { executor } = await syncedDb([OPERATOR]);
    const onSignOut = vi.fn<(notice: FloorNotice | null) => void>();
    const view = render(floorOf(executor, onSignOut));
    await settle();
    expect(onSignOut).not.toHaveBeenCalled();
    await syncReferences({
      changes: async () => ({
        hostId: HOST_ID,
        rev: 11,
        hasMore: false,
        items: [{ entity: "operators", id: ANNA.id, rev: 6, deleted: true }],
      }),
      local: executor,
      ...PAIRING,
    });
    view.rerender(floorOf(executor, onSignOut, { sync: { ...SYNCED, synced: 2 } }));
    await waitFor(() => expect(onSignOut).toHaveBeenCalledWith("removed"));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("signs out an operator whose newer record waits in quarantine", async () => {
    const { db, executor } = await syncedDb([OPERATOR]);
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operators', ?, 9, 'data: unrecognized_keys', 1790000000000)",
    ).run(ANNA.id);
    const onSignOut = renderFloor(executor);
    await waitFor(() => expect(onSignOut).toHaveBeenCalledWith("removed"));
  });

  it("drops a check that lands after the screen is gone", async () => {
    const gate = gatedExecutor(await synced([]));
    gate.hold();
    const onSignOut = vi.fn<(notice: FloorNotice | null) => void>();
    const view = render(floorOf(gate.local, onSignOut));
    view.unmount();
    gate.release();
    await settle();
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it("drops a check that a newer sync has replaced", async () => {
    const gate = gatedExecutor(await synced([]));
    gate.hold();
    const onSignOut = vi.fn<(notice: FloorNotice | null) => void>();
    const view = render(floorOf(gate.local, onSignOut));
    view.rerender(floorOf(gate.local, onSignOut, { sync: { ...SYNCED, synced: 2 } }));
    gate.release();
    await waitFor(() => expect(onSignOut).toHaveBeenCalled());
    // Both checks read the same copies, but only the newer one may answer.
    await settle();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("signs nobody out on a failed read, says nothing of it, and reads again after the next sync", async () => {
    const quiet = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
    ];
    const real = await synced([]);
    let broken = true;
    const flaky: LocalExecutor = {
      query: (sql, params, row) =>
        broken ? Promise.reject(new Error("disk-secret")) : real.query(sql, params, row),
      transaction: (statements) => real.transaction(statements),
    };
    const onSignOut = vi.fn<(notice: FloorNotice | null) => void>();
    const view = render(floorOf(flaky, onSignOut));
    await settle();
    expect(onSignOut).not.toHaveBeenCalled();
    expect(screen.queryByText(/disk-secret/)).toBeNull();
    broken = false;
    view.rerender(floorOf(flaky, onSignOut, { sync: { ...SYNCED, synced: 2 } }));
    await waitFor(() => expect(onSignOut).toHaveBeenCalledWith("removed"));
    for (const spy of quiet) expect(spy).not.toHaveBeenCalled();
  });

  it("signs the operator out as idle after the timeout, and not after the screen is gone", async () => {
    const local = await synced([OPERATOR]);
    vi.useFakeTimers();
    const onSignOut = vi.fn<(notice: FloorNotice | null) => void>();
    const first = render(floorOf(local, onSignOut, { idleTimeoutMs: 1_000 }));
    vi.advanceTimersByTime(999);
    expect(onSignOut).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSignOut).toHaveBeenCalledWith("idle");
    first.unmount();
    onSignOut.mockClear();
    const second = render(floorOf(local, onSignOut, { idleTimeoutMs: 1_000 }));
    second.unmount();
    vi.advanceTimersByTime(5_000);
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it("shows no empty line for an operator without a role", async () => {
    const view = render(
      floorOf(await synced([OPERATOR]), vi.fn(), { operator: { ...ANNA, role: null } }),
    );
    for (const line of view.container.querySelectorAll("p")) expect(line.textContent).not.toBe("");
  });

  it("shows the operator's name as text, whatever characters it holds", async () => {
    const name = '<img src="x" alt="boom"> Анна & <b>Кузнецова</b>';
    const view = render(
      floorOf(await synced([OPERATOR]), vi.fn(), { operator: { ...ANNA, name } }),
    );
    expect(screen.getByText(`Вошёл: ${name}, табельный номер 0042.`)).toBeTruthy();
    expect(view.container.querySelector("img, b")).toBeNull();
  });
});

describe("the operator a sign-in hands over", () => {
  it("is a new object of identity fields only each time, never the credential's row", async () => {
    const context = {
      local: await synced([OPERATOR]),
      pairing: PAIRING,
      now: () => 1_790_000_000_000,
    };
    const first = await signInWithPin(context, "0042", "4821");
    const second = await signInWithPin(context, "0042", "4821");
    if (first.kind !== "signed_in" || second.kind !== "signed_in") throw new Error("not signed in");
    // The shell tells one session from the next by this object (`App`).
    expect(second.operator).not.toBe(first.operator);
    expect(Object.keys(first.operator).sort()).toEqual(["id", "login", "name", "role"]);
    expect(first.operator).toEqual(ANNA);
  });
});

describe("the operator idle lock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits ten minutes by default, and every touch starts the wait again", () => {
    vi.useFakeTimers();
    expect(OPERATOR_IDLE_TIMEOUT_MS).toBe(600_000);
    const onIdle = vi.fn();
    const lock = createOperatorIdleLock({ target: window, onIdle });
    lock.start();
    vi.advanceTimersByTime(599_999);
    fireEvent.pointerDown(window);
    vi.advanceTimersByTime(599_999);
    fireEvent.keyDown(window, { key: "1" });
    vi.advanceTimersByTime(599_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    // Once idle, it waits for nothing more until started again.
    fireEvent.pointerDown(window);
    vi.advanceTimersByTime(600_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    lock.stop();
  });

  it("restarts the wait on a touch of the screen as on a press", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const lock = createOperatorIdleLock({ target: window, onIdle, timeoutMs: 1_000 });
    lock.start();
    vi.advanceTimersByTime(999);
    fireEvent.touchStart(window);
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    lock.stop();
  });

  it("listens for exactly a pointer, a key and a touch, and removes the same listeners", () => {
    const added: Array<[string, unknown]> = [];
    const removed: Array<[string, unknown]> = [];
    const target = {
      addEventListener: (type: string, listener: unknown) => void added.push([type, listener]),
      removeEventListener: (type: string, listener: unknown) => void removed.push([type, listener]),
    };
    const lock = createOperatorIdleLock({ target, onIdle: () => undefined, timeoutMs: 1_000 });
    lock.stop();
    expect(removed).toEqual([]);
    lock.start();
    expect(added.map(([type]) => type).sort()).toEqual(["keydown", "pointerdown", "touchstart"]);
    lock.stop();
    expect(removed.slice().sort()).toEqual(added.slice().sort());
    lock.stop();
    expect(removed).toHaveLength(3);
  });

  it("stops listening when stopped", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const lock = createOperatorIdleLock({ target: window, onIdle, timeoutMs: 1_000 });
    lock.start();
    lock.stop();
    fireEvent.pointerDown(window);
    vi.advanceTimersByTime(2_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
