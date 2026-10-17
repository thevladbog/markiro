import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runHistoryPsql, writeHistory } from "../history.mjs";

const sqlPath = fileURLToPath(new URL("../history.sql", import.meta.url));
const externalOwner = JSON.parse(
  readFileSync(
    new URL(
      "../../../apps/standalone/proto/fixtures/cloud-history-external-owner.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
test("history SQL is a read-only snapshot and keeps exact owner canonical identity and flat-only repeats", () => {
  const sql = readFileSync(sqlPath, "utf8");
  assert.match(sql, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/u);
  assert.match(sql, /validation_code_reprocessings/u);
  assert.match(sql, /c\.scanned_at = r\.scanned_at/u);
  assert.match(sql, /c\.shift_id = r\.shift_id/u);
  assert.match(sql, /flatOnly/u);
  assert.match(sql, /'shelfLifeDays', p\.shelf_life_days/u);
  assert.match(sql, /'shelfLifeDays', product\.shelf_life_days/u);
  assert.match(sql, /product\.id = coalesce\(p\.product_id, ps\.product_id\)/u);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|TRUNCATE)\b/u);
});
const databaseUrl = process.env.STANDALONE_EXPORT_TEST_DATABASE_URL;
const psql = process.env.PSQL ?? "psql";
const id = (n) => `a1710000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (n) => n.toString(16).padStart(64, "0");
const tenants = "('history-test-own', 'history-test-other')";
const cleanup = `DELETE FROM validation_code_reprocessings WHERE tenant_id IN ${tenants}; DELETE FROM code_registry WHERE tenant_id IN ${tenants}; DELETE FROM codes WHERE tenant_id IN ${tenants}; DELETE FROM box_items WHERE tenant_id IN ${tenants}; DELETE FROM boxes WHERE tenant_id IN ${tenants}; DELETE FROM pallets WHERE tenant_id IN ${tenants}; DELETE FROM shifts WHERE tenant_id IN ${tenants}; DELETE FROM products WHERE tenant_id IN ${tenants}; DELETE FROM org_profiles WHERE tenant_id IN ${tenants}; DELETE FROM station_devices WHERE tenant_id IN ${tenants}; DELETE FROM organization WHERE id IN ${tenants};`;
function envFor(url) {
  const u = new URL(url);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.slice(1),
  };
}
function execute(env, sql) {
  const result = spawnSync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr);
}
test(
  "snapshot selects a tenant, retains old owners and warehouse closure, rejects missing canonical and active shifts",
  {
    skip: databaseUrl
      ? false
      : "set STANDALONE_EXPORT_TEST_DATABASE_URL to a disposable migrated cloud database",
  },
  async () => {
    const env = envFor(databaseUrl);
    execute(
      env,
      `CREATE TABLE IF NOT EXISTS codes_2026_10 PARTITION OF codes FOR VALUES FROM ('2026-10-01') TO ('2026-11-01'); CREATE TABLE IF NOT EXISTS codes_2024_01 PARTITION OF codes FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');`,
    );
    execute(env, cleanup);
    try {
      execute(
        env,
        `
      INSERT INTO organization(id,name,slug,created_at) VALUES ('history-test-own','Own','history-test-own',now()),('history-test-other','Other','history-test-other',now());
      INSERT INTO org_profiles(tenant_id,gln) VALUES ('history-test-own','4600682000010'),('history-test-other','4600682000010');
      INSERT INTO products(id,tenant_id,gtin14,name) VALUES ('${id(1)}','history-test-own','04600682000010','Milk'),('${id(2)}','history-test-other','04600682000010','Other');
      INSERT INTO shifts(id,tenant_id,product_id,mode,status,number_month_key,number_seq,closed_at,production_date) VALUES
        ('${id(10)}','history-test-own','${id(1)}','aggregation','closed','OCT26',7,'2026-10-16T12:00:00.123Z','2026-10-16'),
        ('${id(11)}','history-test-own','${id(1)}','aggregation','closed','JAN24',1,'2024-01-01T12:00:00Z','2024-01-01'),
        ('${id(12)}','history-test-own','${id(1)}','aggregation','closed','JAN24',2,'2024-01-02T12:00:00Z','2024-01-02'),
        ('${id(13)}','history-test-own','${id(1)}','validation','closed','OCT26',8,'2026-10-17T12:00:00Z','2026-10-17'),
        ('${id(99)}','history-test-other','${id(2)}','aggregation','active','OCT26',99,NULL,'2026-10-17');
      INSERT INTO pallets(id,tenant_id,shift_id,kind,product_id,device_id,terminal_id,device_pallet_id,sscc,closed_at) VALUES ('${id(20)}','history-test-own',NULL,'warehouse','${id(1)}','${id(30)}','${id(30)}','p','199999999900000016','2026-10-16T12:00:00Z');
    `.replace(
          "      INSERT INTO pallets",
          `      INSERT INTO station_devices(id,tenant_id,name) VALUES ('${id(30)}','history-test-own','Station');\n      INSERT INTO pallets`,
        ),
      );
      execute(
        env,
        `
      INSERT INTO boxes(id,tenant_id,shift_id,device_box_id,sscc,closed_at,pallet_id) VALUES
        ('${id(40)}','history-test-own','${id(10)}','b1','099999999900000019','2026-10-16T11:00:00Z','${id(20)}'),
        ('${id(41)}','history-test-own','${id(11)}','b2','099999999900000026','2024-01-01T11:00:00Z','${id(20)}'),
        ('${id(42)}','history-test-own','${id(12)}','b3','099999999900000033','2024-01-02T11:00:00Z',NULL);
      INSERT INTO codes(tenant_id,code_hash,shift_id,gtin14,serial,canonical_raw,scanned_at) VALUES
        ('history-test-own','${hash(1)}','${id(10)}','04600682000010','A',E'010460068200001021A\\x1d91TEST','2026-10-16T10:00:00Z'),
        ('history-test-own','${hash(2)}','${id(11)}','04600682000010','B','exact-old-canonical','2024-01-01T10:00:00Z'),
        ('history-test-own','${hash(3)}','${id(12)}','04600682000010','C','old-owner-only','2024-01-02T10:00:00Z');
      INSERT INTO code_registry(tenant_id,code_hash,shift_id,scanned_at) SELECT tenant_id,code_hash,shift_id,scanned_at FROM codes WHERE tenant_id='history-test-own';
      INSERT INTO box_items(tenant_id,box_id,code_hash,added_at) VALUES ('history-test-own','${id(40)}','${hash(1)}','2026-10-16T10:00:00Z'),('history-test-own','${id(41)}','${hash(2)}','2024-01-01T10:00:00Z'),('history-test-own','${id(42)}','${hash(3)}','2024-01-02T10:00:00Z');
      INSERT INTO validation_code_reprocessings(tenant_id,shift_id,code_hash,source_shift_id,terminal_id,scanned_at,canonical_raw) VALUES ('history-test-own','${id(13)}','${hash(3)}','${id(12)}','${id(30)}','2026-10-17T10:00:00Z',E'REPEAT\\x1dEXACT');
    `,
      );
      const collect = async () => {
        const rows = [];
        for await (const row of runHistoryPsql({
          psql,
          tenantId: "history-test-own",
          since: "2025-10-17",
          env,
        }))
          rows.push(row);
        return rows;
      };
      const rows = await collect();
      assert.equal(rows[0].value.clean, true);
      assert.equal(rows.filter((r) => r.type === "owners").length, 3);
      assert.equal(rows.filter((r) => r.type === "shifts").length, 3);
      assert.equal(
        rows.find((r) => r.type === "shifts" && r.value.id === id(11)).value.inWindow,
        false,
      );
      assert.ok(!JSON.stringify(rows).includes(id(99)));
      assert.ok(
        rows.some(
          (r) =>
            r.type === "codes" && r.value.flatOnly && r.value.canonical === "REPEAT\u001dEXACT",
        ),
      );
      assert.equal(rows.filter((r) => r.type === "items").length, 2);
      assert.deepEqual(
        rows.find((r) => r.type === "owners" && r.value.hash === hash(3)).value,
        externalOwner,
      );
      assert.ok(!rows.some((r) => r.type === "shifts" && r.value.id === id(12)));
      assert.ok(!rows.some((r) => r.type === "boxes" && r.value.id === id(42)));
      assert.ok(!rows.some((r) => r.type === "items" && r.value.boxId === id(42)));
      const dir = await mkdtemp(join(tmpdir(), "history-sql-wire-"));
      try {
        async function* stream() {
          yield* rows;
        }
        const manifest = await writeHistory(join(dir, "history.jsonl"), stream(), {
          exportedAt: "2026-10-17T00:00:00.000Z",
        });
        assert.equal(manifest.exportedAt, rows[0].value.exportedAt);
        assert.equal(manifest.since, "2025-10-17");
        assert.equal(manifest.counts.owners, 3);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      // Canonical distractors agree on the hash but differ in the tenant, shift
      // or precise scan timestamp. None may satisfy a missing authoritative row.
      const distractors = [
        {
          tenant: "history-test-other",
          shift: id(99),
          at: "2024-01-02T10:00:00Z",
          name: "wrong-tenant",
        },
        {
          tenant: "history-test-own",
          shift: id(11),
          at: "2024-01-02T10:00:00Z",
          name: "wrong-shift",
        },
        {
          tenant: "history-test-own",
          shift: id(12),
          at: "2024-01-02T10:00:00.001Z",
          name: "wrong-time",
        },
      ];
      execute(
        env,
        `DELETE FROM codes WHERE tenant_id='history-test-own' AND code_hash='${hash(3)}';`,
      );
      for (const other of distractors) {
        execute(
          env,
          `INSERT INTO codes(tenant_id,code_hash,shift_id,gtin14,serial,canonical_raw,scanned_at) VALUES ('${other.tenant}','${hash(3)}','${other.shift}','04600682000010','X','${other.name}','${other.at}');`,
        );
        assert.deepEqual(
          (await collect())[0],
          { type: "error", value: "missing_canonical" },
          other.name,
        );
        execute(
          env,
          `DELETE FROM codes WHERE tenant_id='${other.tenant}' AND code_hash='${hash(3)}';`,
        );
      }
      execute(
        env,
        `DELETE FROM codes WHERE tenant_id='history-test-own' AND code_hash='${hash(3)}';`,
      );
      assert.deepEqual((await collect())[0], { type: "error", value: "missing_canonical" });
      execute(env, `UPDATE shifts SET status='active' WHERE id='${id(10)}';`);
      assert.deepEqual((await collect())[0], { type: "error", value: "cloud_not_clean" });
    } finally {
      execute(env, cleanup);
    }
  },
);
