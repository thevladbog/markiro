import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { readReceivingLiveRecord } from "../src/modules/traceability/receiving/us-receiving-history";
import { readReceivingRevisionContext } from "../src/modules/traceability/receiving/us-receiving-revision-readiness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { seedTransformationDraft } from "./support/us-transformation-draft-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving shared-event isolation", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  beforeAll(async () => {
    if (!url) throw new Error("Missing synthetic database");
    f = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(f.db);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  it("does not count a Transformation draft as Receiving support", async () => {
    const c = await seedCompleteReceiving(f.db);
    const before = await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {});
    await seedTransformationDraft(f, c.tenant, c.actor);
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toEqual(before);
    expect(before).toMatchObject({ state: "missing", supportCount: 0, items: [] });
  });

  it("returns the same safe 404 for wrong-type and foreign-tenant IDs", async () => {
    const c = await seedCompleteReceiving(f.db);
    const foreign = await seedCompleteReceiving(f.db);
    const wrongType = await seedTransformationDraft(f, c.tenant, c.actor);
    const foreignId = (
      await store.createDraft(
        foreign.tenant,
        foreign.actor,
        { operationKey: randomUUID(), draft: foreign.draft },
        "foreign",
      )
    ).id;
    for (const id of [wrongType, foreignId, randomUUID()]) {
      await expect(store.getRecord(c.tenant, c.actor, id)).rejects.toMatchObject({
        status: 404,
        response: { code: "receiving_draft_not_found" },
      });
    }
  });

  it("still refuses malformed Receiving roots alongside a valid Transformation draft", async () => {
    const c = await seedCompleteReceiving(f.db);
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "create",
    );
    await seedTransformationDraft(f, c.tenant, c.actor);
    const rollback = new Error("rollback synthetic Receiving corruption");
    await expect(
      f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx.execute(
          sql`UPDATE receiving_event_roots SET next_revision=7 WHERE tenant_id=${c.tenant} AND id=${saved.id}`,
        );
        await expect(readReceivingLiveRecord(tx, c.tenant, saved.id)).rejects.toMatchObject({
          status: 503,
          response: { code: "us_database_unavailable" },
        });
        await expect(
          readReceivingRevisionContext(tx, c.tenant, saved.id, 1, "US_FSMA204_PROCESSOR"),
        ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await store.getRecord(c.tenant, c.actor, saved.id)).toEqual(saved);
  });

  it("preserves complete Receiving reads, readiness, save, finalization, basis, amendment and void", async () => {
    const c = await seedCompleteReceiving(f.db);
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "create",
    );
    const before = await store.checkRevisionReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    await seedTransformationDraft(f, c.tenant, c.actor);
    expect(await store.getRecord(c.tenant, c.actor, saved.id)).toEqual(saved);
    expect(
      await store.checkRevisionReadiness(c.tenant, c.actor, saved.id, { expectedDraftVersion: 1 }),
    ).toEqual({ ...before, checkedAt: expect.any(String) });
    expect(
      await store.saveDraft(
        c.tenant,
        c.actor,
        saved.id,
        { operationKey: randomUUID(), expectedDraftVersion: 1, draft: c.draft },
        "save",
      ),
    ).toEqual(saved);
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    await store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "finalize",
    );
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      state: "present",
      supportCount: 1,
      items: [{ eventId: saved.id }],
    });
    const amendment = await store.amend(
      c.tenant,
      c.actor,
      saved.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Correct receipt",
      },
      "amend",
    );
    expect(amendment.record.status).toBe("draft");
    await store.void(
      c.tenant,
      c.actor,
      amendment.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 1,
        reason: "Entered in error",
      },
      "cancel",
    );
    await store.void(
      c.tenant,
      c.actor,
      saved.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 4,
        expectedDraftVersion: null,
        reason: "Entered in error",
      },
      "void",
    );
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      state: "missing",
      supportCount: 0,
    });
  });
});
