import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  palletDataFromLegacySource,
  makePalletData,
  palletCompositionDigest,
  UNIFIED_REPRINT_PROTOCOL,
} from "@markiro/domain";
import { thermalPalletSource } from "../../../packages/domain/test/support/pallet-reprint.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { createStationClient } from "../src/lib/api-client.js";
import * as dispatch from "../src/lib/warehouse-reprint/dispatch.js";
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const legacy = palletDataFromLegacySource(thermalPalletSource());
  const { revision: old, ...body } = legacy;
  void old;
  const box = legacy.boxSsccs[0];
  if (!box) throw new Error("Missing box");
  const codeHash = "a".repeat(64),
    acceptedAt = "2026-10-13T00:00:00.000Z";
  const data = makePalletData({
    ...body,
    compositionDigest: palletCompositionDigest([{ boxSscc: box, codeHash, acceptedAt }]),
    boxCount: 1,
    itemCount: 1,
    boxSsccs: [box],
    fields: { ...body.fields, qty: "1", "qty.boxes": "1" },
  });
  await exec.run(
    "INSERT INTO product_mirror(id,gtin14,name,status) VALUES('product','04600682000013','Saved','active')",
  );
  await exec.run(
    "INSERT INTO shift_mirror(id,status,mode,product_id) VALUES(?,'completed','aggregation','product')",
    [data.shiftId],
  );
  await exec.run(
    "INSERT INTO pallets_mirror(pallet_id,shift_id,sscc,opened_at,closed_at,print_state) VALUES('pallet',?,?,'2026-10-13T00:00:00Z',?,'printed')",
    [data.shiftId, data.sscc, data.closedAt],
  );
  await exec.run(
    "INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at,pallet_id) VALUES('box',?,?,'2026-10-13T00:00:00Z',?,'pallet')",
    [data.shiftId, box, data.closedAt],
  );
  await exec.run(
    "INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at,box_id) VALUES(?,?,'04600682000013','serial',?,'box')",
    [codeHash, data.shiftId, acceptedAt],
  );
  await exec.run(
    "INSERT INTO warehouse_pallet_sources(owner,sscc,revision,value_json) VALUES('owner',?,?,?)",
    [data.sscc, data.revision, JSON.stringify(data)],
  );
  const client = createStationClient({
    apiKey: "synthetic-test-device",
    serverUrl: "https://station.test",
  });
  return { db, exec, data, client };
}
it("uses canonical closed pallet data offline and never looks up a parent pallet for a unit scan", async () => {
  const h = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
  try {
    const result = await dispatch.resolveReprintTarget(
      h.client,
      h.exec,
      "owner",
      h.data.sscc,
      "00000000-0000-4000-8000-000000000004",
    );
    expect(result).toEqual({ kind: "pallet", data: h.data });
    expect(
      await dispatch.resolveReprintTarget(
        h.client,
        h.exec,
        "owner",
        "010460068200001321abcDEF1234567\u001d93crypto",
        "00000000-0000-4000-8000-000000000004",
      ),
    ).toEqual({ kind: "unit" });
  } finally {
    h.db.close();
  }
});
it("does not fall back after a server denial and does not hide genuine unknown delivery", async () => {
  const h = await fixture();
  try {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "unavailable", code: "composition_changed" }), {
            status: 200,
          }),
      ),
    );
    await expect(
      dispatch.resolveReprintTarget(
        h.client,
        h.exec,
        "owner",
        h.data.sscc,
        "00000000-0000-4000-8000-000000000004",
      ),
    ).rejects.toThrow("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "found", kind: "pallet", data: h.data }), {
            status: 200,
          }),
      ),
    );
    await h.exec.run("UPDATE warehouse_pallet_sources SET production_delivery_json=?", [
      JSON.stringify({
        sourceRevision: h.data.revision,
        sequence: 1,
        attemptId: crypto.randomUUID(),
        bytesDigest: "b".repeat(64),
        state: "delivery_unknown",
        occurredAt: "2026-10-13T00:00:00Z",
      }),
    ]);
    await expect(
      dispatch.resolveReprintTarget(
        h.client,
        h.exec,
        "owner",
        h.data.sscc,
        "00000000-0000-4000-8000-000000000004",
      ),
    ).rejects.toThrow("WAREHOUSE_PALLET_DELIVERY_UNRESOLVED");
    const { localPalletDiagnostic } =
      await import("../src/lib/warehouse-reprint/pallet-resolutions.js");
    expect(await localPalletDiagnostic(h.exec, "owner", h.data.sscc)).toMatchObject({
      sscc: h.data.sscc,
      kind: "delivery_unknown",
      sourceRevision: h.data.revision,
    });
    void UNIFIED_REPRINT_PROTOCOL;
  } finally {
    h.db.close();
  }
});

it("new production sources retain facts without the initial template", async () => {
  const h = await fixture();
  const { retainProductionPalletSource } =
    await import("../src/lib/warehouse-reprint/pallet-sources.js");
  try {
    await h.exec.run("DELETE FROM warehouse_pallet_sources");
    await h.exec.run(
      "INSERT INTO warehouse_pallet_closures(sscc,pallet_id,shift_id,closed_at,context_json) VALUES(?,'pallet',?,?,'{}') ON CONFLICT DO NOTHING",
      [h.data.sscc, h.data.shiftId, h.data.closedAt],
    );
    await retainProductionPalletSource(
      h.exec,
      "owner",
      h.data.sscc,
      thermalPalletSource().rendering,
      null,
      true,
    );
    const [saved] = await h.exec.all<{ value_json: string }>(
      "SELECT value_json FROM warehouse_pallet_sources",
    );
    expect(JSON.parse(saved?.value_json ?? "{}")).toMatchObject({ version: 3, sscc: h.data.sscc });
    expect(JSON.parse(saved?.value_json ?? "{}")).not.toHaveProperty("rendering");
  } finally {
    h.db.close();
  }
});

it("uploads data-only production sources through V3 and does not downgrade them for an old server", async () => {
  const h = await fixture();
  const { syncWarehousePallets } = await import("../src/lib/warehouse-reprint/pallet-sync.js");
  const { PALLET_REPRINT_PROTOCOL } = await import("@markiro/domain");
  try {
    await h.exec.run("UPDATE warehouse_pallet_sources SET receive_status='pending'");
    const requests: string[] = [];
    let supports = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (info: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(
          typeof info === "string" ? info : info instanceof URL ? info.href : info.url,
        ).pathname;
        let value: unknown;
        if (init?.method !== "POST")
          value = {
            protocols: [PALLET_REPRINT_PROTOCOL, ...(supports ? [UNIFIED_REPRINT_PROTOCOL] : [])],
          };
        else {
          requests.push(path);
          value = {
            protocol: UNIFIED_REPRINT_PROTOCOL,
            results: [{ revision: h.data.revision, status: "accepted" }],
          };
        }
        return new Response(JSON.stringify(value), { status: 200 });
      }),
    );
    expect(await syncWarehousePallets(h.exec, h.client, "owner", () => true)).toBe(0);
    expect(requests).toEqual([]);
    supports = true;
    expect(await syncWarehousePallets(h.exec, h.client, "owner", () => true)).toBe(1);
    expect(requests).toEqual(["/station/warehouse-reprint/pallet-data-v3"]);
  } finally {
    h.db.close();
  }
});
