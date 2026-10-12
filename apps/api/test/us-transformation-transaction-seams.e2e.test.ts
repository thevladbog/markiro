import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { UsReferenceDocumentStore } from "../src/modules/traceability/documents/us-reference-document-store";
import type { UsMasterDataTransaction } from "../src/modules/traceability/master-data/us-master-data-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";
import { seedReceivingTenant } from "./support/us-receiving-fixture";

const base = process.env.US_TEST_DATABASE_URL;

describe.skipIf(!base)("Transformation transaction seams on owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    f = await createUsDatasetJournalFixture(base);
    console.info(`Owned Transformation seam database: ${f.databaseName}`);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  const transaction = <T>(run: (tx: UsMasterDataTransaction) => Promise<T>) =>
    f.db.transaction(run, { isolationLevel: "repeatable read" });

  function driverError(error: unknown): { code?: unknown; constraint?: unknown } | undefined {
    if (!error || typeof error !== "object") return undefined;
    if ("code" in error) return error;
    return "cause" in error ? driverError(error.cause) : undefined;
  }

  async function withFailureTrigger(
    c: Awaited<ReturnType<typeof seedFinalizableTransformation>>,
    stage: "lot" | "edge" | "audit" | "operation",
    code: string,
    run: (attempts: () => Promise<number>) => Promise<void>,
    constraint?: string,
    failAttempts = 2147483647,
  ) {
    const name = "native_failure_" + randomUUID().replaceAll("-", "");
    const sequence = name + "_attempts";
    const table = {
      lot: "traceability_lots",
      edge: "lot_genealogy_edges",
      audit: "tenant_audit_events",
      operation: "transformation_operations",
    }[stage];
    const predicate =
      stage === "lot"
        ? `NEW.tenant_id='${c.tenant}' AND NEW.tlc='NEW-OUTPUT' AND NEW.source_location_id='${c.processor}'::uuid`
        : stage === "audit"
          ? `NEW.organization_id='${c.tenant}' AND NEW.target_id='${c.saved.id}' AND NEW.action='traceability.transformation.finalized'`
          : `NEW.tenant_id='${c.tenant}' AND NEW.event_id='${c.saved.id}'::uuid${stage === "operation" ? " AND NEW.command='transformation.finalize'" : ""}`;
    await f.pool.query(`CREATE SEQUENCE ${sequence}`);
    let failure: unknown;
    let cleanupFailure: unknown;
    try {
      await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF nextval('${sequence}') <= ${failAttempts} THEN
          RAISE EXCEPTION USING MESSAGE='owned_native_failure', ERRCODE='${code}'${constraint ? `, CONSTRAINT='${constraint}'` : ""};
        END IF; RETURN NEW; END $$`);
      await f.pool.query(
        `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${predicate}) EXECUTE FUNCTION ${name}()`,
      );
      await run(async () => {
        const result = await f.pool.query<{ n: string }>(
          `SELECT last_value::text AS n FROM ${sequence}`,
        );
        return Number(result.rows[0]?.n);
      });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await f.pool.query(
          `DROP TRIGGER IF EXISTS ${name} ON ${table}; DROP FUNCTION IF EXISTS ${name}(); DROP SEQUENCE ${sequence}`,
        );
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
        if (failure !== undefined)
          console.error("Owned trigger cleanup failed after original failure", name);
      }
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
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

  it("rolls back native finalization and all its effects after caller abort", async () => {
    const c = await seedFinalizableTransformation(f);
    const before = await f.snapshot();
    await expect(
      transaction(async (tx) => {
        const finalized = await c.store.finalizeInTransaction(
          tx,
          c.tenant,
          c.actor,
          c.saved.id,
          c.command,
          "native-finalize",
        );
        expect(finalized.status).toBe("finalized");
        expect(finalized.snapshot.outputs).toHaveLength(1);
        expect(finalized.snapshot.inputs).toHaveLength(2);
        throw new Error("caller_abort_after_finalize");
      }),
    ).rejects.toThrow("caller_abort_after_finalize");
    expect(await f.snapshot()).toEqual(before);
  });

  it("composes real documents, native draft, readiness, finalization and read before full caller rollback", async () => {
    const c = await seedFinalizableTransformation(f);
    const before = await f.snapshot();
    await expect(
      transaction(async (tx) => {
        const [processor] = await tx
          .select()
          .from(schema.traceabilityLocations)
          .where(
            and(
              eq(schema.traceabilityLocations.tenantId, c.tenant),
              eq(schema.traceabilityLocations.id, c.processor),
            ),
          );
        if (!processor) throw new Error("Missing same-tenant processor");
        const documents = [];
        for (const type of ["production_log", "other"] as const) {
          documents.push(
            await new UsReferenceDocumentStore(f.db).createDocumentInTransaction(
              tx,
              c.tenant,
              c.actor,
              {
                type,
                typeOtherLabel: type === "other" ? "Native processing sheet" : null,
                number: randomUUID(),
                partyId: processor.partyId,
                issuedOn: "2026-09-26",
                notes: "Native composition",
              },
              "native-document",
            ),
          );
        }
        const createCommand = {
          operationKey: randomUUID(),
          draft: {
            ...c.saved.draft,
            documentIds: documents.map((d) => d.id),
            outputs: [
              {
                productId: c.product,
                tlc: "COMPOSED-OUTPUT",
                quantity: "100",
                unitOfMeasure: "case",
              },
            ],
          },
        };
        const created = await c.store.createDraftInTransaction(
          tx,
          c.tenant,
          c.actor,
          createCommand,
          "native-composed-create",
        );
        const ready = await c.store.checkReadinessInTransaction(tx, c.tenant, c.actor, created.id, {
          expectedDraftVersion: 1,
        });
        expect(ready.state).toBe("complete");
        const command = {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: ready.inputDigest,
        };
        const finalized = await c.store.finalizeInTransaction(
          tx,
          c.tenant,
          c.actor,
          created.id,
          command,
          "native-composed-finalize",
        );
        expect(await c.store.getRecordInTransaction(tx, c.tenant, c.actor, created.id)).toEqual(
          finalized,
        );
        expect(finalized.snapshot.inputs).toEqual(
          c.origin.snapshot.items.map((line, index) => ({
            kind: "ftl_lot",
            lineNo: index + 1,
            lotId: line.lotId,
            product: {
              id: c.product,
              description: "Synthetic apples",
              coverage: {
                coverageStatus: "covered",
                coverageRationale: "Synthetic QA review",
                ftlCategory: "Fresh-cut fruits",
                ftlSourceUrl:
                  "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
                ftlSourceVersion: "Synthetic 2026",
                reviewedBy: c.actor,
                reviewedAt: "2026-09-25T13:14:15.123Z",
              },
            },
            tlc: line.tlc,
            source: {
              kind: "location",
              id: c.location,
              description:
                "Synthetic supplier, 1 Test Street, Chicago, IL, 60601, US, +1 555 010 0100",
            },
            quantity: "500",
            unitOfMeasure: "lb",
          })),
        );
        expect(finalized.snapshot.outputs).toHaveLength(1);
        const output = finalized.snapshot.outputs[0];
        if (!output) throw new Error("Missing composed output");
        expect(output).toMatchObject({
          lineNo: 1,
          tlc: "COMPOSED-OUTPUT",
          quantity: "100",
          unitOfMeasure: "case",
          source: { kind: "location", id: c.processor },
        });
        expect(finalized.snapshot.documents).toEqual(
          documents.map(({ id, type, number }) => ({
            id,
            type: type === "other" ? "Native processing sheet" : type,
            number,
          })),
        );
        const lots = await tx
          .select()
          .from(schema.traceabilityLots)
          .where(
            and(
              eq(schema.traceabilityLots.tenantId, c.tenant),
              eq(schema.traceabilityLots.assignmentBasis, "transformation"),
            ),
          );
        expect(lots).toHaveLength(1);
        expect(lots[0]).toMatchObject({
          id: output.lotId,
          tenantId: c.tenant,
          sourceLocationId: c.processor,
          sourceLockedAt: new Date(finalized.finalizedAt),
          assignmentBasis: "transformation",
        });
        const edges = await tx
          .select()
          .from(schema.lotGenealogyEdges)
          .where(eq(schema.lotGenealogyEdges.eventId, created.id));
        expect(edges).toHaveLength(2);
        expect(edges).toEqual(
          expect.arrayContaining(
            c.origin.snapshot.items.map(({ lotId }) => ({
              tenantId: c.tenant,
              eventId: created.id,
              eventType: "transformation",
              inputLotId: lotId,
              outputLotId: output.lotId,
            })),
          ),
        );
        const operations = await tx
          .select()
          .from(schema.transformationOperations)
          .where(eq(schema.transformationOperations.eventId, created.id));
        expect(operations).toHaveLength(2);
        for (const [verb, input, result] of [
          ["transformation.create", createCommand, created],
          ["transformation.finalize", command, finalized],
        ] as const) {
          expect(operations.find((op) => op.command === verb)).toMatchObject({
            tenantId: c.tenant,
            eventId: created.id,
            command: verb,
            operationKey: input.operationKey,
            result,
            inputDigest: createHash("sha256")
              .update(
                JSON.stringify({
                  commandVersion: 1,
                  command: verb,
                  ...(verb === "transformation.finalize" ? { eventId: created.id } : {}),
                  input,
                }),
              )
              .digest("hex"),
          });
        }
        const audits = await tx
          .select()
          .from(schema.tenantAuditEvents)
          .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
        for (const document of documents)
          expect(audits.filter((a) => a.targetId === document.id)).toEqual([
            expect.objectContaining({
              organizationId: c.tenant,
              actorUserId: c.actor,
              action: "traceability.reference_document.created",
              outcome: "success",
              targetType: "traceability_reference_document",
              targetId: document.id,
              requestId: "native-document",
              before: null,
              after: document,
            }),
          ]);
        expect(audits.filter((a) => a.targetId === created.id)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              organizationId: c.tenant,
              actorUserId: c.actor,
              action: "traceability.transformation.draft_created",
              outcome: "success",
              targetType: "traceability_event",
              targetId: created.id,
              requestId: "native-composed-create",
              before: null,
              after: created,
            }),
            expect.objectContaining({
              organizationId: c.tenant,
              actorUserId: c.actor,
              action: "traceability.transformation.finalized",
              outcome: "success",
              targetType: "traceability_event",
              targetId: created.id,
              requestId: "native-composed-finalize",
              before: created,
              after: finalized,
            }),
          ]),
        );
        expect(audits.filter((a) => a.targetId === created.id)).toHaveLength(2);
        expect(audits.filter((a) => a.targetId === output.lotId)).toEqual([
          expect.objectContaining({
            organizationId: c.tenant,
            actorUserId: c.actor,
            action: "traceability.lot.created",
            outcome: "success",
            targetType: "traceability_lot",
            targetId: output.lotId,
            requestId: "native-composed-finalize",
            before: null,
            after: {
              id: output.lotId,
              productId: c.product,
              tlc: "COMPOSED-OUTPUT",
              source: { kind: "location", locationId: c.processor },
              sourceLockedAt: finalized.finalizedAt,
              assignmentBasis: "transformation",
              status: "active",
              revision: 1,
              createdBy: c.actor,
              updatedBy: c.actor,
              createdAt: finalized.finalizedAt,
              updatedAt: finalized.finalizedAt,
              eventId: created.id,
            },
          }),
        ]);
        throw new Error("caller_abort_composed_finalization");
      }),
    ).rejects.toThrow("caller_abort_composed_finalization");
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(["lot", "edge", "audit", "operation"] as const)(
    "rolls back all prior writes on owned %s insert failure and allows a fresh external retry",
    async (stage) => {
      const c = await seedFinalizableTransformation(f);
      const before = await f.snapshot();
      await withFailureTrigger(c, stage, "P0001", async () => {
        const error = await transaction((tx) =>
          c.store.finalizeInTransaction(
            tx,
            c.tenant,
            c.actor,
            c.saved.id,
            c.command,
            "native-insert-failure",
          ),
        ).catch((error: unknown) => error);
        expect(driverError(error)).toMatchObject({ code: "P0001" });
        expect(await f.snapshot()).toEqual(before);
      });
      expect(await f.snapshot()).toEqual(before);
      expect(
        (
          await transaction((tx) =>
            c.store.finalizeInTransaction(
              tx,
              c.tenant,
              c.actor,
              c.saved.id,
              c.command,
              "native-fresh-retry",
            ),
          )
        ).status,
      ).toBe("finalized");
    },
  );

  it.each(["40001", "40P01"])(
    "propagates injected native driver %s after one attempt while public wrapper retries or exhausts",
    async (code) => {
      const c = await seedFinalizableTransformation(f);
      const before = await f.snapshot();
      let callbacks = 0;
      await withFailureTrigger(c, "lot", code, async (attempts) => {
        const error = await transaction((tx) => {
          callbacks++;
          return c.store.finalizeInTransaction(
            tx,
            c.tenant,
            c.actor,
            c.saved.id,
            c.command,
            "native-driver",
          );
        }).catch((error: unknown) => error);
        expect(driverError(error)).toMatchObject({ code });
        expect(callbacks).toBe(1);
        expect(await attempts()).toBe(1);
        expect(await f.snapshot()).toEqual(before);
      });
      await withFailureTrigger(c, "lot", code, async (attempts) => {
        await expect(
          c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "public-driver-exhaustion"),
        ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
        expect(await attempts()).toBe(3);
        expect(await f.snapshot()).toEqual(before);
      });
      await withFailureTrigger(
        c,
        "lot",
        code,
        async (attempts) => {
          expect(
            (
              await c.store.finalize(
                c.tenant,
                c.actor,
                c.saved.id,
                c.command,
                "public-driver-retry",
              )
            ).status,
          ).toBe("finalized");
          expect(await attempts()).toBe(3);
        },
        undefined,
        2,
      );
    },
  );

  it.each([
    "traceability_lots_location_tlc_uq",
    "traceability_lots_reference_tlc_uq",
    "traceability_lots_missing_source_tlc_uq",
    "unrelated_unique_constraint",
  ])("preserves public mapping only for named %s uniqueness failure", async (constraint) => {
    const c = await seedFinalizableTransformation(f);
    const before = await f.snapshot();
    await withFailureTrigger(
      c,
      "lot",
      "23505",
      async () => {
        const nativeError = await transaction((tx) =>
          c.store.finalizeInTransaction(
            tx,
            c.tenant,
            c.actor,
            c.saved.id,
            c.command,
            "native-unmapped-constraint",
          ),
        ).catch((error: unknown) => error);
        expect(driverError(nativeError)).toMatchObject({ code: "23505", constraint });
        expect(await f.snapshot()).toEqual(before);
        const error = await c.store
          .finalize(c.tenant, c.actor, c.saved.id, c.command, "public-mapper")
          .catch((error: unknown) => error);
        if (constraint === "unrelated_unique_constraint")
          expect(driverError(error)).toMatchObject({ code: "23505", constraint });
        else
          expect(error).toMatchObject({
            status: 409,
            response: { code: "transformation_lot_conflict" },
          });
        expect(await f.snapshot()).toEqual(before);
      },
      constraint,
    );
  });

  it("replays exact native finalization after public lifecycle change and rejects changed digest or forged receipt", async () => {
    const c = await seedFinalizableTransformation(f);
    const result = await transaction((tx) =>
      c.store.finalizeInTransaction(tx, c.tenant, c.actor, c.saved.id, c.command, "native-history"),
    );
    await c.store.void(
      c.tenant,
      c.actor,
      c.saved.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Historical evidence" },
      "public-history-void",
    );
    const before = await f.snapshot();
    expect(
      await transaction((tx) =>
        c.store.finalizeInTransaction(
          tx,
          c.tenant,
          c.actor,
          c.saved.id,
          c.command,
          "native-history-replay",
        ),
      ),
    ).toEqual(result);
    expect(
      await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "public-history-replay"),
    ).toEqual(result);
    expect(await f.snapshot()).toEqual(before);
    await unchangedAfterFailure(
      (tx) =>
        c.store.finalizeInTransaction(
          tx,
          c.tenant,
          c.actor,
          c.saved.id,
          { ...c.command, expectedInputDigest: "0".repeat(64) },
          "native-changed-digest",
        ),
      409,
      "transformation_operation_conflict",
    );
    const forged = { ...c.command, operationKey: randomUUID() };
    await f.db.insert(schema.transformationOperations).values({
      tenantId: c.tenant,
      eventId: c.saved.id,
      command: "transformation.finalize",
      operationKey: forged.operationKey,
      inputDigest: createHash("sha256")
        .update(
          JSON.stringify({
            commandVersion: 1,
            command: "transformation.finalize",
            eventId: c.saved.id,
            input: forged,
          }),
        )
        .digest("hex"),
      result: { ...result, id: randomUUID() },
    });
    await unchangedAfterFailure(
      (tx) =>
        c.store.finalizeInTransaction(
          tx,
          c.tenant,
          c.actor,
          c.saved.id,
          forged,
          "native-forged-result",
        ),
      503,
      "us_database_unavailable",
    );
  });

  it("rejects changed native readiness digest without writes", async () => {
    const c = await seedFinalizableTransformation(f);
    await unchangedAfterFailure(
      (tx) =>
        c.store.finalizeInTransaction(
          tx,
          c.tenant,
          c.actor,
          c.saved.id,
          { ...c.command, expectedInputDigest: "0".repeat(64) },
          "native-stale-digest",
        ),
      409,
      "transformation_readiness_changed",
    );
  });

  it("reauthorizes native finalization before malformed input and historical replay, and denies cross-tenant targets", async () => {
    const c = await seedFinalizableTransformation(f);
    await transaction((tx) =>
      c.store.finalizeInTransaction(
        tx,
        c.tenant,
        c.actor,
        c.saved.id,
        c.command,
        "native-denial-baseline",
      ),
    );
    const other = await seedReceivingTenant(f.db);
    await unchangedAfterFailure(
      (tx) =>
        c.store.finalizeInTransaction(
          tx,
          other.tenant,
          c.actor,
          null,
          null,
          "foreign-actor-finalize",
        ),
      403,
      "insufficient_permission",
    );
    await unchangedAfterFailure(
      (tx) =>
        c.store.finalizeInTransaction(
          tx,
          other.tenant,
          other.actor,
          c.saved.id,
          c.command,
          "foreign-target-finalize",
        ),
      404,
      "transformation_not_found",
    );
    await f.db
      .update(schema.member)
      .set({ role: "traceability_viewer" })
      .where(eq(schema.member.id, c.member));
    for (const input of [null, c.command]) {
      await unchangedAfterFailure(
        (tx) =>
          c.store.finalizeInTransaction(
            tx,
            c.tenant,
            c.actor,
            input === null ? null : c.saved.id,
            input,
            "native-revoked",
          ),
        403,
        "insufficient_permission",
      );
      const before = await f.snapshot();
      await expect(
        c.store.finalize(c.tenant, c.actor, c.saved.id, input, "public-revoked"),
      ).rejects.toMatchObject({ status: 403, response: { code: "insufficient_permission" } });
      expect(await f.snapshot()).toEqual(before);
    }
  });

  it("reads its native creation and readiness before caller abort rolls back every persisted row", async () => {
    const c = await seedFinalizableTransformation(f);
    const before = await f.snapshot();
    await expect(
      f.db.transaction(
        async (tx) => {
          const created = await c.store.createDraftInTransaction(
            tx,
            c.tenant,
            c.actor,
            { operationKey: randomUUID(), draft: c.saved.draft },
            "native-create",
          );
          expect(await c.store.getRecordInTransaction(tx, c.tenant, c.actor, created.id)).toEqual(
            created,
          );
          const ready = await c.store.checkReadinessInTransaction(
            tx,
            c.tenant,
            c.actor,
            created.id,
            { expectedDraftVersion: 1 },
          );
          expect(ready.state).toBe("complete");
          throw new Error("caller_abort");
        },
        { isolationLevel: "repeatable read" },
      ),
    ).rejects.toThrow("caller_abort");
    expect(await f.snapshot()).toEqual(before);
  });

  it("commits exact draft, counter, commandVersion1 receipt and native creation audit", async () => {
    const c = await seedFinalizableTransformation(f);
    const command = { operationKey: randomUUID(), draft: c.saved.draft };
    const before = await f.snapshot();
    const created = await transaction((tx) =>
      c.store.createDraftInTransaction(tx, c.tenant, c.actor, command, "native-commit"),
    );
    expect(created).toMatchObject({
      status: "draft",
      draftVersion: 1,
      revision: 1,
      timeZone: "America/Chicago",
      draft: c.saved.draft,
    });
    expect(created.id).not.toBe(c.saved.id);
    expect(created.eventNumber).toMatch(/^TRN-\d{2}-0002$/);
    expect(await c.store.getRecord(c.tenant, c.actor, created.id)).toEqual(created);
    const after = await f.snapshot();
    expect(after).not.toEqual(before);
    for (const table of ["traceability_lots", "lot_genealogy_edges", "receiving_operations"]) {
      expect(before[table]).toMatch(/^[a-f0-9]{64}$/);
      expect(after[table]).toBe(before[table]);
    }
    const operations = await f.db
      .select()
      .from(schema.transformationOperations)
      .where(eq(schema.transformationOperations.eventId, created.id));
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      tenantId: c.tenant,
      eventId: created.id,
      command: "transformation.create",
      operationKey: command.operationKey,
      inputDigest: createHash("sha256")
        .update(
          JSON.stringify({ commandVersion: 1, command: "transformation.create", input: command }),
        )
        .digest("hex"),
      result: created,
    });
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, created.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.transformation.draft_created",
      outcome: "success",
      targetType: "traceability_event",
      targetId: created.id,
      requestId: "native-commit",
      before: null,
      after: created,
    });
    const beforeReplay = await f.snapshot();
    expect(
      await transaction((tx) =>
        c.store.createDraftInTransaction(tx, c.tenant, c.actor, command, "native-replay"),
      ),
    ).toEqual(created);
    expect(await f.snapshot()).toEqual(beforeReplay);
    expect(await c.store.createDraft(c.tenant, c.actor, command, "public-replay")).toEqual(created);
    expect(await f.snapshot()).toEqual(beforeReplay);
  });

  it("replays original native creation after a public save without rewriting history", async () => {
    const c = await seedFinalizableTransformation(f);
    const command = { operationKey: randomUUID(), draft: c.saved.draft };
    const before = await f.snapshot();
    const created = await transaction((tx) =>
      c.store.createDraftInTransaction(tx, c.tenant, c.actor, command, "historical-create"),
    );
    expect(await f.snapshot()).not.toEqual(before);
    const current = await c.store.saveDraft(
      c.tenant,
      c.actor,
      created.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: { ...created.draft, notes: "Current edited notes" },
      },
      "public-save",
    );
    const beforeReplay = await f.snapshot();
    expect(
      await transaction(async (tx) => {
        expect(await c.store.getRecordInTransaction(tx, c.tenant, c.actor, created.id)).toEqual(
          current,
        );
        return c.store.createDraftInTransaction(
          tx,
          c.tenant,
          c.actor,
          command,
          "historical-replay",
        );
      }),
    ).toEqual(created);
    expect(await f.snapshot()).toEqual(beforeReplay);
  });

  it("rejects different content for the same creation key without writes", async () => {
    const c = await seedFinalizableTransformation(f);
    const command = { operationKey: randomUUID(), draft: c.saved.draft };
    const before = await f.snapshot();
    await transaction((tx) =>
      c.store.createDraftInTransaction(tx, c.tenant, c.actor, command, "conflict-baseline"),
    );
    expect(await f.snapshot()).not.toEqual(before);
    await unchangedAfterFailure(
      (tx) =>
        c.store.createDraftInTransaction(
          tx,
          c.tenant,
          c.actor,
          { ...command, draft: { ...command.draft, notes: "different" } },
          "conflict",
        ),
      409,
      "transformation_operation_conflict",
    );
  });

  it("fails closed on a corrupt saved creation response without repairing it", async () => {
    const c = await seedFinalizableTransformation(f);
    const command = { operationKey: randomUUID(), draft: c.saved.draft };
    const before = await f.snapshot();
    const created = await transaction((tx) =>
      c.store.createDraftInTransaction(tx, c.tenant, c.actor, command, "corrupt-baseline"),
    );
    expect(await f.snapshot()).not.toEqual(before);
    // Corrupt fixture evidence uses a separate key: committed receipts are immutable.
    const corruptCommand = { ...command, operationKey: randomUUID() };
    await f.db.insert(schema.transformationOperations).values({
      tenantId: c.tenant,
      eventId: created.id,
      command: "transformation.create",
      operationKey: corruptCommand.operationKey,
      inputDigest: createHash("sha256")
        .update(
          JSON.stringify({
            commandVersion: 1,
            command: "transformation.create",
            input: corruptCommand,
          }),
        )
        .digest("hex"),
      result: { ...created, id: randomUUID() },
    });
    await unchangedAfterFailure(
      (tx) =>
        c.store.createDraftInTransaction(tx, c.tenant, c.actor, corruptCommand, "corrupt-replay"),
      503,
      "us_database_unavailable",
    );
  });

  it("reloads revoked creation permission before malformed input and native or public replay", async () => {
    const c = await seedFinalizableTransformation(f);
    const command = { operationKey: randomUUID(), draft: c.saved.draft };
    const before = await f.snapshot();
    await transaction((tx) =>
      c.store.createDraftInTransaction(tx, c.tenant, c.actor, command, "revocation-baseline"),
    );
    expect(await f.snapshot()).not.toEqual(before);
    await f.db
      .update(schema.member)
      .set({ role: "traceability_viewer" })
      .where(eq(schema.member.id, c.member));
    for (const input of [null, command]) {
      await unchangedAfterFailure(
        (tx) => c.store.createDraftInTransaction(tx, c.tenant, c.actor, input, "denied"),
        403,
        "insufficient_permission",
      );
      const denied = await f.snapshot();
      await expect(
        c.store.createDraft(c.tenant, c.actor, input, "public-denied"),
      ).rejects.toMatchObject({ status: 403, response: { code: "insufficient_permission" } });
      expect(await f.snapshot()).toEqual(denied);
    }
  });

  it("reloads read permission before malformed identifiers and readiness query", async () => {
    const c = await seedFinalizableTransformation(f);
    await f.db.delete(schema.member).where(eq(schema.member.id, c.member));
    for (const id of [null, c.saved.id]) {
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
      const beforePublic = await f.snapshot();
      await expect(c.store.getRecord(c.tenant, c.actor, id)).rejects.toMatchObject({
        status: 403,
        response: { code: "insufficient_permission" },
      });
      await expect(c.store.checkReadiness(c.tenant, c.actor, id, null)).rejects.toMatchObject({
        status: 403,
        response: { code: "insufficient_permission" },
      });
      expect(await f.snapshot()).toEqual(beforePublic);
    }
  });

  it("preserves native UUID, strict readiness query and draft version validation", async () => {
    const c = await seedFinalizableTransformation(f);
    await unchangedAfterFailure(
      (tx) => c.store.getRecordInTransaction(tx, c.tenant, c.actor, "malformed"),
      400,
      "invalid_master_data",
    );
    for (const input of [null, { expectedDraftVersion: 1, extra: true }])
      await unchangedAfterFailure(
        (tx) => c.store.checkReadinessInTransaction(tx, c.tenant, c.actor, c.saved.id, input),
        400,
        "invalid_master_data",
      );
    await unchangedAfterFailure(
      (tx) =>
        c.store.checkReadinessInTransaction(tx, c.tenant, c.actor, c.saved.id, {
          expectedDraftVersion: 2,
        }),
      409,
      "transformation_draft_conflict",
    );
  });

  it("rejects foreign tenant actors, events, Receiving events and every foreign draft reference", async () => {
    const c = await seedFinalizableTransformation(f);
    const other = await seedReceivingTenant(f.db);
    await unchangedAfterFailure(
      (tx) => c.store.createDraftInTransaction(tx, other.tenant, c.actor, null, "foreign-actor"),
      403,
      "insufficient_permission",
    );
    await unchangedAfterFailure(
      (tx) => c.store.getRecordInTransaction(tx, other.tenant, c.actor, c.saved.id),
      403,
      "insufficient_permission",
    );
    await unchangedAfterFailure(
      (tx) => c.store.getRecordInTransaction(tx, c.tenant, c.actor, c.origin.id),
      404,
      "transformation_not_found",
    );
    for (const id of [c.saved.id, c.origin.id, randomUUID()]) {
      await unchangedAfterFailure(
        (tx) => c.store.getRecordInTransaction(tx, other.tenant, other.actor, id),
        404,
        "transformation_not_found",
      );
      await unchangedAfterFailure(
        (tx) =>
          c.store.checkReadinessInTransaction(tx, other.tenant, other.actor, id, {
            expectedDraftVersion: 1,
          }),
        404,
        "transformation_not_found",
      );
    }
    for (const draft of [
      { ...c.saved.draft, processorLocationId: other.location },
      { ...c.saved.draft, documentIds: [other.document] },
      {
        ...c.saved.draft,
        inputs: [{ kind: "ftl_lot", lotId: other.lot, quantity: "1", unitOfMeasure: "lb" }],
      },
      {
        ...c.saved.draft,
        outputs: [
          { productId: other.product, tlc: "FOREIGN", quantity: "1", unitOfMeasure: "case" },
        ],
      },
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
        "transformation_reference_not_found",
      );
  });
});
