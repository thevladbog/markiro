import { createStationClient } from "../src/lib/api-client.js";
import { finishWarehouseSession } from "../src/lib/warehouse-reprint/store.js";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { palletDataFromLegacySource, renderingFromPalletData } from "@markiro/domain";
import {
  a4PalletSource,
  thermalChoice,
} from "../../../packages/domain/test/support/pallet-reprint.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint.js";
import * as printing from "../src/lib/warehouse-reprint/pallet-printing.js";

vi.mock("../src/lib/rasterizer.js", () => ({
  rasterizeDriverText: async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  }),
}));

it("persists data and chosen thermal bytes for an A4 pallet, then sends exactly once", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const data = palletDataFromLegacySource(a4PalletSource()),
      rendering = renderingFromPalletData(data, thermalChoice());
    const input = warehousePreparedJobInput(),
      sessionId = crypto.randomUUID();
    await seedWarehouseOperator(exec, input.operatorId);
    await exec.run(
      "INSERT INTO warehouse_reprint_sessions(owner,session_id,operator_id,status,session_json) VALUES(?,?,?,'active',?)",
      [
        "owner",
        sessionId,
        input.operatorId,
        JSON.stringify({
          owner: "owner",
          sessionId,
          operatorId: input.operatorId,
          reason: "damaged",
          status: "active",
          unitTemplate: null,
          boxTemplate: null,
          palletTemplate: rendering.choice,
        }),
      ],
    );
    const job = await printing.prepareWarehousePalletDataJob({
      exec,
      owner: "owner",
      operatorId: input.operatorId,
      reason: "damaged",
      source: data,
      rendering,
      profile: input.printer,
      tenantId: "tenant-fixture",
      sessionId,
      render: async () => new TextEncoder().encode("chosen-thermal"),
    });
    const [row] = await exec.all<{ source_json: string; rendering_json: string }>(
      "SELECT source_json,rendering_json FROM warehouse_pallet_jobs",
    );
    expect(JSON.parse(row?.source_json ?? "{}")).toEqual(data);
    expect(JSON.parse(row?.source_json ?? "{}")).not.toHaveProperty("rendering");
    expect(JSON.parse(row?.rendering_json ?? "{}")).toEqual(rendering);
    await expect(
      finishWarehouseSession(exec, "owner", sessionId, input.operatorId),
    ).rejects.toThrow("WAREHOUSE_RECOVERY_REQUIRED");
    const delivered: string[] = [];
    const send = {
      exec,
      owner: "owner",
      operatorId: input.operatorId,
      jobId: job.jobId,
      profile: input.printer,
      isCurrent: () => true,
      print: vi.fn(async (_target, bytes: Uint8Array) => {
        delivered.push(new TextDecoder().decode(bytes));
      }),
    };
    await Promise.all([
      printing.sendWarehousePalletJob(send),
      printing.sendWarehousePalletJob(send),
    ]);
    expect(delivered).toEqual(["chosen-thermal"]);
    expect(
      (
        await exec.all<{ sent_count: number }>("SELECT sent_count FROM warehouse_pallet_settings")
      )[0]?.sent_count,
    ).toBe(1);
    expect((await printing.warehousePalletDataJobView(exec, "owner", job.jobId)).state).toBe(
      "sent",
    );
    expect(await finishWarehouseSession(exec, "owner", sessionId, input.operatorId)).toBe(true);
    expect(
      (
        await exec.all<{ session_status: string }>(
          "SELECT session_status FROM warehouse_pallet_settings",
        )
      )[0]?.session_status,
    ).toBe("finished");
  } finally {
    db.close();
  }
});

it("syncs V3 chosen renderings before their events and keeps them out of V2 requests", async () => {
  const sync = await import("../src/lib/warehouse-reprint/pallet-v2-sync.js");
  const { UNIFIED_REPRINT_PROTOCOL, PALLET_REPRINT_V2_PROTOCOL } = await import("@markiro/domain");
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const input = warehousePreparedJobInput(),
      data = palletDataFromLegacySource(a4PalletSource());
    const rendering = renderingFromPalletData(data, thermalChoice()),
      sessionId = crypto.randomUUID();
    await seedWarehouseOperator(exec, input.operatorId);
    await exec.run(
      "INSERT INTO warehouse_reprint_sessions(owner,session_id,operator_id,status,session_json) VALUES(?,?,?,'active',?)",
      [
        "owner",
        sessionId,
        input.operatorId,
        JSON.stringify({
          owner: "owner",
          sessionId,
          operatorId: input.operatorId,
          reason: "damaged",
          status: "active",
          unitTemplate: null,
          boxTemplate: null,
          palletTemplate: rendering.choice,
        }),
      ],
    );
    await printing.prepareWarehousePalletDataJob({
      exec,
      owner: "owner",
      operatorId: input.operatorId,
      sessionId,
      reason: "damaged",
      source: data,
      rendering,
      profile: input.printer,
      tenantId: "tenant-fixture",
      render: async () => new TextEncoder().encode("thermal"),
    });
    const requests: string[] = [];
    const post = async (path: string) => {
      requests.push(path);
      if (path.endsWith("renderings-v3")) {
        const [row] = await exec.all<{ job_id: string }>(
          "SELECT job_id FROM warehouse_pallet_jobs",
        );
        return {
          protocol: UNIFIED_REPRINT_PROTOCOL,
          results: [
            {
              jobId: row?.job_id,
              renderingRevision: rendering.renderingRevision,
              status: "accepted",
            },
          ],
        };
      }
      const rows = await exec.all<{ event_id: string }>(
        "SELECT event_id FROM warehouse_pallet_events",
      );
      return {
        protocol: UNIFIED_REPRINT_PROTOCOL,
        results: rows.map((r) => ({ eventId: r.event_id, status: "accepted" })),
      };
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (info: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(
          typeof info === "string" ? info : info instanceof URL ? info.href : info.url,
        ).pathname;
        const value =
          init?.method === "POST"
            ? await post(path)
            : { protocols: [UNIFIED_REPRINT_PROTOCOL, PALLET_REPRINT_V2_PROTOCOL] };
        return new Response(JSON.stringify(value), { status: 200 });
      }),
    );
    const client = createStationClient({
      apiKey: "synthetic-test-device",
      serverUrl: "https://station.test",
    });
    expect(await sync.syncWarehousePalletV2(exec, client, "owner", () => true)).toBe(0);
    expect(requests).toEqual([]);
    expect(await sync.syncWarehousePalletV3(exec, client, "owner", () => true)).toBe(2);
    expect(requests).toEqual([
      "/station/warehouse-reprint/pallet-renderings-v3",
      "/station/warehouse-reprint/pallet-events-v3",
    ]);
  } finally {
    vi.unstubAllGlobals();
    db.close();
  }
});

