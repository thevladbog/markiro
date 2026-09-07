import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { createStoredAmendment, voidStoredEvent } from "./support/us-receiving-lifecycle-storage";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving read snapshot consistency", () => {
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
  const create = () =>
    store.createDraft(c.tenant, c.actor, { operationKey: randomUUID(), draft: c.draft }, "create");
  async function finalize() {
    const saved = await create();
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    return store.finalize(
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
  }
  function afterSnapshot(write: () => Promise<unknown>) {
    const transaction = f.db.transaction.bind(f.db);
    // Scheduling hook only: the real transaction, passed isolation options and all
    // reads/writes execute on PostgreSQL. No query result is mocked or fabricated.
    return vi.spyOn(f.db, "transaction").mockImplementationOnce((run, options) =>
      transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM traceability_lots WHERE tenant_id=${c.tenant}`);
        await write();
        return run(tx);
      }, options),
    );
  }
  it("keeps basis count, token and page before a concurrent void, then observes its committed state", async () => {
    const original = await finalize();
    const before = await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {});
    const hook = afterSnapshot(() => voidStoredEvent(f, c.tenant, original.id));
    try {
      expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toEqual(before);
    } finally {
      hook.mockRestore();
    }
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      basisVersion: 3,
      state: "missing",
      supportCount: 0,
      items: [],
    });
  });
  it.each(["detail", "history"] as const)(
    "keeps %s and root pointers before a concurrent amendment",
    async (kind) => {
      const original = await finalize();
      const read = () =>
        kind === "detail"
          ? store.getLiveRecord(c.tenant, c.actor, original.id)
          : store.listRevisions(c.tenant, c.actor, original.id, {});
      const before = await read();
      let pending: string | undefined;
      const hook = afterSnapshot(async () => {
        pending = await createStoredAmendment(f, c.tenant, original.id);
      });
      try {
        expect(await read()).toEqual(before);
      } finally {
        hook.mockRestore();
      }
      expect(pending).toBeTypeOf("string");
      expect(await store.getLiveRecord(c.tenant, c.actor, original.id)).toMatchObject({
        status: "finalized",
        lifecycle: { lifecycleVersion: 3, pendingDraftId: pending },
      });
      expect(
        (await store.listRevisions(c.tenant, c.actor, original.id, {})).items.map(
          (item) => item.revision,
        ),
      ).toEqual([1, 2]);
    },
  );
  it("keeps draft metadata and children from one saved version during replacement", async () => {
    const saved = await create();
    const before = await store.getLiveRecord(c.tenant, c.actor, saved.id);
    const hook = afterSnapshot(() =>
      store.saveDraft(
        c.tenant,
        c.actor,
        saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          draft: { ...c.draft, notes: "New saved note", items: [] },
        },
        "save",
      ),
    );
    try {
      expect(await store.getLiveRecord(c.tenant, c.actor, saved.id)).toEqual(before);
    } finally {
      hook.mockRestore();
    }
    expect(await store.getLiveRecord(c.tenant, c.actor, saved.id)).toMatchObject({
      draftVersion: 2,
      content: { kind: "draft", draft: { notes: "New saved note", items: [] } },
    });
  });
  it.each([
    ["current", "amend"],
    ["all", "amend"],
    ["current", "finalize"],
    ["all", "finalize"],
    ["current", "void"],
    ["all", "void"],
  ] as const)("keeps the %s registry from one snapshot during %s", async (history, transition) => {
    const original = await finalize();
    const startAmendment = () =>
      store.amend(
        c.tenant,
        c.actor,
        original.id,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Correct receipt",
        },
        "registry-race-amend",
      );
    const pending = transition === "finalize" ? await startAmendment() : null;
    const ready =
      pending === null
        ? null
        : await store.checkRevisionReadiness(c.tenant, c.actor, pending.eventId, {
            expectedDraftVersion: 1,
          });
    const read = () => store.listLiveRecords(c.tenant, c.actor, { history });
    const before = await read();
    let successor: string | undefined;
    const hook = afterSnapshot(async () => {
      if (transition === "amend") successor = (await startAmendment()).eventId;
      else if (transition === "void")
        await store.void(
          c.tenant,
          c.actor,
          original.id,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            expectedDraftVersion: null,
            reason: "Duplicate receipt",
          },
          "registry-race-void",
        );
      else {
        if (pending === null || ready === null) throw new Error("Missing amendment fixture");
        await store.finalizeRevision(
          c.tenant,
          c.actor,
          pending.eventId,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            expectedLifecycleVersion: 3,
            previousRevisionId: original.id,
            expectedInputDigest: ready.inputDigest,
            reviewedExemptLines: [],
          },
          "registry-race-finalize",
        );
      }
    });
    try {
      expect(await read()).toEqual(before);
    } finally {
      hook.mockRestore();
    }
    const after = await read();
    if (transition === "amend") {
      expect(after.items.map((item) => item.id).sort()).toEqual([original.id, successor].sort());
      expect(
        after.items.every(
          (item) =>
            item.lifecycle.lifecycleVersion === 3 &&
            item.lifecycle.currentEventId === original.id &&
            item.lifecycle.pendingDraftId === successor,
        ),
      ).toBe(true);
    } else if (transition === "void") {
      expect(after.items).toMatchObject([
        {
          id: original.id,
          status: "void",
          lifecycle: {
            lifecycleVersion: 3,
            currentEventId: null,
            pendingDraftId: null,
          },
        },
      ]);
    } else {
      expect(after.items.map((item) => item.id).sort()).toEqual(
        (history === "all" ? [original.id, pending?.eventId] : [pending?.eventId]).sort(),
      );
      expect(
        after.items.every(
          (item) =>
            item.lifecycle.lifecycleVersion === 4 &&
            item.lifecycle.currentEventId === pending?.eventId &&
            item.lifecycle.pendingDraftId === null,
        ),
      ).toBe(true);
      expect(after.items.find((item) => item.id === pending?.eventId)?.status).toBe("finalized");
      if (history === "all")
        expect(after.items.find((item) => item.id === original.id)?.status).toBe("amended");
    }
  });
  it("keeps registry counts and draft metadata together during a saved replacement", async () => {
    const saved = await create();
    const before = await store.listLiveRecords(c.tenant, c.actor, {});
    const hook = afterSnapshot(() =>
      store.saveDraft(
        c.tenant,
        c.actor,
        saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          draft: { ...c.draft, dateReceived: "2026-09-08", items: [], documentIds: [] },
        },
        "registry-race-save",
      ),
    );
    try {
      expect(await store.listLiveRecords(c.tenant, c.actor, {})).toEqual(before);
    } finally {
      hook.mockRestore();
    }
    expect((await store.listLiveRecords(c.tenant, c.actor, {})).items).toMatchObject([
      { id: saved.id, draftVersion: 2, dateReceived: "2026-09-08", lineCount: 0, documentCount: 0 },
    ]);
  });
});
