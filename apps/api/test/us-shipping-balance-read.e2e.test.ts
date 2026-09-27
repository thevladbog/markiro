import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  finalizeFixtureShipment,
  seedShippingLifecycle,
} from "./support/us-shipping-lifecycle-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Shipping balance read in disposable PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    f = await createUsProfileTestDatabase(url!);
  }, 60_000);
  afterAll(async () => f?.close());

  it("reads exact current balance without writes and previews only the verified predecessor", async () => {
    const c = await seedShippingLifecycle(f.db);
    const first = await finalizeFixtureShipment(c, "20.001");
    const countBefore = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
    await expect(c.store.getLotShippingBalance(c.tenant, c.actor, c.lot, {})).resolves.toEqual({
      lotId: c.lot,
      originUom: "case",
      balance: {
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "20.001",
        remaining: "79.999",
      },
    });
    const started = await c.store.amend(
      c.tenant,
      c.actor,
      first.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: first.lifecycle!.lifecycleVersion,
        reason: "Correct quantity",
      },
      "balance-amend",
    );
    await expect(
      c.store.getLotShippingBalance(c.tenant, c.actor, c.lot, {
        contextDraftId: started.eventId,
        expectedDraftVersion: 1,
      }),
    ).resolves.toEqual({
      lotId: c.lot,
      originUom: "case",
      balance: {
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "0",
        remaining: "100",
      },
    });
    await expect(
      c.store.getLotShippingBalance(c.tenant, c.actor, c.lot, {}),
    ).resolves.toMatchObject({ balance: { remaining: "79.999" } });
    await expect(
      c.store.getLotShippingBalance(c.tenant, c.actor, c.lot, {
        contextDraftId: started.eventId,
        expectedDraftVersion: 2,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      c.store.getLotShippingBalance(randomUUID(), c.actor, c.lot, {}),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      c.store.getLotShippingBalance(c.tenant, c.actor, randomUUID(), {}),
    ).rejects.toMatchObject({ status: 404 });
    const countAfter = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
    expect(countAfter.length - countBefore.length).toBe(1); // only the amend command audits
  });

  it("conceals an existing other tenant's lot and pending draft from a valid reader without auditing", async () => {
    const first = await seedShippingLifecycle(f.db);
    const other = await seedShippingLifecycle(f.db);
    const pending = await other.store.createDraft(
      other.tenant,
      other.actor,
      {
        operationKey: randomUUID(),
        draft: other.draft,
      },
      "other-tenant-draft",
    );
    const before = await f.db.select().from(schema.tenantAuditEvents);
    await expect(
      first.store.getLotShippingBalance(first.tenant, first.actor, other.lot, {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      first.store.getLotShippingBalance(first.tenant, first.actor, first.lot, {
        contextDraftId: pending.id,
        expectedDraftVersion: pending.draftVersion,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const after = await f.db.select().from(schema.tenantAuditEvents);
    expect(after).toEqual(before);
  });
});
