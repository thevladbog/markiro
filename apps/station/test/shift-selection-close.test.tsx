import { DatabaseSync } from "node:sqlite";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { createStationClient } from "../src/lib/api-client.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  closeShiftOffline,
  markShiftCloseAccepted,
  markShiftCloseConflict,
} from "../src/lib/shift-close.js";
import { ShiftSelection } from "../src/pages/ShiftSelection.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.restoreAllMocks();
});

const client = createStationClient({
  machineId: "m1",
  apiKey: "k",
  serverUrl: "http://localhost:3000",
});
const item = {
  id: "s1",
  status: "active",
  mode: "validation",
  productId: "p1",
  productName: "Duplicate label shift",
  plannedQty: null,
  image: null,
};

async function setup(mode = "validation") {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  await applyMigrations(exec);
  await exec.run(
    "INSERT INTO shift_mirror (id, status, mode, product_id, product_name, validation_print_context) VALUES (?, 'active', ?, ?, ?, ?)",
    [
      item.id,
      mode,
      item.productId,
      item.productName,
      mode === "validation" ? JSON.stringify({ policy: { mode: "duplicate_dm" } }) : null,
    ],
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(JSON.stringify({ items: [{ ...item, mode }] })),
  );
  const onSelected = vi.fn();
  const close = () =>
    closeShiftOffline(exec, {
      shiftId: item.id,
      deviceId: "m1",
      operatorId: null,
      credentialOwnership: "owner",
    });
  const show = () =>
    render(<ShiftSelection client={client} exec={exec} onSelected={onSelected} onNew={() => {}} />);
  return { exec, close, show, onSelected };
}

describe("shift selection after durable local close", () => {
  it.each(["validation", "aggregation"])(
    "keeps %s closure pending across remounts and blocks rejoin",
    async (mode) => {
      const { close, show, onSelected } = await setup(mode);
      await close();
      const first = show();
      await screen.findByText("Closing");
      first.unmount();
      show();
      await screen.findByText("Closing");
      const rejoin = screen.getByRole("button", { name: "Rejoin" });
      expect((rejoin as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(rejoin);
      expect(onSelected).not.toHaveBeenCalled();
    },
  );

  it("keeps an acknowledged closure hidden when a stale active list arrives after outbox deletion", async () => {
    const { exec, close, show, onSelected } = await setup();
    const summary = await close();
    let resolveList!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    show();
    await markShiftCloseAccepted(exec, summary.eventId);
    await act(async () => {
      resolveList(new Response(JSON.stringify({ items: [item] })));
    });
    await screen.findByText("No open shifts");
    expect(screen.queryByRole("button", { name: "Rejoin" })).toBeNull();
    expect(onSelected).not.toHaveBeenCalled();
  });

  it("removes the closing card on refresh after acknowledgement", async () => {
    const { exec, close, show } = await setup();
    const summary = await close();
    show();
    await screen.findByText("Closing");
    await markShiftCloseAccepted(exec, summary.eventId);
    fireEvent.click(screen.getByRole("button", { name: "Refresh shifts" }));
    await screen.findByText("No open shifts");
  });

  it("keeps a close conflict unavailable for rejoin", async () => {
    const { exec, close, show } = await setup();
    const summary = await close();
    await markShiftCloseConflict(exec, summary.eventId, "multiple_devices");
    show();
    await screen.findByText("No open shifts");
    expect(screen.queryByRole("button", { name: "Rejoin" })).toBeNull();
  });

  it("rechecks local closure at entry when the rendered active card has gone stale", async () => {
    const { close, show, onSelected } = await setup();
    show();
    await screen.findByText("Shift active");
    await close();
    fireEvent.click(screen.getByRole("button", { name: "Rejoin" }));
    await screen.findByText("Closing");
    expect(onSelected).not.toHaveBeenCalled();
  });

  it("does not allow entry when the local close state cannot be read", async () => {
    const { exec, show, onSelected } = await setup();
    vi.spyOn(exec, "all").mockRejectedValue(new Error("database unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    show();
    await waitFor(() => expect(screen.queryByText("Loading shifts…")).toBeNull());
    expect(screen.queryByRole("button", { name: "Rejoin" })).toBeNull();
    expect(onSelected).not.toHaveBeenCalled();
  });

  it("cancels route entry if closing began while its lease was pending", async () => {
    const { exec, close, onSelected } = await setup();
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const release = vi.fn();
    const commit = vi.fn(() => true);
    const cancel = vi.fn(async () => {});
    render(
      <ShiftSelection
        client={client}
        exec={exec}
        onSelected={onSelected}
        onNew={() => {}}
        onRouteIntent={() => ({ ready: Promise.resolve(), commit, cancel })}
        acquireShiftEntry={async () => {
          await barrier;
          return { isCurrent: () => true, release };
        }}
      />,
    );
    await screen.findByText("Shift active");
    fireEvent.click(screen.getByRole("button", { name: "Rejoin" }));
    await close();
    await act(async () => {
      releaseBarrier();
    });
    await screen.findByText("Closing");
    expect(onSelected).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
