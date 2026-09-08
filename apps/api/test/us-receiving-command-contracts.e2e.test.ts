import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import {
  receivingAmendmentDraftSchema,
  receivingCreateResultSchema,
  receivingSaveResultSchema,
  receivingFinalizeResultSchema,
  receivingLifecycleErrorSchema,
  receivingOperationReceiptV2Schema,
  saveReceivingCommandSchema,
  finalizeReceivingCommandSchema,
} from "@markiro/platform-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { zodApiSchema } from "../src/lib/openapi";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

it("can document the bridge contracts without activating lifecycle routes", () => {
  for (const contract of [
    receivingCreateResultSchema,
    receivingSaveResultSchema,
    receivingFinalizeResultSchema,
    saveReceivingCommandSchema,
    finalizeReceivingCommandSchema,
  ])
    expect(zodApiSchema(contract)).toEqual(expect.objectContaining({ anyOf: expect.any(Array) }));
  expect(zodApiSchema(receivingLifecycleErrorSchema)).toEqual(
    expect.objectContaining({ oneOf: expect.any(Array) }),
  );
});

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving shared command contracts against real store results", () => {
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

  async function conflict(promise: Promise<unknown>, expected: unknown) {
    const error: unknown = await promise.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw new Error("Expected an actual conflict");
    expect(error.getStatus()).toBe(409);
    expect(receivingLifecycleErrorSchema.parse(error.getResponse())).toEqual(expected);
  }
  const create = () =>
    store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: c.draft,
      },
      "create",
    );

  async function finalized() {
    const created = await create();
    expect(receivingCreateResultSchema.parse(created)).toEqual(created);
    const ready = await store.checkReadiness(c.tenant, c.actor, created.id, {
      expectedDraftVersion: 1,
    });
    const result = await store.finalize(
      c.tenant,
      c.actor,
      created.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "finalize",
    );
    expect(receivingFinalizeResultSchema.parse(result)).toEqual(result);
    return result;
  }

  it("keeps original create/save/finalize acknowledgements compatible and conflicts structured", async () => {
    const created = await create();
    expect(receivingCreateResultSchema.parse(created)).toEqual(created);
    const input = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: { ...c.draft, notes: "Corrected note" },
    };
    const saved = await store.saveDraft(c.tenant, c.actor, created.id, input, "save");
    expect(receivingSaveResultSchema.parse(saved)).toEqual(saved);
    await conflict(
      store.saveDraft(
        c.tenant,
        c.actor,
        created.id,
        { ...input, operationKey: randomUUID() },
        "stale",
      ),
      { code: "receiving_draft_conflict" },
    );
    await conflict(
      store.saveDraft(c.tenant, c.actor, created.id, { ...input, draft: c.draft }, "rebound"),
      { code: "receiving_operation_conflict" },
    );
    const ready = await store.checkReadiness(c.tenant, c.actor, created.id, {
      expectedDraftVersion: 2,
    });
    await conflict(
      store.finalize(
        c.tenant,
        c.actor,
        created.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 2,
          expectedInputDigest: "0".repeat(64),
        },
        "stale-check",
      ),
      { code: "receiving_readiness_changed" },
    );
    const result = await store.finalize(
      c.tenant,
      c.actor,
      created.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 2,
        expectedInputDigest: ready.inputDigest,
      },
      "finalize",
    );
    expect(receivingFinalizeResultSchema.parse(result)).toEqual(result);
    await conflict(
      store.saveDraft(
        c.tenant,
        c.actor,
        created.id,
        { ...input, operationKey: randomUUID(), expectedDraftVersion: 2 },
        "terminal",
      ),
      { code: "receiving_already_finalized" },
    );
  });

  it("retains exact pending/root and ordered identity details from amendment failures", async () => {
    const original = await finalized();
    const amendInput = {
      commandVersion: 2,
      operationKey: randomUUID(),
      expectedLifecycleVersion: 2,
      reason: "Correct quantity",
    };
    const started = await store.amend(c.tenant, c.actor, original.id, amendInput, "amend");
    expect(receivingOperationReceiptV2Schema.parse(started)).toEqual(started);
    await conflict(
      store.amend(
        c.tenant,
        c.actor,
        original.id,
        { ...amendInput, operationKey: randomUUID(), expectedLifecycleVersion: 3 },
        "pending",
      ),
      {
        code: "receiving_pending_amendment",
        pendingDraftId: started.eventId,
      },
    );
    await conflict(
      store.amend(
        c.tenant,
        c.actor,
        original.id,
        { ...amendInput, operationKey: randomUUID() },
        "stale-root",
      ),
      {
        code: "receiving_lifecycle_conflict",
        rootId: original.id,
        lifecycleVersion: 3,
        currentEventId: original.id,
        pendingDraftId: started.eventId,
      },
    );
    if (started.record.content.kind !== "draft") throw new Error("Expected amendment draft");
    const draft = receivingAmendmentDraftSchema.parse(started.record.content.draft);
    const item = draft.items[0];
    if (!item) throw new Error("Missing seeded line");
    item.lotId = null;
    item.productId = null;
    item.tlc = null;
    await conflict(
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
        "identity",
      ),
      {
        code: "lot_identity_locked",
        lines: [{ lineNo: 1, fields: ["lotId", "productId", "tlc"] }],
      },
    );
  });

  it("accepts actual amendment save/finalize receipts and preserves the historical save after void", async () => {
    const original = await finalized();
    const started = await store.amend(
      c.tenant,
      c.actor,
      original.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Correct note",
      },
      "amend",
    );
    if (started.record.content.kind !== "draft") throw new Error("Expected amendment draft");
    const draft = receivingAmendmentDraftSchema.parse(started.record.content.draft);
    draft.notes = "Corrected note";
    const input = {
      commandVersion: 2,
      operationKey: randomUUID(),
      expectedLifecycleVersion: 3,
      expectedDraftVersion: 1,
      draft,
    };
    const saved = await store.saveAmendment(c.tenant, c.actor, started.eventId, input, "save");
    expect(receivingSaveResultSchema.parse(saved)).toEqual(saved);
    const ready = await store.checkRevisionReadiness(c.tenant, c.actor, started.eventId, {
      expectedDraftVersion: 2,
    });
    const result = await store.finalizeRevision(
      c.tenant,
      c.actor,
      started.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 2,
        previousRevisionId: original.id,
        expectedInputDigest: ready.inputDigest,
        reviewedExemptLines: ready.exemptReviewRequiredLines,
      },
      "finalize",
    );
    expect(receivingFinalizeResultSchema.parse(result)).toEqual(result);
    const voided = await store.void(
      c.tenant,
      c.actor,
      started.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 4,
        expectedDraftVersion: null,
        reason: "Duplicate receipt",
      },
      "void",
    );
    expect(receivingOperationReceiptV2Schema.parse(voided)).toEqual(voided);
    const replay = await store.saveAmendment(c.tenant, c.actor, started.eventId, input, "replay");
    expect(receivingSaveResultSchema.parse(replay)).toEqual(saved);
    expect((await store.getLiveRecord(c.tenant, c.actor, started.eventId)).status).toBe("void");
  });
});