it("renders historical thermal facts on A4 using branding retained across credential rotation", async () => {
  const { thermalPalletSource, sheetChoice } =
    await import("../../../packages/domain/test/support/pallet-reprint.js");
  const { productLabelValueDigest, validatePalletBranding } = await import("@markiro/domain");
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const input = warehousePreparedJobInput(),
      data = palletDataFromLegacySource(thermalPalletSource()),
      choice = sheetChoice(),
      rendering = renderingFromPalletData(data, choice),
      sessionId = crypto.randomUUID(),
      owner = "a".repeat(64),
      renewed = "b".repeat(64);
    await seedWarehouseOperator(exec, input.operatorId);
    const source = a4PalletSource();
    if (source.rendering.kind !== "a4") throw new Error("Expected sheet");
    const { digest: ignored, ...branding } = validatePalletBranding(source.rendering.brandingJson);
    void ignored;
    const content = { ...branding, ownerDigest: renewed };
    const identity = JSON.stringify({
      serverOrigin: "https://station.test",
      tenantId: "tenant-fixture",
      deviceId: input.deviceId,
      kind: "station",
    });
    await exec.run(
      "INSERT INTO station_device_owners(credential_hash,owner_json) VALUES(?,?),(?,?)",
      [owner, identity, renewed, identity],
    );
    await exec.run(
      "INSERT INTO station_device_recovery(machine_id,owner_json,phase,active_hash) VALUES('machine',?,'active',?)",
      [identity, renewed],
    );
    await exec.run(
      "INSERT INTO station_organization_branding(tenant_id,owner_digest,snapshot_json) VALUES('tenant-fixture',?,?)",
      [renewed, JSON.stringify({ ...content, digest: productLabelValueDigest(content) })],
    );
    await exec.run(
      "INSERT INTO warehouse_reprint_sessions(owner,session_id,operator_id,status,session_json) VALUES(?,?,?,'active',?)",
      [
        owner,
        sessionId,
        input.operatorId,
        JSON.stringify({
          owner,
          sessionId,
          operatorId: input.operatorId,
          reason: "damaged",
          status: "active",
          unitTemplate: null,
          boxTemplate: null,
          palletTemplate: choice,
        }),
      ],
    );
    const job = await printing.prepareWarehousePalletDataJob({
      exec,
      owner,
      accessOwner: renewed,
      operatorId: input.operatorId,
      reason: "damaged",
      sessionId,
      source: data,
      rendering,
      tenantId: "tenant-fixture",
      profile: {
        ...input.printer,
        mode: "windows_driver",
        paper: "a4",
        dpi: 300,
        target: { kind: "usb", printer: "Office" },
      },
      hardware: {
        supportsWindowsPrinting: async () => true,
        getWindowsPageGeometry: async () => ({
          widthMm: 210,
          heightMm: 297,
          printableBoundsMm: { left: 3, top: 3, right: 207, bottom: 294 },
          guardMm: 0.5,
          deviceDpiX: 600,
          deviceDpiY: 600,
          fingerprint: "fixture",
        }),
        preflightWindowsRaster: async () => ({ ok: true }),
        printWindowsRaster: async () => ({
          ok: true,
          receipt: { queue: "Office", jobId: 1, documentName: "fixture" },
        }),
        getWindowsPrintJob: async () => ({ state: "absent" }),
      },
    });
    expect(job.rendering.choice.kind).toBe("a4");
    const [saved] = await exec.all<{ render_snapshot_json: string }>(
      "SELECT render_snapshot_json FROM warehouse_pallet_jobs",
    );
    const { parsePalletSheetPrintSnapshot } =
      await import("../src/lib/pallet-sheet-print-snapshot.js");
    expect(parsePalletSheetPrintSnapshot(saved?.render_snapshot_json ?? "{}").facts).toMatchObject({
      expiryDate: data.expiryDate,
      productionDate: data.productionDate,
    });
  } finally {
    db.close();
  }
});
