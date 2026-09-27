import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import type { TransformationDraft } from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Transformation live readiness", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    f = await createUsProfileTestDatabase(url!);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  async function fixture() {
    const c = await seedCompleteReceiving(f.db);
    await f.db
      .update(schema.traceabilityLocations)
      .set({ roles: ["receive_at", "processor"] })
      .where(eq(schema.traceabilityLocations.id, c.location));
    await f.db
      .update(schema.productTraceabilityProfiles)
      .set({
        coverageStatus: "covered",
        ftlCategory: "Fresh-cut fruits",
        ftlSourceUrl:
          "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
        ftlSourceVersion: "Synthetic 2026",
      })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const receiving = new UsReceivingStore(f.db);
    const r = await receiving.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "receiving",
    );
    const ready = await receiving.checkReadiness(c.tenant, c.actor, r.id, {
      expectedDraftVersion: 1,
    });
    await receiving.finalize(
      c.tenant,
      c.actor,
      r.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "finalize",
    );
    const lots = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.tenantId, c.tenant));
    const draft: TransformationDraft = {
      eventDate: "2026-09-26",
      processorLocationId: c.location,
      reason: "commingling_and_repacking",
      reasonNote: null,
      notes: null,
      inputs: lots.map((lot) => ({
        kind: "ftl_lot",
        lotId: lot.id,
        quantity: "500",
        unitOfMeasure: "lb",
      })),
      outputs: [
        { productId: c.product, tlc: "NEW-OUTPUT", quantity: "100", unitOfMeasure: "case" },
      ],
      documentIds: [c.document],
    };
    const store = new UsTransformationStore(f.db);
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft },
      "transformation",
    );
    return { ...c, store, saved };
  }

  it("accepts real current Receiving origins and exact mixed units with a stable digest", async () => {
    const c = await fixture();
    const read = () =>
      c.store.checkReadiness(c.tenant, c.actor, c.saved.id, { expectedDraftVersion: 1 });
    const ready = await read();
    expect(ready).toMatchObject({
      state: "complete",
      expectedDraftVersion: 1,
      issues: [],
      ruleVersion: "transformation-readiness-v1",
    });
    expect(ready.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await read()).toEqual(ready);
    await expect(
      c.store.checkReadiness(c.tenant, c.actor, c.saved.id, { expectedDraftVersion: 2 }),
    ).rejects.toMatchObject({ response: { code: "transformation_draft_conflict" } });
    await f.db
      .update(schema.productTraceabilityProfiles)
      .set({ coverageRationale: "Changed actual review evidence" })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    expect((await read()).inputDigest).not.toBe(ready.inputDigest);
    await f.db
      .update(schema.products)
      .set({ archived: true })
      .where(eq(schema.products.id, c.product));
    expect((await read()).issues).toContainEqual(
      expect.objectContaining({ group: "outputs", code: "inactive" }),
    );
  });

  it("blocks imported active lots without origin, unreviewed coverage and archived processor", async () => {
    const c = await fixture();
    const imported = randomUUID();
    await f.db.insert(schema.traceabilityLots).values({
      id: imported,
      tenantId: c.tenant,
      productId: c.product,
      tlc: "IMPORTED",
      sourceLocationId: c.location,
      assignmentBasis: "imported",
      createdBy: c.actor,
      updatedBy: c.actor,
    });
    await c.store.saveDraft(
      c.tenant,
      c.actor,
      c.saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: {
          ...c.saved.draft,
          inputs: [{ kind: "ftl_lot", lotId: imported, quantity: "500", unitOfMeasure: "lb" }],
        },
      },
      "save",
    );
    await f.db
      .update(schema.productTraceabilityProfiles)
      .set({ coverageStatus: "unknown", reviewedBy: null, reviewedAt: null })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    await f.db
      .update(schema.traceabilityLocations)
      .set({ archived: true })
      .where(eq(schema.traceabilityLocations.id, c.location));
    const ready = await c.store.checkReadiness(c.tenant, c.actor, c.saved.id, {
      expectedDraftVersion: 2,
    });
    expect(ready.state).toBe("incomplete");
    expect(ready.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "inputs", field: "origin", code: "unresolved" }),
        expect.objectContaining({
          group: "inputs",
          field: "coverage",
          code: "coverage_unresolved",
        }),
        expect.objectContaining({ group: "event", field: "processorLocationId", code: "inactive" }),
      ]),
    );
  });
});
