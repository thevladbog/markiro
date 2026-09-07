import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("receiving additive migration", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  const event = randomUUID(),
    foreignEvent = randomUUID(),
    product = randomUUID(),
    lot = randomUUID(),
    location = randomUUID(),
    document = randomUUID();
  let previous: unknown;
  const oldRows = async () =>
    Promise.all(
      ["products", "traceability_lots", "reference_documents"].map(
        async (table) => (await fixture.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows,
      ),
    );
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    fixture = await createUsProfileTestDatabase(url, 120);
    await fixture.pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('a','A','a',now()),('b','B','b',now())",
    );
    await fixture.pool.query(
      "INSERT INTO products(id,tenant_id,name) VALUES ($1,'b','Synthetic apples')",
      [product],
    );
    await fixture.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,created_by,updated_by) VALUES ($1,'b',$2,'LOT','imported','actor','actor')",
      [lot, product],
    );
    await fixture.pool.query(
      "INSERT INTO reference_documents(id,tenant_id,type,number,created_by) VALUES ($1,'b','bol','0001','actor')",
      [document],
    );
    await fixture.pool.query(
      "INSERT INTO traceability_parties(id,tenant_id,name) VALUES ($1,'b','Supplier')",
      [location],
    );
    await fixture.pool.query(
      "INSERT INTO traceability_locations(id,tenant_id,party_id,name,business_name) VALUES ($1,'b',$1,'Dock','Supplier')",
      [location],
    );
    previous = await oldRows();
    await fixture.pool.query(readFileSync("migrations/0121_us_receiving_drafts.sql", "utf8"));
    await fixture.pool.query(
      "INSERT INTO traceability_events(id,tenant_id,event_number,time_zone,created_by,updated_by) VALUES ($1,'a','REC-26-0001','America/Chicago','actor','actor'),($2,'b','REC-26-0001','America/Chicago','actor','actor')",
      [event, foreignEvent],
    );
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });

  it("preserves old rows without latching lots or creating receiving items", async () => {
    expect(await oldRows()).toEqual(previous);
    expect((await fixture.pool.query("SELECT * FROM receiving_event_items")).rows).toEqual([]);
  });
  it.each(["0", "1a2", "1e3", "-1", "1.2345", "1000000000000000"])(
    "rejects invalid exact quantities %s",
    async (quantity) => {
      await expect(
        fixture.pool.query(
          "INSERT INTO receiving_event_items(tenant_id,event_id,line_no,lot_link_mode,exempt_supplier,quantity) VALUES ('a',$1,1,'link_existing',true,$2)",
          [event, quantity],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    },
  );
  it("preserves fractional spelling in incomplete rows", async () => {
    await fixture.pool.query(
      "INSERT INTO receiving_event_items(tenant_id,event_id,line_no,lot_link_mode,exempt_supplier,quantity) VALUES ('a',$1,2,'link_existing',true,'500.000')",
      [event],
    );
    expect(
      (
        await fixture.pool.query(
          "SELECT quantity FROM receiving_event_items WHERE event_id=$1 AND line_no=2",
          [event],
        )
      ).rows,
    ).toEqual([{ quantity: "500.000" }]);
  });
  it.each([
    "status='finalized'",
    "type='shipping'",
    "revision=2",
    "draft_version=0",
    "date_received='10000-01-01'",
  ])("rejects unsupported header state %s", async (assignment) => {
    await expect(
      fixture.pool.query(`UPDATE traceability_events SET ${assignment} WHERE id=$1`, [event]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it.each(["product_id", "lot_id", "source_location_id", "source_reference_location_id"])(
    "denies foreign row reference %s",
    async (column) => {
      const value = column === "product_id" ? product : column === "lot_id" ? lot : location;
      const extra =
        column === "source_reference_location_id"
          ? ",source_reference_kind,source_reference_value"
          : "";
      const values =
        column === "source_reference_location_id"
          ? ",'web_url','https://supplier.example.test'"
          : "";
      await expect(
        fixture.pool.query(
          `INSERT INTO receiving_event_items(tenant_id,event_id,line_no,lot_link_mode,exempt_supplier,${column}${extra}) VALUES ('a',$1,3,'link_existing',false,$2${values})`,
          [event, value],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    },
  );
  it("denies foreign headers, event children, operation receipts and document links", async () => {
    for (const column of ["location_id", "previous_source_location_id"]) {
      await expect(
        fixture.pool.query(`UPDATE traceability_events SET ${column}=$1 WHERE id=$2`, [
          location,
          event,
        ]),
      ).rejects.toMatchObject({ code: "23503" });
    }
    await expect(
      fixture.pool.query(
        "INSERT INTO receiving_event_items(tenant_id,event_id,line_no,lot_link_mode,exempt_supplier) VALUES ('a',$1,4,'link_existing',false)",
        [foreignEvent],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      fixture.pool.query(
        "INSERT INTO receiving_event_documents(tenant_id,event_id,document_id,position) VALUES ('a',$1,$2,1)",
        [event, document],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      fixture.pool.query(
        "INSERT INTO receiving_operations(tenant_id,command,operation_key,input_digest,event_id,result) VALUES ('a','receiving.create',$1,$2,$3,'{}')",
        [randomUUID(), "a".repeat(64), foreignEvent],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
