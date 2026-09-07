import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("additive receiving finalization migration", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  const id = randomUUID();
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated database");
    fixture = await createUsProfileTestDatabase(url, 121);
    await fixture.pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('a','Synthetic','a',now())",
    );
    await fixture.pool.query(
      "INSERT INTO traceability_events(id,tenant_id,event_number,time_zone,created_by,updated_by) VALUES ($1,'a','REC-26-0001','America/Chicago','actor','actor')",
      [id],
    );
    await fixture.pool.query(
      "INSERT INTO receiving_event_items(tenant_id,event_id,line_no,lot_link_mode,exempt_supplier,quantity) VALUES ('a',$1,1,'create_on_finalize',false,'500.000')",
      [id],
    );
    await fixture.pool.query("INSERT INTO receiving_counters VALUES ('a',2026,1)");
    await fixture.pool.query(
      "INSERT INTO receiving_operations(tenant_id,command,operation_key,input_digest,event_id,result) VALUES ('a','receiving.create',$1,$2,$3,'{\"historical\":true}')",
      [randomUUID(), "a".repeat(64), id],
    );
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  it("preserves incomplete drafts, children, counters and historical receipts exactly", async () => {
    const state = async () =>
      (
        await fixture.pool.query(
          "SELECT to_jsonb(e) - ARRAY['finalized_at','finalized_by','finalization_snapshot'] AS event, (SELECT jsonb_agg(i) FROM receiving_event_items i) AS items, (SELECT jsonb_agg(r) FROM receiving_operations r) AS receipts, (SELECT jsonb_agg(c) FROM receiving_counters c) AS counters FROM traceability_events e",
        )
      ).rows;
    const before = await state();
    expect(() =>
      readFileSync("migrations/0122_us_receiving_finalization.sql", "utf8"),
    ).not.toThrow();
    await fixture.pool.query(readFileSync("migrations/0122_us_receiving_finalization.sql", "utf8"));
    expect(await state()).toEqual(before);
  });
  it("denies raw finalized inserts and incomplete transitions", async () => {
    await expect(
      fixture.pool.query(
        "INSERT INTO traceability_events(tenant_id,event_number,time_zone,created_by,updated_by,status,finalized_at,finalized_by,finalization_snapshot) VALUES ('a','REC-26-0002','America/Chicago','actor','actor','finalized',now(),'actor','{}')",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query(
        "UPDATE traceability_events SET status='finalized',finalized_at=now(),finalized_by='actor',finalization_snapshot='{}' WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query("UPDATE traceability_events SET finalized_at=now() WHERE id=$1", [id]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
