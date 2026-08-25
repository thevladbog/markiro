import { DatabaseSync } from "node:sqlite";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { inventorySnapshotContentDigest, inventorySnapshotPageDigest } from "@markiro/domain";

import i18n from "../src/i18n/index.js";
import type { StationClient } from "../src/lib/api-client.js";
import type { InventoryFloorTask } from "../src/lib/floor-task.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import type { InventoryBundleManifest, InventoryBundlePage } from "../src/lib/inventory-mirror.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
import { TaskSelection } from "../src/pages/TaskSelection.js";

const inventoryId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "22222222-2222-4222-8222-222222222222";
const assignedLineId = "33333333-3333-4333-8333-333333333333";
const stationLineId = "55555555-5555-4555-8555-555555555555";
const barcode = `markiro:inventory:v1:${inventoryId}`;
const fixedAt = "2026-08-25T01:02:03.000Z";
const contentDigest = inventorySnapshotContentDigest([]);

const task = {
  inventoryId,
  inventoryNumber: "INV-00047",
  productName: "Вода питьевая 0,5 л",
  mode: "check" as const,
  lineId: assignedLineId,
  lineName: "Розлив №2",
  productionDateFrom: "2026-08-01",
  productionDateTo: "2026-08-31",
};

const manifest: InventoryBundleManifest = {
  ...task,
  snapshotId,
  snapshotRevision: 1,
  snapshotFixedAt: fixedAt,
  combinedDigest: "a".repeat(64),
  contentDigest,
  codeCount: 0,
  productId: "44444444-4444-4444-8444-444444444444",
  gtin14: "04600000000015",
  boxCapacity: 12,
  boxLabelTemplate: null,
  limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
  sscc: null,
  ssccRevokedFrom: [],
  ssccRevokedBlocks: [],
};

const finalPage: InventoryBundlePage = {
  snapshotId,
  snapshotRevision: 1,
  snapshotFixedAt: fixedAt,
  combinedDigest: manifest.combinedDigest,
  contentDigest,
  cursor: null,
  items: [],
  nextCursor: null,
  pageDigest: inventorySnapshotPageDigest({
    snapshotId,
    snapshotFixedAt: fixedAt,
    contentDigest,
    cursor: null,
    items: [],
    nextCursor: null,
  }),
};

function executor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

function scanner() {
  let listener: ScanListener | null = null;
  let stopped = false;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        stopped = true;
        listener = null;
      };
    },
  };
  return {
    source,
    scan(raw: string) {
      listener?.(raw);
    },
    stopped: () => stopped,
  };
}

