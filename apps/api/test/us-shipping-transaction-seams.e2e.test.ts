import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsReferenceDocumentStore } from "../src/modules/traceability/documents/us-reference-document-store";
import { readCurrentShippingBalance } from "../src/modules/traceability/shipping/us-shipping-balance";
import { finalizeShippingInTransaction } from "../src/modules/traceability/shipping/us-shipping-finalization";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import type { UsMasterDataTransaction } from "../src/modules/traceability/master-data/us-master-data-support";
import { seedReceivingTenant } from "./support/us-receiving-fixture";
import {
  createUsShippingTransactionFixture,
  seedShippingOrigin,
  withShippingFailure,
  type ShippingFailureBoundary,
  type ShippingTransactionFixture,
} from "./support/us-shipping-transaction-fixture";

const base = process.env.US_TEST_DATABASE_URL;

describe.skipIf(!base)("Shipping native transactions on owned PostgreSQL", () => {
  let f: ShippingTransactionFixture;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    f = await createUsShippingTransactionFixture(base);
  }, 60000);
  afterAll(async () => f?.close());

  const transaction = <T>(run: (tx: UsMasterDataTransaction) => Promise<T>) =>
    f.db.transaction(run, { isolationLevel: "repeatable read" });
  type Origin = Awaited<ReturnType<typeof seedShippingOrigin>>;
  const digest = (command: string, input: unknown, eventId?: string) =>
    createHash("sha256")
      .update(
        JSON.stringify({ commandVersion: 1, command, ...(eventId ? { eventId } : {}), input }),
      )
      .digest("hex");

  async function createReady(c: Origin, quantity = "20", unitOfMeasure = "case") {
    const create = {
      operationKey: randomUUID(),
      draft: { ...c.shippingDraft, items: [{ lotId: c.lot, quantity, unitOfMeasure }] },
    };
    const saved = await c.store.createDraft(c.tenant, c.actor, create, "public-draft");
    const ready = await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    return {
      create,
      saved,
      ready,
      command: {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
    };
  }

  async function compose(tx: UsMasterDataTransaction, c: Origin, quantity: string) {
    const document = await new UsReferenceDocumentStore(f.db).createDocumentInTransaction(
      tx,
      c.tenant,
      c.actor,
      {
        type: "invoice",
        typeOtherLabel: null,
        number: randomUUID(),
        partyId: c.party,
        issuedOn: "2026-09-27",
        notes: null,
      },
      "composed-document",
    );
    const create = {
      operationKey: randomUUID(),
      draft: {
        ...c.shippingDraft,
        items: [{ lotId: c.lot, quantity, unitOfMeasure: "case" }],
        documentIds: [document.id],
      },
    };
    const saved = await c.store.createDraftInTransaction(
      tx,
      c.tenant,
      c.actor,
      create,
      "composed-create",
    );
    expect(await c.store.getRecordInTransaction(tx, c.tenant, c.actor, saved.id)).toEqual(saved);
    const ready = await c.store.checkReadinessInTransaction(tx, c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(ready.state).toBe("complete");
    const command = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      expectedInputDigest: ready.inputDigest,
    };
    const result = await c.store.finalizeInTransaction(
      tx,
      c.tenant,
      c.actor,
      saved.id,
      command,
      "composed-finalize",
    );
    expect(await c.store.getRecordInTransaction(tx, c.tenant, c.actor, saved.id)).toEqual(result);
    return { document, create, saved, command, result };
  }

  async function unchangedAfterFailure(
    run: (tx: UsMasterDataTransaction) => Promise<unknown>,
    status: number,
    code: string,
  ) {
    const before = await f.snapshot();
    await expect(transaction(run)).rejects.toMatchObject({ status, response: { code } });
    expect(await f.snapshot()).toEqual(before);
  }

  function driverError(error: unknown): object | undefined {
    if (!error || typeof error !== "object") return undefined;
    if ("code" in error) return error;
    return "cause" in error ? driverError(error.cause) : undefined;
  }

  // Catches wrappers committing independently, missing native boundaries,
  // omitted stock effects and inconsistent reads of caller-owned fresh writes.
  it("composes document, draft, readiness, finalize and read in one repeatable-read transaction", async () => {
    const c = await seedShippingOrigin(f);
    expect(c.store, "Missing native Shipping create boundary").toHaveProperty(
      "createDraftInTransaction",
      expect.any(Function),
    );
    await f.db.transaction(
      async (tx) => {
        const document = await new UsReferenceDocumentStore(f.db).createDocumentInTransaction(
          tx,
          c.tenant,
          c.actor,
          {
            type: "invoice",
            typeOtherLabel: null,
            number: randomUUID(),
            partyId: c.party,
            issuedOn: "2026-09-27",
            notes: "Native Shipping composition",
          },
          "native-document",
        );
        const draft = await c.store.createDraftInTransaction(
          tx,
          c.tenant,
          c.actor,
          {
            operationKey: randomUUID(),
            draft: { ...c.shippingDraft, documentIds: [document.id] },
          },
          "native-create",
        );
        const ready = await c.store.checkReadinessInTransaction(tx, c.tenant, c.actor, draft.id, {
          expectedDraftVersion: draft.draftVersion,
        });
        expect(ready.state).toBe("complete");
        const result = await c.store.finalizeInTransaction(
          tx,
          c.tenant,
          c.actor,
          draft.id,
          {
            operationKey: randomUUID(),
            expectedDraftVersion: draft.draftVersion,
            expectedInputDigest: ready.inputDigest,
          },
          "native-finalize",
        );
        expect(result.snapshot.items[0]?.quantity).toBe("20");
        expect(result.snapshot.documents[0]?.id).toBe(document.id);
        expect(await c.store.getRecordInTransaction(tx, c.tenant, c.actor, draft.id)).toEqual(
          result,
        );
        expect(await readCurrentShippingBalance(tx, c.tenant, c.lot)).toMatchObject({
          state: "known",
          supply: "100",
          used: "20",
          remaining: "80",
        });
      },
      { isolationLevel: "repeatable read" },
    );
    expect(await c.store.getLotShippingBalance(c.tenant, c.actor, c.lot, {})).toMatchObject({
      balance: { state: "known", supply: "100", used: "20", remaining: "80" },
    });
  });

  it.each(["20", "100"])(
    "rolls back same-transaction document and all finalized %s-case effects after caller abort",
    async (quantity) => {
      const c = await seedShippingOrigin(f);
      const before = await f.snapshot();
      const sentinel = new Error("caller_abort_after_actual_shipping_finalization");
      await expect(
        transaction(async (tx) => {
          const lotBefore = await new UsLotStore(f.db).getLotInTransaction(
            tx,
            c.tenant,
            c.actor,
            c.lot,
          );
          const { result } = await compose(tx, c, quantity);
          expect(result.snapshot.items[0]?.quantity).toBe(quantity);
          expect(await readCurrentShippingBalance(tx, c.tenant, c.lot)).toEqual({
            state: "known",
            unitOfMeasure: "case",
            supply: "100",
            used: quantity,
            remaining: quantity === "100" ? "0" : "80",
          });
          const [lot] = await tx
            .select()
            .from(schema.traceabilityLots)
            .where(eq(schema.traceabilityLots.id, c.lot));
          expect(lot?.status).toBe(quantity === "100" ? "shipped" : "active");
          const effects = await tx
            .select()
            .from(schema.shippingLotStatusEffects)
            .where(eq(schema.shippingLotStatusEffects.lotId, c.lot));
          expect(effects).toHaveLength(quantity === "100" ? 1 : 0);
          if (quantity === "100") {
            const lotAfter = await new UsLotStore(f.db).getLotInTransaction(
              tx,
              c.tenant,
              c.actor,
              c.lot,
            );
            const statusAudits = await tx
              .select()
              .from(schema.tenantAuditEvents)
              .where(
                and(
                  eq(schema.tenantAuditEvents.organizationId, c.tenant),
                  eq(schema.tenantAuditEvents.action, "traceability.lot.status_changed"),
                  eq(schema.tenantAuditEvents.requestId, "composed-finalize"),
                ),
              );
            expect(statusAudits).toEqual([
              expect.objectContaining({
                organizationId: c.tenant,
                actorUserId: c.actor,
                action: "traceability.lot.status_changed",
                outcome: "success",
                targetType: "traceability_lot",
                targetId: c.lot,
                requestId: "composed-finalize",
                before: lotBefore,
                after: {
                  ...lotAfter,
                  reason: `Shipping ${result.eventNumber} finalized`,
                  eventId: result.id,
                  origin: "shipping",
                },
              }),
            ]);
          }
          throw sentinel;
        }),
      ).rejects.toBe(sentinel);
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it("read committed sees only its own fresh composition before rollback; general multi-read proof remains repeatable read", async () => {
    const c = await seedShippingOrigin(f);
    const before = await f.snapshot();
    const sentinel = new Error("own_fresh_read_committed_abort");
    await expect(
      f.db.transaction(
        async (tx) => {
          const { result } = await compose(tx, c, "20");
          expect(result.snapshot.items[0]?.quantity).toBe("20");
          throw sentinel;
        },
        { isolationLevel: "read committed" },
      ),
    ).rejects.toBe(sentinel);
    expect(await f.snapshot()).toEqual(before);
  });

  it("commits exact creation/finalization receipts and audits including the 100-case shipped transition", async () => {
    const c = await seedShippingOrigin(f);
    const lotBefore = await new UsLotStore(f.db).getLot(c.tenant, c.actor, c.lot);
    const { create, saved, command, result, document } = await transaction((tx) =>
      compose(tx, c, "100"),
    );
    expect(saved.eventNumber).toMatch(/^SHP-\d{2}-0001$/);
    expect(saved.lifecycle).toMatchObject({
      rootId: saved.id,
      lifecycleVersion: 1,
      currentEventId: null,
      pendingDraftId: saved.id,
    });
    expect(result.lifecycle).toMatchObject({
      rootId: saved.id,
      lifecycleVersion: 2,
      currentEventId: saved.id,
      pendingDraftId: null,
    });
    expect(
      await f.db
        .select()
        .from(schema.shippingCounters)
        .where(eq(schema.shippingCounters.tenantId, c.tenant)),
    ).toEqual([expect.objectContaining({ tenantId: c.tenant, sequence: 1 })]);
    const lotAfter = await new UsLotStore(f.db).getLot(c.tenant, c.actor, c.lot);
    expect(lotAfter).toEqual({
      ...lotBefore,
      status: "shipped",
      revision: lotBefore.revision + 1,
      updatedBy: c.actor,
      updatedAt: expect.any(String),
    });
    expect(result.snapshot.items[0]).toMatchObject({
      lotId: c.lot,
      tlc: "00001",
      quantity: "100",
      unitOfMeasure: "case",
    });
    expect(result.snapshot.documents).toEqual([
      {
        id: document.id,
        type: "invoice",
        number: document.number,
        issuer: { id: c.party, name: "Synthetic supplier", legalName: null },
      },
    ]);
    const operations = await f.db
      .select()
      .from(schema.shippingOperations)
      .where(eq(schema.shippingOperations.eventId, saved.id));
    expect(
      operations.map(({ tenantId, eventId, command, operationKey, inputDigest, result }) => ({
        tenantId,
        eventId,
        command,
        operationKey,
        inputDigest,
        result,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          tenantId: c.tenant,
          eventId: saved.id,
          command: "shipping.create",
          operationKey: create.operationKey,
          inputDigest: digest("shipping.create", create),
          result: saved,
        },
        {
          tenantId: c.tenant,
          eventId: saved.id,
          command: "shipping.finalize",
          operationKey: command.operationKey,
          inputDigest: digest("shipping.finalize", command, saved.id),
          result,
        },
      ]),
    );
    expect(operations).toHaveLength(2);
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.requestId, "composed-finalize"),
        ),
      );
    expect(
      audits.map(
        ({
          organizationId,
          actorUserId,
          action,
          outcome,
          targetType,
          targetId,
          requestId,
          before,
          after,
        }) => ({
          organizationId,
          actorUserId,
          action,
          outcome,
          targetType,
          targetId,
          requestId,
          before,
          after,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          organizationId: c.tenant,
          actorUserId: c.actor,
          action: "traceability.shipping.finalized",
          outcome: "success",
          targetType: "traceability_event",
          targetId: saved.id,
          requestId: "composed-finalize",
          before: saved,
          after: { ...result, lotIds: [c.lot], statusEffects: [c.lot] },
        },
        {
          organizationId: c.tenant,
          actorUserId: c.actor,
          action: "traceability.lot.status_changed",
          outcome: "success",
          targetType: "traceability_lot",
          targetId: c.lot,
          requestId: "composed-finalize",
          before: lotBefore,
          after: {
            ...lotAfter,
            reason: `Shipping ${saved.eventNumber} finalized`,
            eventId: saved.id,
            origin: "shipping",
          },
        },
      ]),
    );
    expect(audits).toHaveLength(2);
    const [createAudit] = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.targetId, saved.id),
          eq(schema.tenantAuditEvents.action, "traceability.shipping.draft_created"),
        ),
      );
    expect(createAudit).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.shipping.draft_created",
      outcome: "success",
      targetType: "traceability_event",
      targetId: saved.id,
      requestId: "composed-create",
      before: null,
      after: saved,
    });
    const [lot] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.id, c.lot));
    expect(lot?.currentDependencyVersion).toBe(2);
    const effects = await f.db
      .select()
      .from(schema.shippingLotStatusEffects)
      .where(eq(schema.shippingLotStatusEffects.lotId, c.lot));
    expect(effects).toEqual([
      expect.objectContaining({
        tenantId: c.tenant,
        lotId: c.lot,
        eventId: saved.id,
        priorStatus: "active",
        newStatus: "shipped",
        compensatedAt: null,
        compensationReason: null,
      }),
    ]);
    const beforeReplay = await f.snapshot();
    const nativeCreate = await transaction((tx) =>
      c.store.createDraftInTransaction(tx, c.tenant, c.actor, create, "native-create-replay"),
    );
    const publicCreate = await c.store.createDraft(
      c.tenant,
      c.actor,
      create,
      "public-create-replay",
    );
    const nativeFinal = await transaction((tx) =>
      finalizeShippingInTransaction(tx, c.tenant, c.actor, saved.id, command, "export-replay"),
    );
    const publicFinal = await c.store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      command,
      "public-final-replay",
    );
    expect(JSON.stringify(nativeCreate)).toBe(JSON.stringify(saved));
    expect(JSON.stringify(publicCreate)).toBe(JSON.stringify(saved));
    expect(JSON.stringify(nativeFinal)).toBe(JSON.stringify(result));
    expect(JSON.stringify(publicFinal)).toBe(JSON.stringify(result));
    expect(await f.snapshot()).toEqual(beforeReplay);
  });

  it.each([
    { quantity: "101", uom: "case", issue: "over_shipment", path: "items[0].quantity" },
    { quantity: "1", uom: "kg", issue: "uom_mismatch", path: "items[0].unitOfMeasure" },
  ])(
    "blocks $issue with no partial finalization writes",
    async ({ quantity, uom, issue, path }) => {
      const c = await seedShippingOrigin(f);
      const { saved, ready, command } = await createReady(c, quantity, uom);
      expect(ready.state).toBe("incomplete");
      expect(ready.issues).toContainEqual(expect.objectContaining({ code: issue, path }));
      await unchangedAfterFailure(
        (tx) => c.store.finalizeInTransaction(tx, c.tenant, c.actor, saved.id, command, "blocked"),
        409,
        "event_incomplete",
      );
    },
  );

  const boundaries: ShippingFailureBoundary[] = [
    "counter",
    "draft_audit",
    "create_operation",
    "item_snapshot",
    "status_effect",
    "finalize_audit",
    "finalize_operation",
  ];
  it.each(
    boundaries.flatMap((boundary) =>
      (["40001", "40P01"] as const).map((code) => ({ boundary, code })),
    ),
  )(
    "preserves injected $code at actual $boundary, one attempt, original error and rollback, then explicit fresh caller retry",
    async ({ boundary, code }) => {
      const c = await seedShippingOrigin(f);
      const before = await f.snapshot();
      await withShippingFailure(f, c.tenant, boundary, code, async (attempts) => {
        let callbacks = 0;
        let original: unknown;
        let originalDriver: object | undefined;
        const error: unknown = await transaction(async (tx) => {
          callbacks++;
          try {
            await compose(tx, c, "100");
          } catch (failure) {
            original = failure;
            originalDriver = driverError(failure);
            throw failure;
          }
        }).catch((failure: unknown) => failure);
        expect(error).toBe(original);
        expect(driverError(error)).toBe(originalDriver);
        expect(originalDriver).toMatchObject({ code, message: "owned_shipping_injection" });
        expect(callbacks).toBe(1);
        expect(await attempts()).toBe(1);
        expect(await f.snapshot()).toEqual(before);
      });
      expect((await transaction((tx) => compose(tx, c, "100"))).result.status).toBe("finalized");
    },
  );

  it.each(["40001", "40P01"] as const)(
    "public wrapper retains three attempts/exhaustion and successful retry for injected %s",
    async (code) => {
      const c = await seedShippingOrigin(f);
      const { saved, command } = await createReady(c, "100");
      const before = await f.snapshot();
      await withShippingFailure(f, c.tenant, "finalize_operation", code, async (attempts) => {
        await expect(
          c.store.finalize(c.tenant, c.actor, saved.id, command, "public-exhaustion"),
        ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
        expect(await attempts()).toBe(3);
        expect(await f.snapshot()).toEqual(before);
      });
      await withShippingFailure(
        f,
        c.tenant,
        "finalize_operation",
        code,
        async (attempts) => {
          expect(
            (await c.store.finalize(c.tenant, c.actor, saved.id, command, "public-retry")).status,
          ).toBe("finalized");
          expect(await attempts()).toBe(3);
        },
        2,
      );
    },
  );

  it("disposes its exact child after a genuine setup SQL failure, preserving original driver identity", async () => {
    if (!base) throw new Error("Missing isolated US database");
    let databaseName: string | undefined;
    let original: unknown;
    const error: unknown = await createUsShippingTransactionFixture(base, async (child, name) => {
      databaseName = name;
      try {
        await child.pool.query("SELECT * FROM shipping_fixture_missing_setup_relation");
      } catch (failure) {
        original = failure;
        throw failure;
      }
    }).catch((failure: unknown) => failure);
    expect(error).toBe(original);
    expect(driverError(error)).toMatchObject({ code: "42P01" });
    expect(databaseName).toMatch(/^markiro_us_shipping_/);
    expect(
      (await f.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [databaseName])).rows,
    ).toEqual([]);
    expect(
      (await f.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=$1", [databaseName]))
        .rows,
    ).toEqual([]);
  });

  it("removes injected triggers after actual transaction rollback and early caller failure", async () => {
    const c = await seedShippingOrigin(f);
    const before = await f.snapshot();
    const sentinel = new Error("early_caller_failure_after_driver_rollback");
    await expect(
      withShippingFailure(f, c.tenant, "finalize_operation", "40001", async () => {
        await expect(transaction((tx) => compose(tx, c, "100"))).rejects.toMatchObject({
          cause: { code: "40001" },
        });
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
    expect(await f.snapshot()).toEqual(before);
    const residue = await f.pool.query(
      "SELECT tgname FROM pg_trigger WHERE tgname LIKE 'shipping_failure_%'",
    );
    expect(residue.rows).toEqual([]);
    expect((await transaction((tx) => compose(tx, c, "100"))).result.status).toBe("finalized");
  });

  it("reauthorizes all four native entries before malformed input and revoked create/finalize replay", async () => {
    const c = await seedShippingOrigin(f);
    const { create, saved, command } = await createReady(c);
    await transaction((tx) =>
      c.store.finalizeInTransaction(tx, c.tenant, c.actor, saved.id, command, "auth-baseline"),
    );
    await f.db
      .update(schema.member)
      .set({ role: "traceability_viewer" })
      .where(eq(schema.member.id, c.member));
    for (const input of [null, create]) {
      await unchangedAfterFailure(
        (tx) => c.store.createDraftInTransaction(tx, c.tenant, c.actor, input, "denied"),
        403,
        "insufficient_permission",
      );
      const before = await f.snapshot();
      await expect(
        c.store.createDraft(c.tenant, c.actor, input, "public-denied"),
      ).rejects.toMatchObject({ status: 403, response: { code: "insufficient_permission" } });
      expect(await f.snapshot()).toEqual(before);
    }
    for (const input of [null, command]) {
      await unchangedAfterFailure(
        (tx) =>
          c.store.finalizeInTransaction(
            tx,
            c.tenant,
            c.actor,
            input === null ? null : saved.id,
            input,
            "denied",
          ),
        403,
        "insufficient_permission",
      );
      const before = await f.snapshot();
      await expect(
        c.store.finalize(
          c.tenant,
          c.actor,
          input === null ? null : saved.id,
          input,
          "public-denied",
        ),
      ).rejects.toMatchObject({ status: 403, response: { code: "insufficient_permission" } });
      expect(await f.snapshot()).toEqual(before);
    }
    await f.db.delete(schema.member).where(eq(schema.member.id, c.member));
    for (const id of [null, saved.id]) {
      await unchangedAfterFailure(
        (tx) => c.store.getRecordInTransaction(tx, c.tenant, c.actor, id),
        403,
        "insufficient_permission",
      );
      await unchangedAfterFailure(
        (tx) => c.store.checkReadinessInTransaction(tx, c.tenant, c.actor, id, null),
        403,
        "insufficient_permission",
      );
      const before = await f.snapshot();
      await expect(c.store.getRecord(c.tenant, c.actor, id)).rejects.toMatchObject({
        status: 403,
        response: { code: "insufficient_permission" },
      });
      await expect(c.store.checkReadiness(c.tenant, c.actor, id, null)).rejects.toMatchObject({
        status: 403,
        response: { code: "insufficient_permission" },
      });
      expect(await f.snapshot()).toEqual(before);
    }
  });

  it("rejects foreign actors/events/Receiving targets and each foreign location/document/lot without writes", async () => {
    const c = await seedShippingOrigin(f);
    const { saved, command } = await createReady(c);
    const other = await seedReceivingTenant(f.db);
    for (const run of [
      (tx: UsMasterDataTransaction) =>
        c.store.createDraftInTransaction(tx, other.tenant, c.actor, null, "foreign"),
      (tx: UsMasterDataTransaction) =>
        c.store.getRecordInTransaction(tx, other.tenant, c.actor, null),
      (tx: UsMasterDataTransaction) =>
        c.store.checkReadinessInTransaction(tx, other.tenant, c.actor, null, null),
      (tx: UsMasterDataTransaction) =>
        c.store.finalizeInTransaction(tx, other.tenant, c.actor, null, null, "foreign"),
    ])
      await unchangedAfterFailure(run, 403, "insufficient_permission");
    for (const id of [saved.id, c.origin.id, randomUUID()]) {
      await unchangedAfterFailure(
        (tx) => c.store.getRecordInTransaction(tx, other.tenant, other.actor, id),
        404,
        "shipping_not_found",
      );
      await unchangedAfterFailure(
        (tx) =>
          c.store.checkReadinessInTransaction(tx, other.tenant, other.actor, id, {
            expectedDraftVersion: 1,
          }),
        404,
        "shipping_not_found",
      );
      await unchangedAfterFailure(
        (tx) =>
          c.store.finalizeInTransaction(
            tx,
            other.tenant,
            other.actor,
            id,
            command,
            "foreign-event",
          ),
        404,
        "shipping_not_found",
      );
    }
    await unchangedAfterFailure(
      (tx) => c.store.getRecordInTransaction(tx, c.tenant, c.actor, c.origin.id),
      404,
      "shipping_not_found",
    );
    for (const draft of [
      { ...c.shippingDraft, shipFromLocationId: other.location },
      { ...c.shippingDraft, recipientLocationId: other.location },
      { ...c.shippingDraft, documentIds: [other.document] },
      { ...c.shippingDraft, items: [{ lotId: other.lot, quantity: "20", unitOfMeasure: "case" }] },
    ])
      await unchangedAfterFailure(
        (tx) =>
          c.store.createDraftInTransaction(
            tx,
            c.tenant,
            c.actor,
            { operationKey: randomUUID(), draft },
            "foreign-reference",
          ),
        404,
        "shipping_reference_not_found",
      );
  });

  it("preserves native strict parsing, version/digest conflicts, operation intent and corrupt-receipt denial", async () => {
    const c = await seedShippingOrigin(f);
    const { create, saved, command } = await createReady(c);
    await unchangedAfterFailure(
      (tx) => c.store.createDraftInTransaction(tx, c.tenant, c.actor, null, "invalid"),
      400,
      "invalid_master_data",
    );
    await unchangedAfterFailure(
      (tx) => c.store.getRecordInTransaction(tx, c.tenant, c.actor, "malformed"),
      400,
      "invalid_master_data",
    );
    await unchangedAfterFailure(
      (tx) => c.store.finalizeInTransaction(tx, c.tenant, c.actor, "malformed", null, "invalid"),
      400,
      "invalid_master_data",
    );
    for (const query of [null, { expectedDraftVersion: 1, extra: true }])
      await unchangedAfterFailure(
        (tx) => c.store.checkReadinessInTransaction(tx, c.tenant, c.actor, saved.id, query),
        400,
        "invalid_master_data",
      );
    await unchangedAfterFailure(
      (tx) =>
        c.store.checkReadinessInTransaction(tx, c.tenant, c.actor, saved.id, {
          expectedDraftVersion: 2,
        }),
      409,
      "shipping_draft_conflict",
    );
    await unchangedAfterFailure(
      (tx) =>
        c.store.finalizeInTransaction(
          tx,
          c.tenant,
          c.actor,
          saved.id,
          { ...command, expectedDraftVersion: 2 },
          "stale",
        ),
      409,
      "shipping_draft_conflict",
    );
    await unchangedAfterFailure(
      (tx) =>
        c.store.finalizeInTransaction(
          tx,
          c.tenant,
          c.actor,
          saved.id,
          { ...command, expectedInputDigest: "0".repeat(64) },
          "stale",
        ),
      409,
      "shipping_readiness_changed",
    );
    await unchangedAfterFailure(
      (tx) =>
        c.store.createDraftInTransaction(
          tx,
          c.tenant,
          c.actor,
          { ...create, draft: { ...create.draft, notes: "Changed intent" } },
          "conflict",
        ),
      409,
      "shipping_operation_conflict",
    );
    const result = await transaction((tx) =>
      c.store.finalizeInTransaction(tx, c.tenant, c.actor, saved.id, command, "receipt"),
    );
    await unchangedAfterFailure(
      (tx) =>
        c.store.finalizeInTransaction(
          tx,
          c.tenant,
          c.actor,
          saved.id,
          { ...command, expectedDraftVersion: 2 },
          "conflict",
        ),
      409,
      "shipping_operation_conflict",
    );
    const forged = { ...command, operationKey: randomUUID() };
    await f.db.insert(schema.shippingOperations).values({
      tenantId: c.tenant,
      eventId: saved.id,
      command: "shipping.finalize",
      operationKey: forged.operationKey,
      inputDigest: digest("shipping.finalize", forged, saved.id),
      result: { ...result, id: randomUUID() },
    });
    await unchangedAfterFailure(
      (tx) => c.store.finalizeInTransaction(tx, c.tenant, c.actor, saved.id, forged, "corrupt"),
      503,
      "us_database_unavailable",
    );
  });

  it("replays original finalization bytes after public void without certifying current lot stock", async () => {
    const c = await seedShippingOrigin(f);
    const { saved, command } = await createReady(c, "100");
    const result = await transaction((tx) =>
      c.store.finalizeInTransaction(tx, c.tenant, c.actor, saved.id, command, "native-final"),
    );
    await c.store.void(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Synthetic lifecycle replay",
      },
      "public-void",
    );
    const before = await f.snapshot();
    expect(
      JSON.stringify(
        await transaction((tx) =>
          c.store.finalizeInTransaction(
            tx,
            c.tenant,
            c.actor,
            saved.id,
            command,
            "native-historical-replay",
          ),
        ),
      ),
    ).toBe(JSON.stringify(result));
    expect(
      JSON.stringify(
        await c.store.finalize(c.tenant, c.actor, saved.id, command, "public-historical-replay"),
      ),
    ).toBe(JSON.stringify(result));
    expect((await c.store.getRecord(c.tenant, c.actor, saved.id)).status).toBe("void");
    expect(await c.store.getLotShippingBalance(c.tenant, c.actor, c.lot, {})).toMatchObject({
      balance: { state: "known", used: "0", remaining: "100" },
    });
    expect(await f.snapshot()).toEqual(before);
  });
});
