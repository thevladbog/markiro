import { randomUUID } from "node:crypto";
import { receivingAmendmentDraftSchema } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving revision readiness snapshot consistency", () => {
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
  async function readyOriginal(draft = c.draft) {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft },
      "create",
    );
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    return {
      id: saved.id,
      command: {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
    };
  }
  async function start() {
    const original = await readyOriginal();
    await store.finalize(c.tenant, c.actor, original.id, original.command, "finalize");
    const started = await store.amend(
      c.tenant,
      c.actor,
      original.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Correct receipt",
      },
      "amend",
    );
    if (started.record.content.kind !== "draft") throw new Error("Expected draft");
    return {
      original,
      started,
      draft: receivingAmendmentDraftSchema.parse(started.record.content.draft),
    };
  }
  const check = (id: string, version = 1) =>
    store.checkRevisionReadiness(c.tenant, c.actor, id, { expectedDraftVersion: version });
  function afterSnapshot(write: () => Promise<unknown>) {
    const transaction = f.db.transaction.bind(f.db);
    // Timing hook only: real PostgreSQL statements and actual isolation options.
    return vi.spyOn(f.db, "transaction").mockImplementationOnce((run, options) =>
      transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM traceability_lots WHERE tenant_id=${c.tenant}`);
        await write();
        return run(tx);
      }, options),
    );
  }
  it("reads one saved draft/predecessor version during a concurrent full replacement", async () => {
    const { started, draft } = await start(),
      before = await check(started.eventId);
    draft.notes = "Corrected after snapshot";
    draft.items.reverse();
    const hook = afterSnapshot(() =>
      store.saveAmendment(
        c.tenant,
        c.actor,
        started.eventId,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 3,
          expectedDraftVersion: 1,
          draft,
        },
        "concurrent-save",
      ),
    );
    try {
      expect((await check(started.eventId)).inputDigest).toBe(before.inputDigest);
    } finally {
      hook.mockRestore();
    }
    const after = await check(started.eventId, 2);
    expect(after.inputDigest).not.toBe(before.inputDigest);
    expect(after.draftVersion).toBe(2);
  });
  it("keeps the former root state during cancellation, then refuses a fresh check", async () => {
    const { started } = await start(),
      before = await check(started.eventId);
    const hook = afterSnapshot(() =>
      store.void(
        c.tenant,
        c.actor,
        started.eventId,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 3,
          expectedDraftVersion: 1,
          reason: "Cancel correction",
        },
        "concurrent-void",
      ),
    );
    try {
      const during = await check(started.eventId);
      expect(during.inputDigest).toBe(before.inputDigest);
      expect(during.expectedLifecycleVersion).toBe(3);
    } finally {
      hook.mockRestore();
    }
    await expect(check(started.eventId)).rejects.toMatchObject({
      status: 409,
      response: { code: "receiving_lifecycle_conflict", lifecycleVersion: 4 },
    });
  });
  it("keeps lot tokens and support counts together during an independent receipt finalization", async () => {
    const { started } = await start();
    const second = await readyOriginal({
      ...c.draft,
      items: c.draft.items.filter((i) => i.lotId === c.lot),
    });
    const before = await check(started.eventId);
    const hook = afterSnapshot(() =>
      store.finalize(c.tenant, c.actor, second.id, second.command, "concurrent-finalize"),
    );
    try {
      expect((await check(started.eventId)).inputDigest).toBe(before.inputDigest);
    } finally {
      hook.mockRestore();
    }
    const after = await check(started.eventId);
    expect(after.inputDigest).not.toBe(before.inputDigest);
    expect(after.draftVersion).toBe(before.draftVersion);
    expect(after.expectedLifecycleVersion).toBe(before.expectedLifecycleVersion);
  });
  it("leaves roots, revisions, lots and reference rows available to writers throughout the read", async () => {
    const { started } = await start();
    const transaction = f.db.transaction.bind(f.db);
    const hook = vi.spyOn(f.db, "transaction").mockImplementationOnce((run, options) =>
      transaction(async (tx) => {
        const result = await run(tx);
        const writer = await f.pool.connect();
        try {
          await writer.query("BEGIN");
          for (const table of [
            "receiving_event_roots",
            "traceability_events",
            "traceability_lots",
            "products",
            "product_traceability_profiles",
            "traceability_parties",
            "traceability_locations",
            "reference_documents",
          ])
            await writer.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 FOR UPDATE NOWAIT`, [
              c.tenant,
            ]);
        } finally {
          await writer.query("ROLLBACK");
          writer.release();
        }
        return result;
      }, options),
    );
    try {
      expect((await check(started.eventId)).state).toBe("complete");
    } finally {
      hook.mockRestore();
    }
  });
});
