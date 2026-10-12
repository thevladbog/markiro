import { PALLET_REPRINT_V2_PROTOCOL, productLabelValueDigest } from "@markiro/domain";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  makePalletLabelSource,
  buildPalletLabelTemplates,
  warehouseBoxSource,
  PALLET_REPRINT_PROTOCOL,
} from "@markiro/domain";
import { createWarehousePalletWork } from "../src/lib/warehouse-reprint/pallet-work.js";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { DEFAULT_HARDWARE_CONFIG } from "../src/lib/hardware-config.js";
import type { StationClient } from "../src/lib/api-client.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint.js";
vi.mock("../src/lib/rasterizer.js", () => ({
  rasterizeText: async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  }),
}));
async function fixture() {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const input = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, input.operatorId);
  const template = buildPalletLabelTemplates()[0];
  if (!template) throw new Error("Missing template");
  const source = makePalletLabelSource({
    version: 1,
    sscc: "146000000000001231",
    shiftId: "00000000-0000-4000-8000-000000000001",
    closedAt: "2026-10-11T00:00:00.000Z",
    boxCount: 1,
    itemCount: 1,
    compositionDigest: "a".repeat(64),
    boxSsccs: [input.source.identity],
    rendering: {
      kind: "thermal",
      rendererVersion: "thermal-v1",
      template: template.spec,
      fields: {
        ...warehouseBoxSource().fields,
        sscc: "146000000000001231",
        qty: "1",
        "qty.boxes": "1",
      },
      brandingJson: null,
    },
  });
  const get = vi
    .fn<StationClient["get"]>()
    .mockResolvedValue({ protocols: [PALLET_REPRINT_PROTOCOL] });
  const post = vi.fn<StationClient["post"]>().mockResolvedValue({ status: "found", source });
  const client: StationClient = {
    get: async <T>(path: string) => (await get(path)) as T,
    post: async <T>(path: string, body?: unknown) => (await post(path, body)) as T,
    download: vi.fn().mockResolvedValue(new Blob()),
    whoami: vi.fn().mockResolvedValue({ ok: true }),
  };
  const print = vi.fn(async () => {}),
    generation = createCredentialGeneration("pallet-work-key");
  const work = createWarehousePalletWork({
    exec,
    client,
    generation,
    deviceId: input.deviceId,
    operatorId: input.operatorId,
    print,
    hardware: () => ({
      ...DEFAULT_HARDWARE_CONFIG,
      printer: input.printer.target,
      printerLanguage: "tspl",
      printerDpi: 203,
    }),
  });
  return { db, exec, work, source, print, post, get };
}
it("looks up without printing, cancels without a job, and confirms only once", async () => {
  const h = await fixture();
  try {
    await h.work.initialize();
    await h.work.scan(h.source.sscc);
    expect(h.work.getSnapshot().selection?.source.revision).toBe(h.source.revision);
    expect(h.print).not.toHaveBeenCalled();
    h.work.cancel();
    expect(await h.exec.all("SELECT * FROM warehouse_pallet_jobs")).toHaveLength(0);
    await h.work.scan(h.source.sscc);
    await Promise.all([h.work.confirm(h.source.revision), h.work.confirm(h.source.revision)]);
    expect(h.work.getSnapshot().error).toBeNull();
    expect(h.print).toHaveBeenCalledTimes(1);
    expect(h.work.getSnapshot().job?.state).toBe("sent");
    expect(await h.exec.all("SELECT * FROM warehouse_reprint_jobs")).toHaveLength(0);
  } finally {
    await h.work.close();
    h.db.close();
  }
});
it("retires a delayed lookup on close and never creates a printable job", async () => {
  const h = await fixture();
  try {
    await h.work.initialize();
    let resolve: (value: unknown) => void = () => {};
    h.post.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const scanning = h.work.scan(h.source.sscc);
    await vi.waitFor(() => expect(h.post).toHaveBeenCalled());
    const closing = h.work.close();
    resolve({ status: "found", source: h.source });
    await scanning;
    await closing;
    expect(h.print).not.toHaveBeenCalled();
    expect(await h.exec.all("SELECT * FROM warehouse_pallet_jobs")).toHaveLength(0);
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it("selects a frozen alternate thermal snapshot and persists session sends across restart", async () => {
  const h = await fixture();
  try {
    if (h.source.rendering.kind !== "thermal") throw new Error("Expected thermal source");
    const snapshot = {
      ...h.source.rendering.template,
      widthMm: h.source.rendering.template.widthMm + 1,
    };
    const choice = {
      kind: "thermal" as const,
      id: "00000000-0000-4000-8000-000000000061",
      name: "Chosen",
      snapshot,
      snapshotDigest: productLabelValueDigest(snapshot),
    };
    h.get.mockImplementation(async (path) =>
      path.endsWith("pallet-templates-v2")
        ? { protocol: PALLET_REPRINT_V2_PROTOCOL, templates: [choice] }
        : { protocols: [PALLET_REPRINT_PROTOCOL, PALLET_REPRINT_V2_PROTOCOL] },
    );
    await h.work.initialize();
    await h.work.scan(h.source.sscc);
    await h.work.selectTemplate(choice);
    await h.work.confirm(h.source.revision);
    expect(h.work.getSnapshot().error).toBeNull();
    expect(h.work.getSnapshot().job?.rendering?.rendering.template).toEqual(snapshot);
    expect(h.work.getSnapshot().job?.source).toEqual(h.source);
    expect(h.work.getSnapshot().session?.sentCount).toBe(1);
    await h.work.initialize();
    expect(h.work.getSnapshot().session?.sentCount).toBe(1);
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it("refuses an alternate snapshot when V2 capability disappears after catalog refresh", async () => {
  const h = await fixture();
  try {
    if (h.source.rendering.kind !== "thermal") throw new Error("Expected thermal source");
    const snapshot = {
      ...h.source.rendering.template,
      widthMm: h.source.rendering.template.widthMm + 1,
    };
    const choice = {
      kind: "thermal" as const,
      id: "00000000-0000-4000-8000-000000000061",
      name: "Chosen",
      snapshot,
      snapshotDigest: productLabelValueDigest(snapshot),
    };
    h.get.mockImplementation(async (path) =>
      path.endsWith("pallet-templates-v2")
        ? { protocol: PALLET_REPRINT_V2_PROTOCOL, templates: [choice] }
        : { protocols: [PALLET_REPRINT_PROTOCOL, PALLET_REPRINT_V2_PROTOCOL] },
    );
    await h.work.initialize();
    await h.work.scan(h.source.sscc);
    await h.work.selectTemplate(choice);
    h.get.mockResolvedValue({ protocols: [PALLET_REPRINT_PROTOCOL] });
    await h.work.refreshTemplates();
    expect(h.work.getSnapshot().catalog).toBeNull();
    await h.work.confirm(h.source.revision);
    expect(h.work.getSnapshot().error).toBe("WAREHOUSE_CATALOG_NETWORK");
    expect(h.print).not.toHaveBeenCalled();
    expect(await h.exec.all("SELECT * FROM warehouse_pallet_jobs")).toHaveLength(0);
  } finally {
    await h.work.close();
    h.db.close();
  }
});
