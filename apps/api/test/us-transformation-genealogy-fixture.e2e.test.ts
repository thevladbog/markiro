import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { readCurrentTransformationOrigin } from "../src/modules/traceability/transformation/us-transformation-origin";
import {
  seedTwoByTwoGenealogy,
  seedZeroFtlGenealogy,
  seedVoidedAmendmentDraftGenealogy,
} from "./support/us-transformation-genealogy-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Transformation genealogy finalization fixtures", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  async function frozenBytes(tenant: string, eventId: string) {
    const { rows } = await f.pool.query(
      `SELECT e.finalization_snapshot::text AS snapshot,
        (SELECT jsonb_agg(to_jsonb(edge) ORDER BY input_lot_id, output_lot_id)::text
           FROM lot_genealogy_edges edge
          WHERE edge.tenant_id=$1 AND edge.event_id=$2) AS edges
       FROM traceability_events e WHERE e.tenant_id=$1 AND e.id=$2`,
      [tenant, eventId],
    );
    return rows[0] as { snapshot: string; edges: string | null };
  }

  it("persists exactly four directed edges for each 2 FTL to 2 output revision and freezes bytes", async () => {
    const c = await seedTwoByTwoGenealogy(f);
    const inputIds = c.original.snapshot.inputs.map((line) => {
      if (line.kind !== "ftl_lot") throw new Error("Expected FTL input");
      return line.lotId;
    });
    const outputIds = c.original.snapshot.outputs.map((line) => line.lotId);
    expect(inputIds).toHaveLength(2);
    expect(outputIds).toHaveLength(2);
    expect(c.revision.snapshot.outputs.map((line) => line.lotId)).toEqual(outputIds);
    expect(c.original.snapshot.inputs.map((line) => line.quantity)).toEqual(["500", "500"]);
    expect(c.original.snapshot.outputs.map((line) => line.quantity)).toEqual(["100", "75"]);
    expect(c.revision.snapshot.outputs.map((line) => line.quantity)).toEqual(["110", "70"]);
    const expected = inputIds.flatMap((inputLotId) =>
      outputIds.map((outputLotId) => ({ input_lot_id: inputLotId, output_lot_id: outputLotId })),
    );
    for (const event of [c.original, c.revision]) {
      const { rows } = await f.pool.query(
        `SELECT input_lot_id,output_lot_id FROM lot_genealogy_edges
          WHERE tenant_id=$1 AND event_id=$2 ORDER BY input_lot_id,output_lot_id`,
        [c.tenant, event.id],
      );
      expect(rows).toHaveLength(4);
      expect(rows).toEqual(expect.arrayContaining(expected));
    }
    const originalBytes = await frozenBytes(c.tenant, c.original.id);
    const revisionBytes = await frozenBytes(c.tenant, c.revision.id);
    await f.pool.query(
      "UPDATE products SET name='Later product name' WHERE tenant_id=$1 AND id=$2",
      [c.tenant, c.product],
    );
    await f.pool.query(
      "UPDATE traceability_locations SET name='Later location name' WHERE tenant_id=$1 AND id=$2",
      [c.tenant, c.processor],
    );
    expect(await frozenBytes(c.tenant, c.original.id)).toEqual(originalBytes);
    expect(await frozenBytes(c.tenant, c.revision.id)).toEqual(revisionBytes);
  });

  it("retains a non-FTL line with no input lot edge through amendment and current void", async () => {
    const c = await seedZeroFtlGenealogy(f);
    for (const event of [c.original, c.revision]) {
      expect(event.snapshot.inputs).toEqual([
        expect.objectContaining({
          kind: "non_ftl",
          reference: "Invoice non-FTL 42",
          quantity: "0.250",
          unitOfMeasure: "lb",
        }),
      ]);
      expect(event.snapshot.outputs).toHaveLength(1);
      expect((await frozenBytes(c.tenant, event.id)).edges).toBeNull();
    }
    expect(c.voided.status).toBe("void");
    expect(c.voided.snapshot).toEqual(c.revision.snapshot);
    const originalBytes = await frozenBytes(c.tenant, c.original.id);
    const revisionBytes = await frozenBytes(c.tenant, c.revision.id);
    await f.pool.query(
      "UPDATE products SET name='Later non-FTL name' WHERE tenant_id=$1 AND id=$2",
      [c.tenant, c.nonFtlProductId],
    );
    expect(await frozenBytes(c.tenant, c.original.id)).toEqual(originalBytes);
    expect(await frozenBytes(c.tenant, c.revision.id)).toEqual(revisionBytes);
  });

  it("persists a voided amendment draft with null finalization snapshot and no edges", async () => {
    const c = await seedVoidedAmendmentDraftGenealogy(f);
    expect(c.voidedDraft.status).toBe("void");
    expect(c.voidedDraft.lifecycle?.previousRevisionId).toBe(c.original.id);
    const draftBytes = await frozenBytes(c.tenant, c.voidedDraft.id);
    expect(draftBytes).toEqual({ snapshot: null, edges: null });
    expect((await frozenBytes(c.tenant, c.original.id)).snapshot).not.toBeNull();
    const outputLotId = c.original.snapshot.outputs[0]?.lotId;
    if (!outputLotId) throw new Error("Missing original output lot");
    expect(
      await f.db.transaction((tx) => readCurrentTransformationOrigin(tx, c.tenant, outputLotId)),
    ).toEqual({ lotId: outputLotId, currentOrigin: true, eventId: c.original.id });
  });
});
