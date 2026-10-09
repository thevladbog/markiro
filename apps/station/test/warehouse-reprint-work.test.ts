import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  productLabelValueDigest,
  warehouseBoxTemplate,
  buildWarehouseCodeOnlyLabelTemplate,
  WAREHOUSE_REPRINT_PROTOCOL,
  warehouseBoxSource,
} from "@markiro/domain";
import { applyMigrations } from "../src/lib/mirror";
import { makeRotatingExec } from "./support/sqlite-exec";
import { createCredentialGeneration } from "../src/lib/credential-recovery";
import type { StationClient } from "../src/lib/api-client";
import { createWarehouseWork } from "../src/lib/warehouse-reprint/work";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint";
vi.mock("../src/lib/rasterizer", () => ({
  rasterizeText: async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  }),
}));
it("retires delayed lookup without cache writes or printing and resumes the same identity set", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, i.operatorId);
  const box = warehouseBoxTemplate();
  const { digest, ...u } = {
    ...box,
    purpose: "product_duplicate" as const,
    id: crypto.randomUUID(),
    spec: buildWarehouseCodeOnlyLabelTemplate().spec,
  };
  void digest;
  const unit = { ...u, digest: productLabelValueDigest(u) };
  let complete: (value: unknown) => void = () => {};
  const response = new Promise((resolve) => {
    complete = resolve;
  });
  const client = {
    get: async () => ({
      protocol: WAREHOUSE_REPRINT_PROTOCOL,
      revision: productLabelValueDigest([unit, box]),
      templates: [unit, box],
    }),
    post: vi.fn(() => response),
  } as unknown as StationClient;
  const print = vi.fn();
  const options = {
    exec,
    client,
    generation: createCredentialGeneration("owned-key"),
    deviceId: i.deviceId,
    operatorId: i.operatorId,
    hardware: () => ({
      scanner: null,
      printer: i.printer.target,
      printerLanguage: "tspl" as const,
      printerDpi: 203 as const,
      verifyPrintedLabel: false,
    }),
    print,
  };
  try {
    const work = createWarehouseWork(options);
    await work.initialize();
    await work.configure("damaged", unit, box);
    await work.start();
    const scan = work.scan(`!100${i.source.identity}`);
    await vi.waitFor(() => expect(client.post).toHaveBeenCalled());
    const close = work.close();
    complete({ status: "found", source: warehouseBoxSource(), repair: "legacy_tspl_fnc1_literal" });
    await scan;
    await close;
    expect(print).not.toHaveBeenCalled();
    expect(await exec.all("SELECT job_id FROM warehouse_reprint_jobs")).toEqual([]);
    expect(await exec.all("SELECT identity FROM warehouse_reprint_cache WHERE kind='box'")).toEqual(
      [],
    );
    const resumed = createWarehouseWork(options);
    await resumed.initialize();
    expect(resumed.getSnapshot().session?.sessionId).toBe(work.getSnapshot().session?.sessionId);
    const oldId = resumed.getSnapshot().session?.sessionId;
    await resumed.newSession();
    expect(resumed.getSnapshot().session?.sessionId).not.toBe(oldId);
    expect(resumed.getSnapshot().session?.sentCount).toBe(0);
    await resumed.close();
  } finally {
    db.close();
  }
});
it("checks the current local operator roster before preparing a label", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, i.operatorId);
  const box = warehouseBoxTemplate();
  const { digest, ...v } = {
    ...box,
    purpose: "product_duplicate" as const,
    id: crypto.randomUUID(),
    spec: buildWarehouseCodeOnlyLabelTemplate().spec,
  };
  void digest;
  const unit = { ...v, digest: productLabelValueDigest(v) };
  const client = {
    get: () =>
      Promise.resolve({
        protocol: WAREHOUSE_REPRINT_PROTOCOL,
        revision: productLabelValueDigest([unit, box]),
        templates: [unit, box],
      }),
    post: vi.fn().mockResolvedValue({
      status: "found",
      source: warehouseBoxSource(),
      repair: "legacy_tspl_fnc1_literal",
    }),
  } as unknown as StationClient;
  const print = vi.fn();
  const work = createWarehouseWork({
    exec,
    client,
    generation: createCredentialGeneration("active-key"),
    deviceId: i.deviceId,
    operatorId: i.operatorId,
    hardware: () => ({
      scanner: null,
      printer: i.printer.target,
      printerLanguage: "tspl",
      printerDpi: 203,
      verifyPrintedLabel: false,
    }),
    print,
  });
  try {
    await work.initialize();
    await work.configure("damaged", unit, box);
    await work.start();
    await exec.run("UPDATE operators_mirror SET active=0");
    await work.scan(`!100${i.source.identity}`);
    expect(print).not.toHaveBeenCalled();
    expect(work.getSnapshot().error).toBe("WAREHOUSE_OPERATOR_DENIED");
    await work.close();
  } finally {
    db.close();
  }
});

