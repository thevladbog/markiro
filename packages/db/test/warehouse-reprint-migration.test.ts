import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("warehouse reprint applied migration", () => {
  it.each([
    {
      file: "0181_warehouse_code_only_template.sql",
      name: "Код Data Matrix 30×30",
      purpose: "product_duplicate",
      width: 30,
      height: 30,
      data: "km.code",
    },
    {
      file: "0182_warehouse_code_only_box.sql",
      name: "SSCC короба 58×40",
      purpose: "box",
      width: 58,
      height: 40,
      data: "sscc",
    },
  ])("adds $purpose code-only option without overwriting customisation", async (preset) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const a = randomUUID();
    const b = randomUUID();
    const custom = randomUUID();
    const migration = await readFile(
      new URL(`../migrations/${preset.file}`, import.meta.url),
      "utf8",
    );
    try {
      await pool.query(
        "INSERT INTO organization(id,name,slug,created_at) VALUES($1,$1,$1,now()),($2,$2,$2,now())",
        [a, b],
      );
      await pool.query(
        "INSERT INTO label_templates(id,tenant_id,name,purpose,spec) VALUES($1,$2,$3,$4,'{\"custom\":true}')",
        [custom, b, preset.name, preset.purpose],
      );
      await pool.query(migration);
      const rows = await pool.query(
        "SELECT tenant_id,spec FROM label_templates WHERE tenant_id IN ($1,$2) AND name=$3",
        [a, b, preset.name],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.find((r) => r.tenant_id === a)?.spec).toMatchObject({
        widthMm: preset.width,
        heightMm: preset.height,
        elements: expect.arrayContaining([expect.objectContaining({ data: preset.data })]),
      });
      expect(rows.rows.find((r) => r.tenant_id === b)?.spec).toEqual({ custom: true });
    } finally {
      await pool.query("DELETE FROM label_templates WHERE tenant_id IN ($1,$2)", [a, b]);
      await pool.query("DELETE FROM organization WHERE id IN ($1,$2)", [a, b]);
      await pool.end();
    }
  });
  it("enforces composite device ownership and idempotent event keys", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const a = randomUUID();
    const b = randomUUID();
    const device = randomUUID();
    const job = randomUUID();
    try {
      await pool.query(
        "INSERT INTO organization(id,name,slug,created_at) VALUES($1,$1,$1,now()),($2,$2,$2,now())",
        [a, b],
      );
      await pool.query(
        "INSERT INTO station_devices(id,tenant_id,name) VALUES($1,$2,'Test station')",
        [device, b],
      );
      await expect(
        pool.query(
          "INSERT INTO warehouse_reprint_jobs(tenant_id,device_id,job_id,prepared,projection,latest_sequence) VALUES($1,$2,$3,'{}','{}',1)",
          [a, device, job],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await pool.query(
        "INSERT INTO warehouse_reprint_jobs(tenant_id,device_id,job_id,prepared,projection,latest_sequence) VALUES($1,$2,$3,'{}','{}',1)",
        [b, device, job],
      );
      await expect(
        pool.query(
          "INSERT INTO warehouse_reprint_jobs(tenant_id,device_id,job_id,prepared,projection,latest_sequence) VALUES($1,$2,$3,'{}','{}',1)",
          [b, device, job],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        pool.query("UPDATE warehouse_reprint_jobs SET latest_sequence=0 WHERE tenant_id=$1", [b]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await pool.query("DELETE FROM warehouse_reprint_jobs WHERE tenant_id IN ($1,$2)", [a, b]);
      await pool.query("DELETE FROM station_devices WHERE id=$1", [device]);
      await pool.query("DELETE FROM organization WHERE id IN ($1,$2)", [a, b]);
      await pool.end();
    }
  });
});
