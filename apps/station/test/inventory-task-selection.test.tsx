import { DatabaseSync } from "node:sqlite";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { inventorySnapshotContentDigest, inventorySnapshotPageDigest } from "@markiro/domain";

import i18n from "../src/i18n/index.js";
import type { StationClient } from "../src/lib/api-client.js";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
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

const shifts = [
  {
    id: "shift-1",
    number: "SHIFT-001",
    status: "planned",
    mode: "validation",
    productName: "Production water",
    productPrintName: null,
    plannedQty: 100,
    plannedDate: "2026-08-25",
    productionDate: "2026-08-24",
    counterpartyName: null,
    productId: "77777777-7777-4777-8777-777777777777",
    image: null,
  },
  {
    id: "shift-2",
    number: "SHIFT-002",
    status: "active",
    mode: "aggregation",
    productName: "Production juice",
    productPrintName: null,
    plannedQty: 200,
    plannedDate: "2026-08-25",
    productionDate: "2026-08-24",
    counterpartyName: null,
    productId: "88888888-8888-4888-8888-888888888888",
    image: null,
  },
] as const;

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function suspendedExecutor(
  shouldSuspend: (kind: "run" | "all", sql: string, params: unknown[]) => boolean,
) {
  const db = new DatabaseSync(":memory:");
  const gate = deferred<void>();
  const started = deferred<void>();
  let suspended = false;
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      if (!suspended && shouldSuspend("run", sql, params)) {
        suspended = true;
        started.resolve();
        await gate.promise;
      }
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (!suspended && shouldSuspend("all", sql, params)) {
        suspended = true;
        started.resolve();
        await gate.promise;
      }
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  return { exec, started: started.promise, release: gate.resolve };
}

