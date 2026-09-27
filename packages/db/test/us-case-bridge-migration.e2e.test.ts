import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildSscc } from "../../domain/src/gs1/sscc.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
const code = buildSscc(0, "1234567", 7);

describe.skipIf(!url)("case bridge migration in disposable US PostgreSQL", () => {
  let fresh: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let upgrade: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  const tenant = "case_a";
  const foreign = "case_b";
  const product = randomUUID();
  const lot = randomUUID();
  const foreignLot = randomUUID();
  const box = randomUUID();
  const foreignBox = randomUUID();

  async function seed(db: Awaited<ReturnType<typeof createUsProfileTestDatabase>>) {
    await db.pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ($1,'Case A','case-a',now()),($2,'Case B','case-b',now())",
      [tenant, foreign],
    );
    await db.pool.query(
      "INSERT INTO products(id,tenant_id,name) VALUES ($1,$2,'Apples'),($3,$4,'Pears')",
      [product, tenant, randomUUID(), foreign],
    );
    const foreignProduct = (
      await db.pool.query("SELECT id FROM products WHERE tenant_id=$1", [foreign])
    ).rows[0].id;
    await db.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,created_by,updated_by) VALUES ($1,$2,$3,'LOT-A','imported','fixture','fixture'),($4,$5,$6,'LOT-B','imported','fixture','fixture')",
      [lot, tenant, product, foreignLot, foreign, foreignProduct],
    );
    const shiftA = randomUUID(),
      shiftB = randomUUID();
    await db.pool.query(
      "INSERT INTO shifts(id,tenant_id,product_id,mode,number_month_key,number_seq) VALUES ($1,$2,$3,'aggregation','SEP26',1),($4,$5,$6,'aggregation','SEP26',1)",
      [shiftA, tenant, product, shiftB, foreign, foreignProduct],
    );
    await db.pool.query(
      "INSERT INTO boxes(id,tenant_id,shift_id,device_box_id,sscc) VALUES ($1,$2,$3,'case-a',$4),($5,$6,$7,'case-b',$8)",
      [box, tenant, shiftA, code, foreignBox, foreign, shiftB, buildSscc(0, "1234567", 8)],
    );
  }
  const link = (
    db: Awaited<ReturnType<typeof createUsProfileTestDatabase>>,
    fields: { tenant?: string; box?: string; lot?: string; sscc?: string } = {},
  ) =>
    db.pool.query(
      "INSERT INTO trace_lot_boxes(tenant_id,box_id,lot_id,sscc_at_link,link_source,linked_by) VALUES ($1,$2,$3,$4,'manual','fixture') RETURNING id",
      [fields.tenant ?? tenant, fields.box ?? box, fields.lot ?? lot, fields.sscc ?? code],
    );

  beforeAll(async () => {
    if (!url) throw new Error("Missing US_TEST_DATABASE_URL");
    fresh = await createUsProfileTestDatabase(url);
    upgrade = await createUsProfileTestDatabase(url, 132);
    expect((await upgrade.pool.query("SELECT count(*)::int AS n FROM boxes")).rows[0].n).toBe(0);
    await upgrade.pool.query(readFileSync("migrations/0133_us_case_bridge.sql", "utf8"));
    expect(
      (await upgrade.pool.query("SELECT count(*)::int AS n FROM trace_lot_boxes")).rows[0].n,
    ).toBe(0);
    await seed(upgrade);
    await seed(fresh);
  }, 120_000);
  afterAll(async () => {
    await Promise.all([fresh?.close(), upgrade?.close()]);
  });

  for (const mode of ["fresh", "upgrade"] as const) {
    it(`${mode}: rejects foreign box and lot, malformed SSCC, and second active link`, async () => {
      const db = mode === "fresh" ? fresh : upgrade;
      await expect(link(db, { box: foreignBox })).rejects.toMatchObject({ code: "23503" });
      await expect(link(db, { lot: foreignLot })).rejects.toMatchObject({ code: "23503" });
      await expect(link(db, { sscc: "123" })).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.pool.query(
          "INSERT INTO trace_lot_boxes(tenant_id,box_id,lot_id,sscc_at_link,link_source,linked_by,unlinked_at,unlinked_by) VALUES ($1,$2,$3,$4,'manual','fixture',now(),'fixture')",
          [tenant, box, lot, code],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await link(db);
      await expect(link(db)).rejects.toMatchObject({ code: "23505" });
    });

    it(`${mode}: allows one unlink and later history, preserving immutable marker and receipts`, async () => {
      const db = mode === "fresh" ? fresh : upgrade;
      const first = (
        await db.pool.query(
          "SELECT id FROM trace_lot_boxes WHERE tenant_id=$1 AND box_id=$2 AND unlinked_at IS NULL",
          [tenant, box],
        )
      ).rows[0].id;
      await db.pool.query(
        "INSERT INTO traceability_synthetic_case_origins(tenant_id,box_id,seed_id,seed_version) VALUES ($1,$2,'fixture',1)",
        [tenant, box],
      );
      await expect(
        db.pool.query("UPDATE trace_lot_boxes SET lot_id=$1 WHERE id=$2", [foreignLot, first]),
      ).rejects.toMatchObject({ code: "23514" });
      await db.pool.query(
        "UPDATE trace_lot_boxes SET unlinked_at=now(),unlinked_by='fixture',unlink_reason='Wrong lot' WHERE id=$1",
        [first],
      );
      await expect(
        db.pool.query("UPDATE trace_lot_boxes SET unlink_reason='Changed' WHERE id=$1", [first]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.pool.query("DELETE FROM trace_lot_boxes WHERE id=$1", [first]),
      ).rejects.toMatchObject({ code: "23514" });
      await link(db);
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM trace_lot_boxes WHERE tenant_id=$1 AND box_id=$2",
            [tenant, box],
          )
        ).rows[0].n,
      ).toBe(2);
      expect(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM traceability_synthetic_case_origins WHERE tenant_id=$1 AND box_id=$2",
            [tenant, box],
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        db.pool.query(
          "DELETE FROM traceability_synthetic_case_origins WHERE tenant_id=$1 AND box_id=$2",
          [tenant, box],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await db.pool.query(
        "INSERT INTO trace_lot_box_operations(tenant_id,command,operation_key,input_digest,target_id,result) VALUES ($1,'case.link',$2,$3,$4,'{}')",
        [tenant, randomUUID(), "a".repeat(64), lot],
      );
      await expect(
        db.pool.query("DELETE FROM trace_lot_box_operations WHERE tenant_id=$1", [tenant]),
      ).rejects.toMatchObject({ code: "23514" });
    });
  }
  it("upgrade does not fabricate historical case rows", async () => {
    expect(
      (await upgrade.pool.query("SELECT count(*)::int AS n FROM trace_lot_boxes")).rows[0].n,
    ).toBe(2);
  });
});