it("restores retained warehouse work under a replacement key of the same device", async () => {
  const { initializeDeviceRecovery, sealDeviceRecovery, restoreDeviceRecovery } =
    await import("../src/lib/device-recovery");
  const { credentialGenerationOwnership } = await import("../src/lib/credential-recovery");
  const { saveWarehouseSession, prepareWarehouseJob, appendWarehouseEvent, readWarehouseJob } =
    await import("../src/lib/warehouse-reprint/store");
  const { cacheWarehouseSource, findWarehouseSource } =
    await import("../src/lib/warehouse-reprint/sources");
  const { syncWarehouseEvents } = await import("../src/lib/warehouse-reprint/sync");
  const { resolveWarehouseReprintScan } = await import("@markiro/domain");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const generation = createCredentialGeneration("key-a");
  const owner = await credentialGenerationOwnership(generation);
  if (!owner) throw new Error("owner");
  const i = { ...warehousePreparedJobInput(), owner };
  const config = {
    machineId: "local",
    tenantId: "tenant",
    deviceId: i.deviceId,
    serverUrl: "https://api.example/api",
    apiKey: "key-a",
  };
  const view = await initializeDeviceRecovery(exec, config);
  if (!view.owner) throw new Error("device owner");
  await seedWarehouseOperator(exec, i.operatorId);
  await saveWarehouseSession(exec, {
    owner,
    sessionId: i.sessionId,
    operatorId: i.operatorId,
    reason: i.reason,
    status: "active",
    unitTemplate: null,
    boxTemplate: i.template,
  });
  await prepareWarehouseJob(exec, i);
  await cacheWarehouseSource(exec, owner, i.source);
  await appendWarehouseEvent(exec, owner, {
    kind: "sending",
    eventId: crypto.randomUUID(),
    jobId: i.jobId,
    sessionId: i.sessionId,
    attemptId: i.preparedEvent.attemptId,
    operatorId: i.operatorId,
    sequence: 2,
    occurredAt: i.preparedEvent.occurredAt,
  });
  await sealDeviceRecovery(exec, config, generation);
  await restoreDeviceRecovery(
    exec,
    view.owner,
    {
      deviceId: i.deviceId,
      tenantId: "tenant",
      serverUrl: config.serverUrl,
      apiKey: "key-b",
      deviceName: "Station",
      organizationName: "Org",
      operators: [],
    },
    async () => {},
  );
  await seedWarehouseOperator(exec, i.operatorId);
  const replacement = createCredentialGeneration("key-b");
  const nextOwner = await credentialGenerationOwnership(replacement);
  if (!nextOwner) throw new Error("owner");
  const client = {
    get: vi.fn().mockRejectedValue(new TypeError("offline")),
    post: vi.fn(async (_path: string, body: unknown) => {
      const input = body as { events: { eventId: string }[] };
      return {
        protocol: "warehouse-label-reprint-v1",
        acceptedEventIds: input.events.map((e) => e.eventId),
        quarantined: [],
      };
    }),
  } as unknown as StationClient;
  const print = vi.fn();
  const work = createWarehouseWork({
    exec,
    client,
    generation: replacement,
    deviceId: i.deviceId,
    operatorId: i.operatorId,
    hardware: () => ({
      scanner: null,
      printer: i.printer.target,
      printerLanguage: "tspl",
      printerDpi: 203,
      verifyPrintedLabel: false,
    }),
    print,
  });
  try {
    await work.initialize();
    expect(work.getSnapshot().session?.sessionId).toBe(i.sessionId);
    expect(work.getSnapshot().job?.state).toBe("delivery_unknown");
    expect((await readWarehouseJob(exec, nextOwner, i.jobId)).owner).toBe(owner);
    expect(
      await findWarehouseSource(
        exec,
        nextOwner,
        resolveWarehouseReprintScan(`00${i.source.identity}`),
      ),
    ).toEqual(i.source);
    await expect(readWarehouseJob(exec, "foreign-key", i.jobId)).rejects.toThrow();
    await syncWarehouseEvents(exec, client, "foreign-key", () => true);
    expect(client.post).not.toHaveBeenCalled();
    await syncWarehouseEvents(exec, client, nextOwner, () => true);
    expect(
      await exec.all("SELECT DISTINCT owner,receive_status FROM warehouse_reprint_events"),
    ).toEqual([{ owner, receive_status: "accepted" }]);
    expect(print).not.toHaveBeenCalled();
    await work.start();
    await work.scan(`00${i.source.identity}`);
    expect(work.getSnapshot().error).toBe("WAREHOUSE_RECOVERY_REQUIRED");
    await work.close();
  } finally {
    db.close();
  }
});
