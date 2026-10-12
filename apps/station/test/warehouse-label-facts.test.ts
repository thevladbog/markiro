import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { kmHash, parseDuplicateKm, resolveWarehouseReprintScan } from "@markiro/domain";
import { applyMigrations } from "../src/lib/mirror.js";
import { recordScan } from "../src/lib/journal.js";
import { findWarehouseSource } from "../src/lib/warehouse-reprint/sources.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";

it("keeps acceptance-time dates and name for an aggregation unit after the catalog changes", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const shiftId = "00000000-0000-4000-8000-000000000010";
  const raw = "010460000000001521UNIT-FROZEN\u001d91Key1\u001d92Crypto";
  const km = parseDuplicateKm(raw);
  try {
    await exec.run(
      "INSERT INTO product_mirror(id,gtin14,name,print_name,status,shelf_life_days) VALUES('p',?,'Old name','Old print','active',1)",
      [km.gtin14],
    );
    await exec.run(
      "INSERT INTO shift_mirror(id,status,mode,product_id,production_date,number) VALUES(?,'active','aggregation','p','2026-02-28','FEB26-001')",
      [shiftId],
    );
    await recordScan(
      exec,
      {
        shiftId,
        terminalId: null,
        raw,
        verdict: "ok",
        scannedAt: "2026-03-01T00:30:00.000Z",
        operatorId: null,
      },
      {
        codeHash: kmHash(km),
        shiftId,
        gtin14: km.gtin14,
        serial: km.serial,
        scannedAt: "2026-03-01T00:30:00.000Z",
        boxId: null,
      },
    );
    await exec.run("UPDATE product_mirror SET name='New name',shelf_life_days=365");
    await exec.run("UPDATE shift_mirror SET status='closed'");
    expect(
      await findWarehouseSource(exec, "owner", resolveWarehouseReprintScan(raw)),
    ).toMatchObject({
      kind: "unit",
      fields: {
        "product.name": "Old name",
        "product.printName": "Old print",
        date: "28.02.2026",
        expiry: "28.02.2026",
        "km.code": raw,
      },
      unavailableFields: ["operator"],
    });
    await exec.run(
      "INSERT INTO conflicts_mirror(code_hash,winning_scanned_at,detected_at) VALUES(?,?,?)",
      [kmHash(km), "2026-02-28T00:00:00Z", "2026-03-02T00:00:00Z"],
    );
    await expect(
      findWarehouseSource(exec, "owner", resolveWarehouseReprintScan(raw)),
    ).rejects.toThrow("WAREHOUSE_SOURCE_NOT_PRINTABLE");
  } finally {
    db.close();
  }
});