function client(
  input: {
    listed?: boolean;
    requiresConfirmation?: boolean;
    shifts?: readonly (typeof shifts)[number][];
    inventoryLists?: unknown[];
    inventoryListResponse?: Promise<unknown>;
    joinResponse?: Promise<unknown>;
    manifestResponse?: Promise<unknown>;
    pageResponse?: Promise<unknown>;
  } = {},
) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const gets: string[] = [];
  let inventoryListIndex = 0;
  const api: StationClient = {
    async get<T>(path: string): Promise<T> {
      gets.push(path);
      let value: unknown;
      if (path === "/station/inventory-tasks") {
        value = input.inventoryListResponse
          ? await input.inventoryListResponse
          : (input.inventoryLists?.[
              Math.min(inventoryListIndex++, input.inventoryLists.length - 1)
            ] ?? { items: input.listed === false ? [] : [task] });
        if (value instanceof Error) throw value;
      } else if (path === "/shifts") {
        value = { items: input.shifts ?? [] };
      } else if (path.endsWith("/bundle/manifest")) {
        value = input.manifestResponse ? await input.manifestResponse : manifest;
      } else if (path.includes("/bundle/codes?")) {
        value = input.pageResponse ? await input.pageResponse : finalPage;
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
        value = input.joinResponse ? await input.joinResponse : manifest;
      } else if (path === "/shifts/shift-1/open") {
        value = { id: "shift-1", status: "active", mode: "validation" };
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

function openWarehouseCategoryIfPresent() {
  const warehouse = screen.queryByRole("tab", { name: /Warehouse operations/ });
  if (warehouse) fireEvent.click(warehouse);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskSelection inventory entry", () => {
  it("retires an old client activation suspended in its pointer write before replacement can continue", async () => {
    const suspended = suspendedExecutor(
      (kind, sql, params) =>
        kind === "run" &&
        sql.includes("INSERT INTO station_meta") &&
        params[0] === "active_inventory_floor_task_v1",
    );
    await applyMigrations(suspended.exec);
    const scan = scanner();
    const old = client();
    const replacementList = deferred<unknown>();
    const replacement = client({ inventoryListResponse: replacementList.promise });
    const onInventorySelected = vi.fn();
    const props = {
      exec: suspended.exec,
      source: scan.source,
      operatorId: "66666666-6666-4666-8666-666666666666",
      currentLineName: "Розлив №2",
      onShiftSelected: () => {},
      onInventorySelected,
      onNew: () => {},
    };
    const view = render(
      <TaskSelection
        {...props}
        client={old.api}
        credentialGeneration={createCredentialGeneration("credential-a")}
      />,
    );
    openWarehouseCategoryIfPresent();
    fireEvent.click(await screen.findByRole("button", { name: "Continue INV-00047" }));
    await suspended.started;

    view.rerender(
      <TaskSelection
        {...props}
        client={replacement.api}
        credentialGeneration={createCredentialGeneration("credential-b")}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Loading inventory tasks");
    suspended.release();
    await act(async () => {});

    expect(onInventorySelected).not.toHaveBeenCalled();
    expect(
      await suspended.exec.all("SELECT value FROM station_meta WHERE key = ?", [
        "active_inventory_floor_task_v1",
      ]),
    ).toEqual([]);
  });

  it.each([
    ["activation read", "production shift"],
    ["activation read", "new shift"],
    ["activation read", "setup"],
    ["pointer write", "production shift"],
    ["pointer write", "new shift"],
    ["pointer write", "setup"],
  ] as const)(
    "waits a suspended %s before entering %s and leaves no resumable inventory pointer",
    async (suspension, destination) => {
      const suspended = suspendedExecutor((kind, sql, params) => {
        if (suspension === "activation read") {
          return (
            kind === "all" && /SELECT inventory_id, inventory_number, active_snapshot_id/.test(sql)
          );
        }
        return (
          kind === "run" &&
          sql.includes("INSERT INTO station_meta") &&
          params[0] === "active_inventory_floor_task_v1"
        );
      });
      await applyMigrations(suspended.exec);
      const scan = scanner();
      const { api } = client({ shifts });
      const onShiftSelected = vi.fn();
      const onInventorySelected = vi.fn();
      const onNew = vi.fn();
      const onSetup = vi.fn();
      const view = render(
        <TaskSelection
          client={api}
          exec={suspended.exec}
          source={scan.source}
          operatorId="66666666-6666-4666-8666-666666666666"
          currentLineName="Розлив №2"
          onShiftSelected={onShiftSelected}
          onInventorySelected={onInventorySelected}
          onNew={onNew}
          onSetup={onSetup}
          credentialGeneration={createCredentialGeneration("credential-a")}
        />,
      );
      openWarehouseCategoryIfPresent();
      fireEvent.click(await screen.findByRole("button", { name: "Continue INV-00047" }));
      await suspended.started;

      const production = screen.queryByRole("tab", { name: /Production shifts/ });
      if (destination !== "setup" && production) fireEvent.click(production);
      if (destination === "production shift") {
        fireEvent.click(screen.getByRole("button", { name: "Open" }));
      } else if (destination === "new shift") {
        fireEvent.click(screen.getByRole("button", { name: "New shift" }));
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));
      }
      await act(async () => {});

      const routeCallback =
        destination === "production shift"
          ? onShiftSelected
          : destination === "new shift"
            ? onNew
            : onSetup;
      if (routeCallback) expect(routeCallback).not.toHaveBeenCalled();

      suspended.release();
      await waitFor(() => expect(routeCallback).toHaveBeenCalledOnce());
      expect(onInventorySelected).not.toHaveBeenCalled();
      expect(
        await suspended.exec.all("SELECT value FROM station_meta WHERE key = ?", [
          "active_inventory_floor_task_v1",
        ]),
      ).toEqual([]);
      view.unmount();
    },
  );

  it("clears prior-client rows and barcode confirmation while the replacement client is pending", async () => {
    const exec = executor();
    await applyMigrations(exec);
    const scan = scanner();
    const old = client();
    const replacementList = deferred<unknown>();
    const replacement = client({ inventoryListResponse: replacementList.promise });
    const props = {
      exec,
      source: scan.source,
      operatorId: "66666666-6666-4666-8666-666666666666",
      currentLineName: "Розлив №2",
      onShiftSelected: () => {},
      onInventorySelected: () => {},
      onNew: () => {},
    };
    const view = render(<TaskSelection {...props} client={old.api} />);
    openWarehouseCategoryIfPresent();
    expect(await screen.findByText("INV-00047")).toBeDefined();
    act(() => scan.scan(barcode));
    expect(
      await screen.findByRole("dialog", { name: "Task is assigned to another line" }),
    ).toBeDefined();

    view.rerender(<TaskSelection {...props} client={replacement.api} />);

    expect(screen.queryByText("INV-00047")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Task is assigned to another line" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Loading inventory tasks");
    expect(screen.queryByRole("button", { name: "Continue INV-00047" })).toBeNull();
    expect(replacement.posts).toEqual([]);
  });

  it("keeps replacement loading fenced from an old request finally and exposes no old rows on replacement failure", async () => {
    const exec = executor();
    await applyMigrations(exec);
    const scan = scanner();
    const oldList = deferred<unknown>();
    const replacementList = deferred<unknown>();
    const old = client({ inventoryListResponse: oldList.promise });
    const replacement = client({ inventoryListResponse: replacementList.promise });
    const props = {
      exec,
      source: scan.source,
      operatorId: "66666666-6666-4666-8666-666666666666",
      currentLineName: "Розлив №2",
      onShiftSelected: () => {},
      onInventorySelected: () => {},
      onNew: () => {},
    };
    const view = render(<TaskSelection {...props} client={old.api} />);
    openWarehouseCategoryIfPresent();
    view.rerender(<TaskSelection {...props} client={replacement.api} />);

    oldList.resolve({ items: [task] });
    await act(async () => {});
    expect(screen.queryByText("INV-00047")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Loading inventory tasks");

    replacementList.resolve(new Error("replacement offline"));
    expect(await screen.findByText(/Could not load inventory tasks/)).toBeDefined();
    expect(screen.queryByText("INV-00047")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue INV-00047" })).toBeNull();
    expect(replacement.posts).toEqual([]);
  });

  it.each(["production shift", "new shift", "setup", "selection unmount"] as const)(
    "does not publish a retired join after routing to %s",
    async (destination) => {
      const exec = executor();
      await applyMigrations(exec);
      const scan = scanner();
      const pendingJoin = deferred<unknown>();
      const { api, posts } = client({ shifts, joinResponse: pendingJoin.promise });
      const onShiftSelected = vi.fn();
      const onNew = vi.fn();
      const onSetup = vi.fn();
      const view = render(
        <TaskSelection
          client={api}
          exec={exec}
          source={scan.source}
          operatorId="66666666-6666-4666-8666-666666666666"
          currentLineName="Розлив №2"
          onShiftSelected={onShiftSelected}
          onInventorySelected={() => {}}
          onNew={onNew}
          onSetup={onSetup}
        />,
      );
      openWarehouseCategoryIfPresent();
      fireEvent.click(await screen.findByRole("button", { name: "Continue INV-00047" }));
      await waitFor(() => expect(posts.some(({ path }) => path.endsWith("/join"))).toBe(true));

      let routeCallback: ReturnType<typeof vi.fn> | null = null;
      if (destination === "production shift") {
        const production = screen.queryByRole("tab", { name: /Production shifts/ });
        if (production) fireEvent.click(production);
        fireEvent.click(screen.getByRole("button", { name: "Open" }));
        routeCallback = onShiftSelected;
      } else if (destination === "new shift") {
        const production = screen.queryByRole("tab", { name: /Production shifts/ });
        if (production) fireEvent.click(production);
        fireEvent.click(screen.getByRole("button", { name: "New shift" }));
        routeCallback = onNew;
      } else if (destination === "setup") {
        fireEvent.click(screen.getByRole("button", { name: "Workstation setup" }));
        routeCallback = onSetup;
      } else {
        view.unmount();
      }
      if (routeCallback) expect(routeCallback).not.toHaveBeenCalled();
      pendingJoin.resolve(manifest);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (routeCallback) await waitFor(() => expect(routeCallback).toHaveBeenCalledOnce());

      expect(
        await exec.all("SELECT value FROM station_meta WHERE key = ?", [
          "active_inventory_floor_task_v1",
        ]),
      ).toEqual([]);
      expect(
        await exec.all(
          "SELECT active_snapshot_id FROM inventory_task_mirror WHERE inventory_id = ?",
          [inventoryId],
        ),
      ).toEqual([]);
      if (destination !== "selection unmount") view.unmount();
    },
  );

  it("does not publish when operator switch seals the credential generation during manifest download", async () => {
    const exec = executor();
    await applyMigrations(exec);
    const scan = scanner();
    const pendingManifest = deferred<unknown>();
    const { api, gets } = client({ manifestResponse: pendingManifest.promise });
    let current = true;
    render(
      <TaskSelection
        client={api}
        exec={exec}
        source={scan.source}
        operatorId="66666666-6666-4666-8666-666666666666"
        currentLineName="Розлив №2"
        onShiftSelected={() => {}}
        onInventorySelected={() => {}}
        onNew={() => {}}
        isCurrent={() => current}
      />,
    );
    openWarehouseCategoryIfPresent();
    fireEvent.click(await screen.findByRole("button", { name: "Continue INV-00047" }));
    await waitFor(() => expect(gets.some((path) => path.endsWith("/manifest"))).toBe(true));

    current = false;
    pendingManifest.resolve(manifest);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      await exec.all("SELECT value FROM station_meta WHERE key = ?", [
        "active_inventory_floor_task_v1",
      ]),
    ).toEqual([]);
    expect(
      await exec.all(
        "SELECT active_snapshot_id FROM inventory_task_mirror WHERE inventory_id = ?",
        [inventoryId],
      ),
    ).toEqual([]);
  });

  it("recovers a failed inventory list through the shared manual refresh", async () => {
    const exec = executor();
    await applyMigrations(exec);
    const scan = scanner();
    const { api, gets } = client({
      shifts,
      inventoryLists: [new Error("temporary inventory outage"), { items: [task] }],
    });
    render(
      <TaskSelection
        client={api}
        exec={exec}
        source={scan.source}
        operatorId="66666666-6666-4666-8666-666666666666"
        currentLineName="Розлив №2"
        onShiftSelected={() => {}}
        onInventorySelected={() => {}}
        onNew={() => {}}
      />,
    );
    openWarehouseCategoryIfPresent();
    expect(await screen.findByText(/Could not load inventory tasks/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Refresh tasks" }));

    expect(await screen.findByText("INV-00047")).toBeDefined();
    expect(gets.filter((path) => path === "/station/inventory-tasks")).toHaveLength(2);
  });

  it("removes a stopped inventory task through the shared 30 second poll without request storms", async () => {
    vi.useFakeTimers();
    const exec = executor();
    await applyMigrations(exec);
    const scan = scanner();
    const { api, gets } = client({
      shifts,
      inventoryLists: [{ items: [task] }, { items: [] }],
    });
    render(
      <TaskSelection
        client={api}
        exec={exec}
        source={scan.source}
        operatorId="66666666-6666-4666-8666-666666666666"
        currentLineName="Розлив №2"
        onShiftSelected={() => {}}
        onInventorySelected={() => {}}
        onNew={() => {}}
      />,
    );
    await act(async () => {});
    openWarehouseCategoryIfPresent();
    expect(screen.getByText("INV-00047")).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.queryByText("INV-00047")).toBeNull();
    expect(screen.getByText("No inventory tasks are assigned to this line.")).toBeDefined();
    expect(gets.filter((path) => path === "/station/inventory-tasks")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /Warehouse operations 0/ })).toBeDefined();
    vi.useRealTimers();
  });

  it("keeps two shifts and warehouse work on separate fixed 1024 categories", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    const exec = executor();
    await applyMigrations(exec);
    const scan = scanner();
    const { api } = client({ shifts });
    render(
      <TaskSelection
        client={api}
        exec={exec}
        source={scan.source}
        operatorId="66666666-6666-4666-8666-666666666666"
        currentLineName="Розлив №2"
        onShiftSelected={() => {}}
        onInventorySelected={() => {}}
        onNew={() => {}}
      />,
    );

    expect(await screen.findAllByRole("button", { name: "Open" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Rejoin" })).toBeDefined();
    const categories = screen.getByRole("tablist", { name: "Floor task categories" });
    const production = screen.getByRole("tab", { name: "Production shifts 2" });
    const warehouse = screen.getByRole("tab", { name: "Warehouse operations 1" });
    expect(categories.contains(production)).toBe(true);
    expect(categories.contains(warehouse)).toBe(true);
    expect(production.getAttribute("aria-selected")).toBe("true");
    expect(production.classList.contains("mk-btn--floor")).toBe(true);
    expect(warehouse.classList.contains("mk-btn--floor")).toBe(true);
    expect(screen.queryByText("INV-00047")).toBeNull();

    fireEvent.click(warehouse);
    expect(await screen.findByText("INV-00047")).toBeDefined();
    expect(screen.getByText("Scan the task-form barcode")).toBeDefined();
    expect(screen.queryByText("Production water")).toBeNull();
    expect(screen.queryByText("Production juice")).toBeNull();
    expect(screen.queryByRole("button", { name: "New shift" })).toBeNull();
    expect(screen.getByRole("button", { name: "Continue INV-00047" })).toBeDefined();
    expect(screen.queryByText("Standalone disaggregation")).toBeNull();

    fireEvent.click(production);
    expect(await screen.findByText("Production water")).toBeDefined();
    expect(screen.getByText("Production juice")).toBeDefined();
    expect(screen.queryByText("INV-00047")).toBeNull();
    expect(screen.getByRole("button", { name: "New shift" })).toBeDefined();
  });

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
    openWarehouseCategoryIfPresent();
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

    openWarehouseCategoryIfPresent();
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

    act(() => scan.scan(barcode));
    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText("Task is assigned to another line")).toBeDefined();
    expect(screen.getByText("Packing A")).toBeDefined();
    expect(screen.getByText("Розлив №2")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onInventorySelected).not.toHaveBeenCalled();
    expect(posts.some(({ path }) => path.endsWith("/join"))).toBe(false);

    act(() => scan.scan(barcode));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Join INV-00047" }));

    await waitFor(() => expect(onInventorySelected).toHaveBeenCalledOnce());
    expect(onInventorySelected).toHaveBeenCalledWith({ kind: "inventory", inventory: manifest });
    expect(posts.find(({ path }) => path.endsWith("/join"))?.body).toEqual({
      operatorId: "66666666-6666-4666-8666-666666666666",
      barcode,
      confirmDifferentLine: true,
    });
    const pointerRows = await exec.all<{ value: string }>(
      "SELECT value FROM station_meta WHERE key = ?",
      ["active_inventory_floor_task_v1"],
    );
    expect(pointerRows).toHaveLength(1);
    expect(JSON.parse(pointerRows[0]!.value)).toMatchObject({
      inventoryId,
      snapshotId,
      activationId: expect.any(String),
    });
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

    openWarehouseCategoryIfPresent();
    fireEvent.click(await screen.findByRole("button", { name: "Continue INV-00047" }));
    await waitFor(() => expect(onInventorySelected).toHaveBeenCalledOnce());
    expect(posts.find(({ path }) => path.endsWith("/join"))?.body).toEqual({
      operatorId: "66666666-6666-4666-8666-666666666666",
    });

    view.unmount();
    expect(scan.stopped()).toBe(true);
    const postCount = posts.length;
    act(() => scan.scan(barcode));
    expect(posts).toHaveLength(postCount);
  });
});
