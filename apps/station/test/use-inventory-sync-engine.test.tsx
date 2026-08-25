import { DatabaseSync } from "node:sqlite";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { applyMigrations } from "../src/lib/mirror.js";
import { useInventorySyncEngine } from "../src/lib/use-inventory-sync-engine.js";
import { makeExec } from "./support/sqlite-exec.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";

describe("useInventorySyncEngine", () => {
  it("polls progress while active without overlapping a rerender", async () => {
    const db = new DatabaseSync(":memory:");
    const exec = makeExec(db);
    await applyMigrations(exec);
    db.prepare(
      `INSERT INTO inventory_terminal_state
         (inventory_id, snapshot_id, device_id, next_device_sequence, updated_at)
       VALUES (?, ?, ?, 1, '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID);
    const get = vi.fn(async () => ({
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      cursor: null,
      resultRevision: 0,
      items: [],
      nextCursor: null,
    }));
    const client = { get, post: vi.fn(async () => ({})) };
    const { rerender, unmount } = renderHook(
      (active: boolean) =>
        useInventorySyncEngine({
          exec,
          client,
          inventoryId: INVENTORY_ID,
          snapshotId: SNAPSHOT_ID,
          active,
        }),
      { initialProps: true },
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    rerender(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(get).toHaveBeenCalledTimes(1);
    unmount();
  });
});