function client(input: { listed?: boolean; requiresConfirmation?: boolean } = {}) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const gets: string[] = [];
  const api: StationClient = {
    async get<T>(path: string): Promise<T> {
      gets.push(path);
      let value: unknown;
      if (path === "/station/inventory-tasks") {
        value = { items: input.listed === false ? [] : [task] };
      } else if (path === "/shifts") {
        value = { items: [] };
      } else if (path.endsWith("/bundle/manifest")) {
        value = manifest;
      } else if (path.includes("/bundle/codes?")) {
        value = finalPage;
      } else {
        throw new Error(`Unexpected GET ${path}`);
      }
      return value as T;
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      posts.push({ path, body });
      let value: unknown;
      if (path === "/station/inventory-tasks/resolve-barcode") {
        value = {
          task,
          deviceLineId: stationLineId,
          requiresDifferentLineConfirmation: input.requiresConfirmation !== false,
        };
      } else if (path === `/station/inventories/${inventoryId}/join`) {
        value = manifest;
      } else {
        throw new Error(`Unexpected POST ${path}`);
      }
      return value as T;
    },
    async download() {
      throw new Error("not used");
    },
    async whoami() {
      return { ok: true as const };
    },
  };
  return { api, gets, posts };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("TaskSelection inventory entry", () => {
  it("does not refetch task lists when App replaces only its generation-check callback", async () => {
    const exec = executor();
    await applyMigrations(exec);
    const scan = scanner();
    const { api, gets } = client();
    const props = {
      client: api,
      exec,
      source: scan.source,
      operatorId: "66666666-6666-4666-8666-666666666666",
      currentLineName: "Packing A",
      onShiftSelected: () => {},
      onInventorySelected: () => {},
      onNew: () => {},
    };
    const view = render(<TaskSelection {...props} isCurrent={() => true} />);
    await screen.findByText("INV-00047");

    await act(async () => {
      view.rerender(<TaskSelection {...props} isCurrent={() => true} />);
      await Promise.resolve();
    });

    expect(gets.filter((path) => path === "/station/inventory-tasks")).toHaveLength(1);
    expect(gets.filter((path) => path === "/shifts")).toHaveLength(1);
  });

  it("shows only the assigned-line inventory list returned by the strict task endpoint", async () => {
    const exec = executor();
    await applyMigrations(exec);
    const scan = scanner();
    const { api } = client();

    render(
      <TaskSelection
        client={api}
        exec={exec}
        source={scan.source}
        operatorId="66666666-6666-4666-8666-666666666666"
        currentLineName="Packing A"
        onShiftSelected={() => {}}
        onInventorySelected={() => {}}
        onNew={() => {}}
      />,
    );

    expect(await screen.findByText("INV-00047")).toBeDefined();
    expect(screen.getByText("Вода питьевая 0,5 л")).toBeDefined();
    expect(screen.queryByText("Standalone disaggregation")).toBeNull();
  });

  it("makes a different-line barcode cancel a no-op and joins only after explicit confirmation", async () => {
    const exec = executor();
    await applyMigrations(exec);
    const scan = scanner();
    const { api, posts } = client({ listed: false });
    const onInventorySelected = vi.fn<(task: InventoryFloorTask) => void>();

    render(
      <TaskSelection
        client={api}
        exec={exec}
        source={scan.source}
        operatorId="66666666-6666-4666-8666-666666666666"
        currentLineName="Packing A"
        onShiftSelected={() => {}}
        onInventorySelected={onInventorySelected}
        onNew={() => {}}
      />,
    );
    await screen.findByText("No open shifts");

    scan.scan(barcode);
    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText("Task is assigned to another line")).toBeDefined();
    expect(screen.getByText("Packing A")).toBeDefined();
    expect(screen.getByText("Розлив №2")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onInventorySelected).not.toHaveBeenCalled();
    expect(posts.some(({ path }) => path.endsWith("/join"))).toBe(false);

    scan.scan(barcode);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Join INV-00047" }));

    await waitFor(() => expect(onInventorySelected).toHaveBeenCalledOnce());
    expect(onInventorySelected).toHaveBeenCalledWith({ kind: "inventory", inventory: manifest });
    expect(posts.find(({ path }) => path.endsWith("/join"))?.body).toEqual({
      operatorId: "66666666-6666-4666-8666-666666666666",
      barcode,
      confirmDifferentLine: true,
    });
    expect(
      await exec.all<{ value: string }>("SELECT value FROM station_meta WHERE key = ?", [
        "active_inventory_floor_task_v1",
      ]),
    ).toEqual([{ value: JSON.stringify({ inventoryId, snapshotId }) }]);
  });

  it("publishes an assigned task only after the verified bundle and releases barcode interception on unmount", async () => {
    const exec = executor();
    await applyMigrations(exec);
    const scan = scanner();
    const { api, posts } = client();
    const onInventorySelected = vi.fn<(task: InventoryFloorTask) => void>();

    const view = render(
      <TaskSelection
        client={api}
        exec={exec}
        source={scan.source}
        operatorId="66666666-6666-4666-8666-666666666666"
        currentLineName="Розлив №2"
        onShiftSelected={() => {}}
        onInventorySelected={onInventorySelected}
        onNew={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Continue INV-00047" }));
    await waitFor(() => expect(onInventorySelected).toHaveBeenCalledOnce());
    expect(posts.find(({ path }) => path.endsWith("/join"))?.body).toEqual({
      operatorId: "66666666-6666-4666-8666-666666666666",
    });

    view.unmount();
    expect(scan.stopped()).toBe(true);
    const postCount = posts.length;
    scan.scan(barcode);
    expect(posts).toHaveLength(postCount);
  });
});
