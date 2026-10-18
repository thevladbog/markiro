import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
it("captures pallet closure facts in the same update and cannot overwrite them", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  try {
    await applyMigrations(exec);
    await exec.run(
      "INSERT INTO product_mirror(id,gtin14,name,status,shelf_life_days) VALUES('p','04600000000015','Original','active',1)",
    );
    await exec.run(
      "INSERT INTO shift_mirror(id,status,mode,product_id,production_date) VALUES('s','active','aggregation','p','2026-10-11')",
    );
    await exec.run("UPDATE shift_mirror SET execution_scope_json=? WHERE id='s'", [
      '{"product":{"name":"Frozen","printName":null,"gtin14":"04600000000015","egaisCode":null,"shelfLifeDays":1},"shift":{"productionDate":"2026-10-11","number":null,"counterpartyName":null}}',
    ]);
    await exec.run("UPDATE product_mirror SET name='Mutable',shelf_life_days=365;");
    await exec.run(
      "INSERT INTO pallets_mirror(pallet_id,shift_id,opened_at) VALUES('pallet','s','2026-10-11T00:00:00Z')",
    );
    await exec.run(
      "UPDATE pallets_mirror SET sscc='146000000000001231',closed_at='2026-10-11T00:00:01Z' WHERE pallet_id='pallet'",
    );
    const rows = await exec.all<{ context_json: string }>(
      "SELECT context_json FROM warehouse_pallet_closures WHERE sscc='146000000000001231'",
    );
    expect(JSON.parse(rows[0]?.context_json ?? "null")).toMatchObject({
      productName: "Frozen",
      productionDate: "2026-10-11",
      shelfLifeDays: 1,
    });
    await exec.run("UPDATE product_mirror SET name='New',shelf_life_days=365");
    await expect(
      exec.run("UPDATE warehouse_pallet_closures SET context_json='{}'"),
    ).rejects.toThrow("PALLET_CLOSURE_IMMUTABLE");
  } finally {
    db.close();
  }
});

import {
  buildPalletLabelTemplates,
  warehouseBoxSource,
  palletCompositionDigest,
  parseDuplicateKm,
  kmHash,
  PALLET_REPRINT_PROTOCOL,
} from "@markiro/domain";
import {
  retainProductionPalletSource,
  resolveWarehousePalletSource,
} from "../src/lib/warehouse-reprint/pallet-sources.js";
import { syncWarehousePallets } from "../src/lib/warehouse-reprint/pallet-sync.js";
import type { StationClient } from "../src/lib/api-client.js";
import { vi } from "vitest";
it("retains local eligibility while a source awaits upload, denies same-count replacement and keeps pending data on retired sync", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const raw = "010460068200001321abcDEF1234567\u001d93crypto",
      codeHash = kmHash(parseDuplicateKm(raw)),
      sscc = "146000000000001231",
      boxSscc = "046000000000001234",
      owner = "owner",
      operatorId = "00000000-0000-4000-8000-000000000004";
    await exec.run(
      "INSERT INTO product_mirror(id,gtin14,name,status) VALUES('product','04600682000013','Saved','active')",
    );
    await exec.run(
      "INSERT INTO shift_mirror(id,status,mode,product_id) VALUES('00000000-0000-4000-8000-000000000001','active','aggregation','product')",
    );
    await exec.run(
      "INSERT INTO pallets_mirror(pallet_id,shift_id,sscc,opened_at) VALUES('pallet','00000000-0000-4000-8000-000000000001',?,'2026-10-11T00:00:00Z')",
      [sscc],
    );
    await exec.run(
      "UPDATE pallets_mirror SET closed_at='2026-10-11T00:00:01Z',print_state='printed' WHERE pallet_id='pallet'",
    );
    await exec.run(
      "INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at,pallet_id) VALUES('box','00000000-0000-4000-8000-000000000001',?,'2026-10-11T00:00:00Z','2026-10-11T00:00:01Z','pallet')",
      [boxSscc],
    );
    await exec.run(
      "INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at,box_id) VALUES(?,'00000000-0000-4000-8000-000000000001','04600682000013','serial','2026-10-11T00:00:00Z','box')",
      [codeHash],
    );
    const template = buildPalletLabelTemplates()[0];
    if (!template) throw new Error("Missing template");
    await retainProductionPalletSource(
      exec,
      owner,
      sscc,
      {
        kind: "thermal",
        rendererVersion: "thermal-v1",
        template: template.spec,
        brandingJson: null,
        fields: { ...warehouseBoxSource().fields, sscc, qty: "1", "qty.boxes": "1" },
      },
      null,
    );
    const post = vi.fn(async () => ({ status: "unavailable", code: "snapshot_missing" }));
    const client: StationClient = {
      get: async <T>() => ({ protocols: [PALLET_REPRINT_PROTOCOL] }) as T,
      post: async <T>() => (await post()) as T,
      download: async () => new Blob(),
      whoami: async () => ({ ok: true }),
    };
    for (const value of [sscc, `]C100${boxSscc}`, raw])
      expect(
        (await resolveWarehousePalletSource(client, exec, owner, value, operatorId)).source.sscc,
      ).toBe(sscc);
    expect(
      (
        await exec.all<{ eligibility_denied: number }>(
          "SELECT eligibility_denied FROM warehouse_pallet_sources",
        )
      )[0]?.eligibility_denied,
    ).toBe(0);
    let active = true;
    const syncClient: Pick<StationClient, "get" | "post"> = {
      get: client.get,
      post: async <T>() => {
        active = false;
        const [source] = await exec.all<{ revision: string }>(
          "SELECT revision FROM warehouse_pallet_sources",
        );
        return {
          protocol: PALLET_REPRINT_PROTOCOL,
          results: [{ revision: source?.revision, status: "accepted" }],
        } as T;
      },
    };
    await syncWarehousePallets(exec, syncClient, owner, () => active);
    expect(
      (
        await exec.all<{ receive_status: string }>(
          "SELECT receive_status FROM warehouse_pallet_sources",
        )
      )[0]?.receive_status,
    ).toBe("pending");
    await exec.run("UPDATE codes_mirror SET code_hash=?", ["b".repeat(64)]);
    await expect(
      resolveWarehousePalletSource(client, exec, owner, sscc, operatorId),
    ).rejects.toThrow("WAREHOUSE_PALLET_SNAPSHOT_MISSING");
    const offline: StationClient = {
      ...client,
      get: async () => {
        throw new TypeError("Failed to fetch");
      },
    };
    await expect(
      resolveWarehousePalletSource(offline, exec, owner, sscc, operatorId),
    ).rejects.toThrow("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
    expect(
      palletCompositionDigest([{ boxSscc, codeHash, acceptedAt: "2026-10-11T00:00:00Z" }]),
    ).not.toBe(
      palletCompositionDigest([
        { boxSscc, codeHash: "b".repeat(64), acceptedAt: "2026-10-11T00:00:00Z" },
      ]),
    );
  } finally {
    db.close();
  }
});
