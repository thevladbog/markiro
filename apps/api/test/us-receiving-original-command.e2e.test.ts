import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Original Receiving command lifecycle compatibility", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing synthetic database");
    f = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(f.db);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    c = await seedCompleteReceiving(f.db);
  });

  async function prepare() {
    const create = { operationKey: randomUUID(), draft: c.draft };
    const created = await store.createDraft(c.tenant, c.actor, create, "create");
    const save = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: { ...c.draft, notes: "Original saved notation" },
    };
    const saved = await store.saveDraft(c.tenant, c.actor, created.id, save, "save");
    const ready = await store.checkReadiness(c.tenant, c.actor, created.id, {
      expectedDraftVersion: 2,
    });
    const finalize = {
      operationKey: randomUUID(),
      expectedDraftVersion: 2,
      expectedInputDigest: ready.inputDigest,
    };
    return { create, created, save, saved, finalize };
  }
  async function amend(id: string, version: number) {
    return store.amend(
      c.tenant,
      c.actor,
      id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: version,
        reason: "Correct receipt",
      },
      "amend",
    );
  }
  async function finish(id: string, draftVersion = 1) {
    const ready = await store.checkRevisionReadiness(c.tenant, c.actor, id, {
      expectedDraftVersion: draftVersion,
    });
    return store.finalizeRevision(
      c.tenant,
      c.actor,
      id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedDraftVersion: draftVersion,
        expectedLifecycleVersion: ready.expectedLifecycleVersion,
        previousRevisionId: ready.previousRevisionId,
        expectedInputDigest: ready.inputDigest,
        reviewedExemptLines: [],
      },
      "revision-finalize",
    );
  }
  const cancel = (id: string, version: number, draftVersion: number | null) =>
    store.void(
      c.tenant,
      c.actor,
      id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: version,
        expectedDraftVersion: draftVersion,
        reason: "Entered in error",
      },
      "void",
    );
  const state = async () =>
    (
      await f.pool.query(
        `SELECT
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM traceability_events e WHERE tenant_id=$1) AS events,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM receiving_event_roots r WHERE tenant_id=$1) AS roots,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM traceability_lots l WHERE tenant_id=$1) AS lots,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY event_id,line_no) FROM receiving_event_items i WHERE tenant_id=$1) AS items,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY event_id,position) FROM receiving_event_documents d WHERE tenant_id=$1) AS documents,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM receiving_operations o WHERE tenant_id=$1) AS operations,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM tenant_audit_events a WHERE organization_id=$1) AS audit`,
        [c.tenant],
      )
    ).rows;
  const states = [
    "void original draft",
    "void original receipt",
    "amended original",
    "pending amendment",
    "void amendment draft",
    "finalized amendment",
    "void amendment receipt",
    "amended amendment",
  ] as const;
  async function target(kind: (typeof states)[number]) {
    const p = await prepare();
    const rootId = p.created.id;
    if (kind === "void original draft") {
      await cancel(rootId, 1, 2);
      return { p, id: rootId, lifecycleVersion: 2, currentEventId: null, pendingDraftId: null };
    }
    await store.finalize(c.tenant, c.actor, rootId, p.finalize, "original-finalize");
    if (kind === "void original receipt") {
      await cancel(rootId, 2, null);
      return { p, id: rootId, lifecycleVersion: 3, currentEventId: null, pendingDraftId: null };
    }
    const a = await amend(rootId, 2);
    if (kind === "pending amendment")
      return {
        p,
        id: a.eventId,
        lifecycleVersion: 3,
        currentEventId: rootId,
        pendingDraftId: a.eventId,
      };
    if (kind === "void amendment draft") {
      await cancel(a.eventId, 3, 1);
      return {
        p,
        id: a.eventId,
        lifecycleVersion: 4,
        currentEventId: rootId,
        pendingDraftId: null,
      };
    }
    await finish(a.eventId);
    if (kind === "void amendment receipt") {
      await cancel(a.eventId, 4, null);
      return { p, id: a.eventId, lifecycleVersion: 5, currentEventId: null, pendingDraftId: null };
    }
    if (kind === "amended amendment") {
      const next = await amend(a.eventId, 4);
      await finish(next.eventId);
      return {
        p,
        id: a.eventId,
        lifecycleVersion: 6,
        currentEventId: next.eventId,
        pendingDraftId: null,
      };
    }
    return {
      p,
      id: kind === "amended original" ? rootId : a.eventId,
      lifecycleVersion: 4,
      currentEventId: a.eventId,
      pendingDraftId: null,
    };
  }
  it.each(
    states.flatMap((kind) => (["save", "finalize"] as const).map((command) => ({ kind, command }))),
  )(
    "rejects a new legacy $command key against $kind with exact lifecycle, without effects",
    async ({ kind, command }) => {
      const t = await target(kind);
      const before = await state();
      const expected = {
        status: 409,
        response: {
          code: "receiving_lifecycle_conflict",
          rootId: t.p.created.id,
          lifecycleVersion: t.lifecycleVersion,
          currentEventId: t.currentEventId,
          pendingDraftId: t.pendingDraftId,
        },
      };
      const call =
        command === "save"
          ? store.saveDraft(
              c.tenant,
              c.actor,
              t.id,
              { ...t.p.save, operationKey: randomUUID() },
              "invalid-save",
            )
          : store.finalize(
              c.tenant,
              c.actor,
              t.id,
              { ...t.p.finalize, operationKey: randomUUID() },
              "invalid-finalize",
            );
      await expect(call).rejects.toMatchObject(expected);
      expect(await state()).toEqual(before);
    },
  );
  it.each(
    [2, 3].flatMap((version) =>
      (["save", "finalize"] as const).map((command) => ({ version, command })),
    ),
  )(
    "keeps already-finalized conflicts for $command against a current original v$version receipt",
    async ({ version, command }) => {
      const p = await prepare();
      if (version === 2)
        await store.finalize(c.tenant, c.actor, p.created.id, p.finalize, "finalize");
      else await finish(p.created.id, 2);
      const before = await state();
      const call =
        command === "save"
          ? store.saveDraft(
              c.tenant,
              c.actor,
              p.created.id,
              { ...p.save, operationKey: randomUUID() },
              "new-save",
            )
          : store.finalize(
              c.tenant,
              c.actor,
              p.created.id,
              { ...p.finalize, operationKey: randomUUID() },
              "new-finalize",
            );
      await expect(call).rejects.toMatchObject({
        status: 409,
        response: { code: "receiving_already_finalized" },
      });
      expect(await state()).toEqual(before);
    },
  );
  it("keeps original successful responses byte-for-byte after actual amendment finalization and void", async () => {
    const p = await prepare();
    const frozen = await store.finalize(c.tenant, c.actor, p.created.id, p.finalize, "finalize");
    const a = await amend(p.created.id, 2);
    await finish(a.eventId);
    for (const phase of ["amended", "void"] as const) {
      if (phase === "void") await cancel(a.eventId, 4, null);
      const before = await state();
      expect(await store.createDraft(c.tenant, c.actor, p.create, "replay-create")).toEqual(
        p.created,
      );
      expect(await store.saveDraft(c.tenant, c.actor, p.created.id, p.save, "replay-save")).toEqual(
        p.saved,
      );
      expect(
        await store.finalize(c.tenant, c.actor, p.created.id, p.finalize, "replay-finalize"),
      ).toEqual(frozen);
      expect(await state()).toEqual(before);
      expect((await store.getLiveRecord(c.tenant, c.actor, p.created.id)).status).toBe("amended");
      expect((await store.getLiveRecord(c.tenant, c.actor, a.eventId)).status).toBe(
        phase === "void" ? "void" : "finalized",
      );
    }
  });
  it("denies a saved legacy receipt whose result and stored target both belong to another receipt", async () => {
    const p = await prepare();
    const other = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "other-create",
    );
    await f.db
      .update(schema.receivingOperations)
      .set({ eventId: other.id, result: other })
      .where(
        and(
          eq(schema.receivingOperations.tenantId, c.tenant),
          eq(schema.receivingOperations.command, "receiving.save"),
          eq(schema.receivingOperations.operationKey, p.save.operationKey),
        ),
      );
    const before = await state();
    await expect(
      store.saveDraft(c.tenant, c.actor, p.created.id, p.save, "corrupt-replay"),
    ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
    expect(await state()).toEqual(before);
  });
  it("reauthorizes before historical replay and before disclosing lifecycle pointers", async () => {
    const p = await prepare();
    await store.finalize(c.tenant, c.actor, p.created.id, p.finalize, "finalize");
    await cancel(p.created.id, 2, null);
    await f.db
      .update(schema.member)
      .set({ role: "traceability_receiving" })
      .where(eq(schema.member.id, c.member));
    expect(
      await store.saveDraft(c.tenant, c.actor, p.created.id, p.save, "receiver-replay"),
    ).toEqual(p.saved);
    for (const operationKey of [p.finalize.operationKey, randomUUID()])
      await expect(
        store.finalize(c.tenant, c.actor, p.created.id, { ...p.finalize, operationKey }, "no-qa"),
      ).rejects.toMatchObject({ status: 403 });
    await f.db.delete(schema.member).where(eq(schema.member.id, c.member));
    await expect(store.createDraft(c.tenant, c.actor, p.create, "no-access")).rejects.toMatchObject(
      { status: 403 },
    );
    for (const operationKey of [p.save.operationKey, randomUUID()])
      await expect(
        store.saveDraft(c.tenant, c.actor, p.created.id, { ...p.save, operationKey }, "no-access"),
      ).rejects.toMatchObject({ status: 403 });
  });
  it("returns no foreign lifecycle data and does not reuse another tenant's operation key", async () => {
    const p = await prepare();
    await cancel(p.created.id, 1, 2);
    const other = await seedCompleteReceiving(f.db);
    for (const id of [p.created.id, randomUUID()]) {
      await expect(
        store.saveDraft(other.tenant, other.actor, id, p.save, "foreign-save"),
      ).rejects.toMatchObject({ status: 404, response: { code: "receiving_draft_not_found" } });
      await expect(
        store.finalize(other.tenant, other.actor, id, p.finalize, "foreign-finalize"),
      ).rejects.toMatchObject({ status: 404, response: { code: "receiving_draft_not_found" } });
    }
  });
  it("keeps corrupt terminal storage unavailable instead of reporting a valid lifecycle conflict", async () => {
    const t = await target("void original receipt");
    const connection = await f.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL session_replication_role='replica'");
      await connection.query(
        "UPDATE traceability_events SET finalization_snapshot='{}' WHERE tenant_id=$1 AND id=$2",
        [c.tenant, t.id],
      );
      await connection.query("COMMIT");
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
    const before = await state();
    await expect(
      store.saveDraft(
        c.tenant,
        c.actor,
        t.id,
        { ...t.p.save, operationKey: randomUUID() },
        "corrupt-save",
      ),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      store.finalize(
        c.tenant,
        c.actor,
        t.id,
        { ...t.p.finalize, operationKey: randomUUID() },
        "corrupt-finalize",
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(await state()).toEqual(before);
    // A historical acknowledgement still has its own pinned receipt schema.
    expect(await store.saveDraft(c.tenant, c.actor, t.id, t.p.save, "valid-replay")).toEqual(
      t.p.saved,
    );
  });
});
