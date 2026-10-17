// Invoked by the ignored Rust PostgreSQL seam test, against its dedicated migrated DB only.
// Mutations match cloud ingest/disaggregation: server-default opens, device closes,
// removed box items/released registry owners, and retained boxes.pallet_id provenance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { runHistoryPsql, writeHistory } from "../../history.mjs";

const url = new URL(process.env.STANDALONE_EXPORT_TEST_DATABASE_URL);
const psql = process.env.PSQL ?? "psql";
const env = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || "5432",
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: url.pathname.slice(1),
};
const tenant = "imp-test-atoll";
const id = (n) => `a1720000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const product = "0e0e0000-0000-4000-8000-000000000001";
const gtin = "04600682000013";
const hash = (serial) => createHash("sha256").update(`01${gtin}21${serial}`).digest("hex");
const sscc = (prefix, n) => {
  const body = `${prefix}4600682${String(n).padStart(9, "0")}`;
  const sum = [...body]
    .reverse()
    .reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 1 : 3), 0);
  return body + ((10 - (sum % 10)) % 10);
};
function execute(sql) {
  const result = spawnSync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr);
}
const cleanup =
  ["code_registry", "box_items", "codes", "boxes", "pallets", "shifts", "products", "org_profiles"]
    .map((table) => `DELETE FROM ${table} WHERE tenant_id='${tenant}';`)
    .join("\n") + `DELETE FROM organization WHERE id='${tenant}';`;
execute(
  "CREATE TABLE IF NOT EXISTS codes_2026_10 PARTITION OF codes FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');",
);
execute(cleanup);
try {
  execute(`
    INSERT INTO organization(id,name,slug,created_at) VALUES ('${tenant}','ООО «Атолл»','history-host-seam',now());
    INSERT INTO org_profiles(tenant_id,inn,gln,time_zone) VALUES ('${tenant}','7701234567','4600682000010','Europe/Moscow');
    INSERT INTO products(id,tenant_id,gtin14,name,shelf_life_days) VALUES ('${product}','${tenant}','${gtin}','Frozen milk',30);
    INSERT INTO shifts(id,tenant_id,product_id,mode,status,number_month_key,number_seq,production_date,pallets_enabled,opened_at) VALUES
      ('${id(10)}','${tenant}','${product}','aggregation','active','OCT26',10,'2026-10-16',true,now()),
      ('${id(11)}','${tenant}','${product}','aggregation','active','OCT26',11,'2026-10-16',false,NULL),
      ('${id(12)}','${tenant}','${product}','aggregation','active','OCT26',12,'2026-10-16',false,'2026-10-16T08:00:00Z');
    INSERT INTO pallets(id,tenant_id,shift_id,device_pallet_id) VALUES
      ('${id(20)}','${tenant}','${id(10)}','p-live'),('${id(21)}','${tenant}','${id(10)}','p-retired');
    INSERT INTO boxes(id,tenant_id,shift_id,device_box_id) VALUES
      ('${id(40)}','${tenant}','${id(10)}','box-retired'),('${id(41)}','${tenant}','${id(10)}','pallet-retired'),
      ('${id(42)}','${tenant}','${id(10)}','live'),('${id(43)}','${tenant}','${id(10)}','both-retired');
    UPDATE pallets SET sscc=CASE id WHEN '${id(20)}' THEN '${sscc(1, 20)}' ELSE '${sscc(1, 21)}' END,
      closed_at='2026-10-16T11:30:00Z',closure_received_at=now() WHERE tenant_id='${tenant}';
    UPDATE boxes SET sscc=CASE id WHEN '${id(40)}' THEN '${sscc(0, 40)}' WHEN '${id(41)}' THEN '${sscc(0, 41)}' WHEN '${id(42)}' THEN '${sscc(0, 42)}' ELSE '${sscc(0, 43)}' END,
      closed_at='2026-10-16T11:00:00Z',closure_received_at=now(),
      pallet_id=CASE WHEN id IN ('${id(40)}','${id(42)}') THEN '${id(20)}'::uuid ELSE '${id(21)}'::uuid END WHERE tenant_id='${tenant}';
    ${["A", "B", "C", "D"]
      .map(
        (serial, i) => `
      INSERT INTO codes(tenant_id,code_hash,shift_id,gtin14,serial,canonical_raw,scanned_at) VALUES
      ('${tenant}','${hash(serial)}','${id(10)}','${gtin}','${serial}',E'01${gtin}21${serial}\\x1d91TEST','2026-10-16T10:00:00Z');
      INSERT INTO box_items(tenant_id,box_id,code_hash,added_at) VALUES ('${tenant}','${id(40 + i)}','${hash(serial)}','2026-10-16T10:00:00Z');`,
      )
      .join("\n")}
    INSERT INTO code_registry(tenant_id,code_hash,shift_id,scanned_at) SELECT tenant_id,code_hash,shift_id,scanned_at FROM codes WHERE tenant_id='${tenant}';
    UPDATE shifts SET status='closed',closed_at='2026-10-16T09:00:00Z' WHERE tenant_id='${tenant}';
    -- A device's disassembly clock can precede its earlier closure. No chronology promise.
    UPDATE boxes SET disassembled_at='2026-10-16T07:00:00Z',disassembly_received_at=now() WHERE id IN ('${id(40)}','${id(43)}');
    UPDATE box_items SET removed_at=now() WHERE box_id IN ('${id(40)}','${id(43)}');
    DELETE FROM code_registry WHERE tenant_id='${tenant}' AND code_hash IN ('${hash("A")}','${hash("D")}');
    -- Pallet disassembly keeps its boxes closed and their current code ownership.
    UPDATE pallets SET disassembled_at=now(),updated_at=now() WHERE id='${id(21)}';
  `);
  await writeHistory(
    process.argv[2],
    runHistoryPsql({ psql, tenantId: tenant, since: "2025-10-17", env }),
    { exportedAt: new Date().toISOString(), since: "2025-10-17" },
  );
  const [manifest, ...parts] = (await readFile(process.argv[2], "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(manifest.counts.boxes, 4);
  assert.equal(manifest.counts.owners, 2);
  const boxes = parts.flatMap((part) => part.payload.boxes);
  assert.ok(boxes.every((box) => box.palletId !== null));
  assert.ok(boxes.every((box) => Date.parse(box.closedAt) < Date.parse(box.openedAt)));
  assert.ok(
    boxes
      .filter((box) => box.disassembledAt !== null)
      .every((box) => Date.parse(box.disassembledAt) < Date.parse(box.closedAt)),
  );
} finally {
  execute(cleanup);
}
