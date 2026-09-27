import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Shipping finalization concurrency", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    fixture = await createUsProfileTestDatabase(url!);
  }, 60_000);
  afterAll(async () => fixture?.close());

  it("allows exactly one of two concurrent 60-case deductions from a 100-case lot", async () => {
    const c = await seedCompleteReceiving(fixture.db);
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ roles: ["receive_at", "ship_from"] })
      .where(eq(schema.traceabilityLocations.id, c.location));
    await fixture.db
      .update(schema.productTraceabilityProfiles)
      .set({
        coverageStatus: "covered",
        ftlCategory: "Fresh-cut fruits",
        ftlSourceUrl:
          "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
        ftlSourceVersion: "Synthetic 2026",
      })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const recipientId = randomUUID();
    await fixture.db.insert(schema.traceabilityLocations).values({
      id: recipientId,
      tenantId: c.tenant,
      partyId: c.party,
      name: "Recipient",
      businessName: "Synthetic buyer",
      phoneNumber: "+1 555 010 0200",
      streetAddress: "2 Test Street",
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      roles: ["recipient"],
    });
    const linked = c.draft.items[1];
    if (!linked) throw new Error("Missing linked Receiving line");
    linked.quantity = "100";
    linked.unitOfMeasure = "case";
    const receiving = new UsReceivingStore(fixture.db);
    const receipt = await receiving.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: c.draft,
      },
      "receipt",
    );
    const receiptReady = await receiving.checkReadiness(c.tenant, c.actor, receipt.id, {
      expectedDraftVersion: 1,
    });
    expect(receiptReady.state).toBe("complete");
    await receiving.finalize(
      c.tenant,
      c.actor,
      receipt.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: receiptReady.inputDigest,
      },
      "receipt-final",
    );

    const shipping = new UsShippingStore(fixture.db);
    const drafts = await Promise.all(
      [1, 2].map(async (index) => {
        const saved = await shipping.createDraft(
          c.tenant,
          c.actor,
          {
            operationKey: randomUUID(),
            draft: {
              eventDate: "2026-09-27",
              shipFromLocationId: c.location,
              recipientLocationId: recipientId,
              carrierReference: null,
              notes: null,
              items: [{ lotId: c.lot, quantity: "60", unitOfMeasure: "case" }],
              documentIds: [c.document],
            },
          },
          `shipping-${index}`,
        );
        const ready = await shipping.checkReadiness(c.tenant, c.actor, saved.id, {
          expectedDraftVersion: 1,
        });
        expect(ready.state).toBe("complete");
        return { saved, ready };
      }),
    );
    const results = await Promise.allSettled(
      drafts.map(({ saved, ready }) =>
        shipping.finalize(
          c.tenant,
          c.actor,
          saved.id,
          {
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            expectedInputDigest: ready.inputDigest,
          },
          "concurrent-final",
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [lot] = await fixture.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.id, c.lot));
    expect(lot?.status).toBe("active");
  });
});