it("does not upload facts when ownership changes while discovering server support", async () => {
  const { syncUnitLabelFacts } = await import("../src/lib/warehouse-reprint/label-facts.js");
  const { productLabelAcceptanceFixture, seedProductLabelShift } =
    await import("./support/product-labels.js");
  const { recordProductLabelAcceptance } = await import("../src/lib/product-labels/acceptance.js");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const input = productLabelAcceptanceFixture({ ownership: "owner" });
    await seedProductLabelShift(exec, input);
    await recordProductLabelAcceptance(exec, input);
    await exec.run("DELETE FROM outbox");
    let current = true;
    const post = vi.fn().mockRejectedValue(new Error("must not send under changed owner"));
    const client = {
      get: vi.fn().mockImplementation(async () => {
        current = false;
        return { protocols: ["warehouse-label-facts-v1"] };
      }),
      post,
      download: vi.fn(),
      whoami: vi.fn(),
    };
    expect(await syncUnitLabelFacts(exec, client, "owner", () => current)).toBe(0);
    expect(post).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it("recovers a legacy aggregation unit from its immutable closed-box label with the declared production date", async () => {
  const { warehouseBoxSource } = await import("@markiro/domain");
  const { cacheWarehouseClosedBox } = await import("../src/lib/warehouse-reprint/sources.js");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const box = warehouseBoxSource();
    const shiftId = box.sourceShiftId;
    if (!shiftId) throw new Error("fixture needs shift");
    const raw = "010460000000001521LEGACY-UNIT\u001d91Key1\u001d92Crypto";
    const km = parseDuplicateKm(raw);
    await exec.run(
      "INSERT INTO shift_mirror(id,status,mode,product_id,production_date) VALUES(?,'closed','aggregation','p','2026-02-28')",
      [shiftId],
    );
    await exec.run(
      "INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at) VALUES(?,?,?,'2026-02-28T12:00:00Z','2026-02-28T12:30:00Z')",
      [box.sourceId, shiftId, box.identity],
    );
    await exec.run(
      "INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at,box_id) VALUES(?,?,?,?,?,?)",
      [kmHash(km), shiftId, km.gtin14, km.serial, "2026-02-28T12:10:00.000Z", box.sourceId],
    );
    await exec.run(
      "INSERT INTO scan_events_mirror(shift_id,raw,verdict,scanned_at) VALUES(?,?,'ok',?)",
      [shiftId, raw, "2026-02-28T12:10:00.000Z"],
    );
    await cacheWarehouseClosedBox(exec, "owner", {
      sourceId: box.sourceId,
      sourceShiftId: shiftId,
      fields: {
        ...box.fields,
        "product.gtin": km.gtin14,
        date: "28.02.2026",
        expiry: "28.02.2026",
      },
    });
    expect(
      await findWarehouseSource(exec, "owner", resolveWarehouseReprintScan(raw)),
    ).toMatchObject({
      kind: "unit",
      fields: { date: "28.02.2026", expiry: "28.02.2026", "km.code": raw, qty: "1", sscc: "" },
      unavailableFields: ["operator"],
    });
    await exec.run("UPDATE boxes_mirror SET disassembled_at='2026-03-01T12:00:00Z'");
    expect(await findWarehouseSource(exec, "owner", resolveWarehouseReprintScan(raw))).toBeNull();
  } finally {
    db.close();
  }
});

it("keeps unsent label facts in sealed recovery after the original scan channel is acknowledged", async () => {
  const { readSealedWorkSummary } = await import("../src/lib/credential-recovery.js");
  const { productLabelAcceptanceFixture, seedProductLabelShift } =
    await import("./support/product-labels.js");
  const { recordProductLabelAcceptance } = await import("../src/lib/product-labels/acceptance.js");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const input = productLabelAcceptanceFixture({ ownership: "owner" });
    await seedProductLabelShift(exec, input);
    await recordProductLabelAcceptance(exec, input);
    await exec.run("DELETE FROM outbox");
    await exec.run("DELETE FROM product_label_outbox");
    expect(await readSealedWorkSummary(exec)).toMatchObject({ scans: 0, productLabels: 1 });
  } finally {
    db.close();
  }
});

it("refuses rewriting captured fields while allowing a receipt status update", async () => {
  const { productLabelAcceptanceFixture, seedProductLabelShift } =
    await import("./support/product-labels.js");
  const { recordProductLabelAcceptance } = await import("../src/lib/product-labels/acceptance.js");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const input = productLabelAcceptanceFixture({ ownership: "owner" });
    await seedProductLabelShift(exec, input);
    await recordProductLabelAcceptance(exec, input);
    await expect(exec.run("UPDATE unit_label_facts SET fields_json='{}'")).rejects.toThrow(
      "UNIT_LABEL_FACTS_IMMUTABLE",
    );
    await exec.run("UPDATE unit_label_facts SET receive_status='accepted'");
    expect(await exec.all("SELECT receive_status FROM unit_label_facts")).toEqual([
      { receive_status: "accepted" },
    ]);
  } finally {
    db.close();
  }
});

it("freezes the actual accepting operator name from the published roster", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const shiftId = "00000000-0000-4000-8000-000000000011",
    operatorId = "00000000-0000-4000-8000-000000000012";
  const raw = "010460000000001521OPERATOR-UNIT\u001d91Key1\u001d92Crypto";
  const km = parseDuplicateKm(raw);
  try {
    await exec.run(
      "INSERT INTO product_mirror(id,gtin14,name,status,shelf_life_days) VALUES('p',?,'Product','active',1)",
      [km.gtin14],
    );
    await exec.run(
      "INSERT INTO shift_mirror(id,status,mode,product_id,production_date) VALUES(?,'active','aggregation','p','2026-02-28')",
      [shiftId],
    );
    await exec.run(
      "INSERT INTO operators_mirror(operator_id,name,role,pin_hash) VALUES(?,'Accepting operator','operator','fixture')",
      [operatorId],
    );
    await recordScan(
      exec,
      {
        shiftId,
        terminalId: null,
        raw,
        verdict: "ok",
        scannedAt: "2026-03-01T12:00:00.000Z",
        operatorId,
      },
      {
        codeHash: kmHash(km),
        shiftId,
        gtin14: km.gtin14,
        serial: km.serial,
        scannedAt: "2026-03-01T12:00:00.000Z",
        boxId: null,
      },
    );
    await exec.run("UPDATE operators_mirror SET name='New name'");
    expect(
      await findWarehouseSource(exec, "owner", resolveWarehouseReprintScan(raw)),
    ).toMatchObject({ fields: { operator: "Accepting operator" }, unavailableFields: [] });
  } finally {
    db.close();
  }
});
