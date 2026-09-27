import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving event-date compatibility", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated synthetic database");
    fixture = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });

  it("preserves a leap-day dateReceived through storage, readiness, finalization and frozen reads", async () => {
    const c = await seedCompleteReceiving(fixture.db);
    const store = new UsReceivingStore(fixture.db);
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: { ...c.draft, dateReceived: "2024-02-29" },
      },
      "date-create",
    );
    expect(saved.draft.dateReceived).toBe("2024-02-29");
    expect(
      (
        await fixture.pool.query(
          "SELECT event_date::text AS date FROM traceability_events WHERE id=$1",
          [saved.id],
        )
      ).rows,
    ).toEqual([{ date: "2024-02-29" }]);
    expect(await store.getRecord(c.tenant, c.actor, saved.id)).toMatchObject({
      draft: { dateReceived: "2024-02-29" },
    });
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(ready.state).toBe("complete");
    const finalized = await store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "date-finalize",
    );
    expect(finalized.snapshot.dateReceived).toBe("2024-02-29");
    expect(finalized.snapshot).not.toHaveProperty("eventDate");
    expect(await store.getRecord(c.tenant, c.actor, saved.id)).toEqual(finalized);
    expect(await store.getLiveRecord(c.tenant, c.actor, saved.id)).toMatchObject({
      content: { snapshot: { dateReceived: "2024-02-29" } },
    });
    const tx = await fixture.pool.connect();
    try {
      await tx.query("BEGIN");
      for (const zone of ["Pacific/Kiritimati", "America/Los_Angeles"]) {
        await tx.query("SELECT set_config('TimeZone',$1,true)", [zone]);
        expect(
          (
            await tx.query(
              "SELECT event_date::text AS date,finalization_snapshot->>'dateReceived' AS frozen FROM traceability_events WHERE id=$1",
              [saved.id],
            )
          ).rows,
        ).toEqual([{ date: "2024-02-29", frozen: "2024-02-29" }]);
      }
    } finally {
      try {
        await tx.query("ROLLBACK");
      } finally {
        tx.release();
      }
    }
  });
});
