import { canonicalExportDigest } from "@markiro/domain";
import { createDb, schema } from "@markiro/db";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { US_CAPABILITY } from "@markiro/domain";
import * as shippingVerification from "../src/modules/traceability/demo/us-dataset-shipping-verify";
import * as masterSupport from "../src/modules/traceability/master-data/us-master-data-support";
import { UsDatasetTraceReadinessStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { parseUsDatasetShippingInput } from "../src/modules/traceability/demo/us-dataset-shipping-contract";
import { lockUsDatasetTransformation } from "../src/modules/traceability/demo/us-dataset-transformation-locks";
import { verifyUsDatasetShippingOriginStatus } from "../src/modules/traceability/demo/us-dataset-shipping-origin-status";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-store";
import { parseUsDatasetReceivingResult } from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { parseUsDatasetTransformationResult } from "../src/modules/traceability/demo/us-dataset-transformation-contract";
import { parseUsDatasetReferenceResult } from "../src/modules/traceability/demo/us-dataset-reference-contract";
import type { UsDatasetShippingProjection } from "../src/modules/traceability/demo/us-dataset-shipping-projection";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { verifyUsDatasetCases } from "../src/modules/traceability/demo/us-dataset-cases-verify";
import { parseUsDatasetCasesResult } from "../src/modules/traceability/demo/us-dataset-cases-contract";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import { prepareDatasetShippingFixture } from "./support/us-dataset-shipping-fixture";
import { specialFixture, specialFault } from "./support/us-dataset-special-fixture";
import {
  outcome,
  waitBlocked,
  driverCode,
  barrier,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
type Pool = ReturnType<typeof createDb>["pool"];
type ObservedClient = NonNullable<Parameters<Parameters<Pool["connect"]>[0]>[1]>;
function observeStatements(pool: Pool) {
  const statements: string[] = [];
  const restores = new Map<ObservedClient, () => void>();
  const acquire = (client: ObservedClient) => {
    if (restores.has(client)) return;
    const original = client.query;
    client.query = new Proxy(original, {
      apply(target, receiver, args: unknown[]) {
        const first = args[0];
        statements.push(
          typeof first === "string"
            ? first
            : first &&
                typeof first === "object" &&
                "text" in first &&
                typeof first.text === "string"
              ? first.text
              : "",
        );
        return Reflect.apply(target, receiver, args);
      },
    });
    restores.set(client, () => {
      client.query = original;
    });
  };
  pool.on("acquire", acquire);
  return {
    statements,
    close() {
      pool.off("acquire", acquire);
      for (const restore of restores.values()) restore();
    },
  };
}
describe.skipIf(!base)("closed terminal reader native correctness", () => {
  describe("prerequisite and retention", () => {
    const h = specialFixture(base);
    let prepared: Awaited<ReturnType<typeof prepareDatasetShippingFixture>>;
    beforeEach(
      h.phase(async () => {
        prepared = await prepareDatasetShippingFixture(h.f, h.context, 0);
        await new UsDatasetShippingSeedStore(h.f.db).initialize(h.context, 0);
      }),
      30_000,
    );

    const replayCases = () => {
      const stage = prepared.cases;
      return datasetTransformationStores(h.f.db).journal.runAtomicStage(
        h.context,
        prepared.datasetId,
        stage.revision,
        stage.intent,
        {
          apply: async () => {
            throw new Error("Completed Cases must not apply");
          },
          verify: (tx, checked, intent, receipt) =>
            verifyUsDatasetCases(
              tx,
              checked,
              intent,
              receipt,
              "replay",
              datasetTransformationStores(h.f.db),
            ),
        },
      );
    };

    it(
      "reaches chain 0 immutable receipt and physical-default assertions on prepared native state",
      h.phase(async () => {
        const receipt = prepared.cases.receipt;
        if (!receipt) throw new Error("Missing prepared receipt");
        const result = parseUsDatasetCasesResult(receipt.result);
        expect(result.linked.created).toHaveLength(55);
        expect(result.linked.unchanged).toEqual([]);
        expect(result.support.shift).toMatchObject({
          status: "planned",
          mode: "aggregation",
          numberSeq: 1,
        });
        for (const link of result.linked.created)
          expect(link).toMatchObject({
            linkSource: "demo_seed",
            linkedBy: h.context.actorUserId,
            provenance: "synthetic_demo",
            originState: "current",
            ssccState: "consistent",
            unlinkedAt: null,
            unlinkedBy: null,
            unlinkReason: null,
          });
        const before = await h.f.snapshot();
        expect((await replayCases()).receipt).toEqual(receipt);
        expect(receipt.resultDigest).toBe(canonicalExportDigest(result));
        expect(await h.f.snapshot()).toEqual(before);
        expect(new Date(result.support.shift.createdAt).getTime()).toBeGreaterThanOrEqual(
          new Date(result.input.support.capturedAt).getTime(),
        );
        for (const table of [
          "box_items",
          "scan_events",
          "codes",
          "shift_number_counters",
          "sscc_counters",
        ]) {
          expect(
            (
              await h.f.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [
                h.context.tenantId,
              ])
            ).rows,
          ).toEqual([{ n: 0 }]);
        }
      }),
    );

    it(
      "reaches the exact allowed-field shift product-drift error without repair",
      h.phase(async () => {
        const result = parseUsDatasetCasesResult(prepared.cases.receipt?.result);
        const changed = await h.f.pool.query(
          "UPDATE shifts SET product_id=(SELECT id FROM products WHERE tenant_id=shifts.tenant_id AND id<>shifts.product_id LIMIT 1) WHERE tenant_id=$1 AND id=$2",
          [h.context.tenantId, result.input.support.shiftId],
        );
        expect(changed.rowCount).toBe(1);
        const before = await h.f.snapshot();
        await expect(replayCases()).rejects.toThrow("us_dataset_cases_mismatch");
        expect(await h.f.snapshot()).toEqual(before);
      }),
    );

    it(
      "dispatches one full protected output-lot point read while preserving replay and no-write evidence",
      h.phase(async () => {
        const before = await h.f.snapshot();
        type Client = NonNullable<
          Parameters<Parameters<ReturnType<typeof createDb>["pool"]["connect"]>[0]>[1]
        >;
        const restores = new Map<Client, () => void>();
        let fullOutputLotReads = 0;
        const acquire = (client: Client) => {
          if (restores.has(client)) return;
          const original = client.query;
          client.query = new Proxy(original, {
            apply(target, receiver, args: unknown[]) {
              const first = args[0];
              const text =
                typeof first === "string"
                  ? first
                  : first &&
                      typeof first === "object" &&
                      "text" in first &&
                      typeof first.text === "string"
                    ? first.text
                    : "";
              const values = Array.isArray(args[1]) ? args[1] : [];
              if (
                text.startsWith('select "id", "tenant_id", "product_id"') &&
                text.includes('from "traceability_lots"') &&
                values.includes(prepared.input.outputLotId)
              )
                fullOutputLotReads++;
              return Reflect.apply(target, receiver, args);
            },
          });
          restores.set(client, () => {
            client.query = original;
          });
        };
        h.f.pool.on("acquire", acquire);
        try {
          const projection = await new UsDatasetShippingSeedStore(h.f.db).verifyTerminalProjection(
            h.context,
            0,
          );
          expect(projection.shipping.input).toEqual(prepared.input);
          expect(projection.shipping.shipments).toHaveLength(2);
          expect(projection.shipping.outputLotAfter.id).toBe(prepared.input.outputLotId);
          expect(fullOutputLotReads).toBe(1);
        } finally {
          h.f.pool.off("acquire", acquire);
          for (const restore of restores.values()) restore();
        }
        expect(await h.f.snapshot()).toEqual(before);
      }),
    );

    it(
      "keeps LIMIT 1 authorization and complete original-owner cardinality distinct after a committed membership phantom",
      h.phase(async () => {
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        const observation = observeStatements(h.f.pool);
        let afterInsertion: Awaited<ReturnType<typeof h.f.snapshot>> | undefined;
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            const [tx, checked, , , dependencies] = args;
            await dependencies.authorize(
              tx,
              checked.tenantId,
              checked.actorUserId,
              US_CAPABILITY.READ,
            );
            await h.f.pool.query(
              "INSERT INTO member(id, organization_id, user_id, role, created_at) VALUES($1,$2,$3,'owner',now())",
              [randomUUID(), checked.tenantId, checked.actorUserId],
            );
            afterInsertion = await h.f.snapshot();
            const start = observation.statements.length;
            await dependencies.authorize(
              tx,
              checked.tenantId,
              checked.actorUserId,
              US_CAPABILITY.READ,
            );
            const authorization = observation.statements.slice(start);
            expect(authorization).toHaveLength(1);
            expect(authorization[0]).toMatch(/from "member".*limit .*for share/);
            return original(...args);
          });
        try {
          await expect(
            new UsDatasetShippingSeedStore(h.f.db).verifyTerminalProjection(h.context, 0),
          ).rejects.toThrow("us_dataset_target_invalid");
          expect(afterInsertion).toBeDefined();
          expect(await h.f.snapshot()).toEqual(afterInsertion);
        } finally {
          spy.mockRestore();
          observation.close();
        }
      }),
    );

    it(
      "keeps empty capability denial, missing rows, finite-set completeness, ranges and derived basis fresh",
      h.phase(async () => {
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        const observation = observeStatements(h.f.pool);
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            const [tx, checked, , , d] = args;
            const { tenantId, actorUserId } = checked;
            let start = observation.statements.length;
            await expect(d.authorize(tx, tenantId, actorUserId, [])).rejects.toMatchObject({
              response: { code: "insufficient_permission" },
            });
            expect(observation.statements.slice(start)).toHaveLength(1);
            expect(observation.statements[start]).toContain('from "member"');
            // Before the native verifier's lock plan, even a present row stays fresh.
            start = observation.statements.length;
            const unlocked = await d.points.lot(tx, tenantId, prepared.input.outputLotId);
            expect(unlocked).toBeDefined();
            expect(await d.points.lot(tx, tenantId, prepared.input.outputLotId)).toEqual(unlocked);
            expect(observation.statements.slice(start)).toHaveLength(2);
            const projection = await original(...args);
            const receiving = parseUsDatasetReceivingResult(prepared.receiving.receipt?.result);
            const refs = parseUsDatasetReferenceResult(prepared.references.receipt?.result);
            const shippingId = projection.shipping.shipments[0]?.created.id;
            const lotId = receiving.lots[0]?.id;
            const partyId = refs.bindings.parties[0]?.id;
            if (!shippingId || !lotId || !partyId)
              throw new Error("Missing prepared native identity");
            const documentId = receiving.documents[0]?.record.id;
            if (!documentId) throw new Error("Missing native document");
            // All these later point requests follow the real full native proof.
            // No ID-only lock projection can satisfy the original full-row checks.
            for (const [read, id] of [
              [d.points.lot, lotId],
              [d.points.document, documentId],
              [d.points.event, receiving.created.eventId],
              [d.points.event, projection.transformation.created.id],
              [d.points.event, shippingId],
              [d.points.receivingRoot, receiving.created.eventId],
              [d.points.transformationRoot, projection.transformation.created.id],
              [d.points.shippingRoot, shippingId],
            ] as const) {
              start = observation.statements.length;
              const row = await read(tx, tenantId, id);
              expect(row).toBeDefined();
              expect(await read(tx, tenantId, id)).toEqual(row);
              expect(observation.statements.slice(start)).toEqual([]);
            }
            start = observation.statements.length;
            expect(
              await d.master.getPartyInTransaction(tx, tenantId, actorUserId, partyId),
            ).toMatchObject({ id: partyId });
            expect(observation.statements.slice(start)).toHaveLength(1);
            expect(observation.statements[start]).toContain('from "member"');
            const missing = randomUUID();
            start = observation.statements.length;
            expect(await d.points.lot(tx, tenantId, missing)).toBeUndefined();
            expect(await d.points.lot(tx, tenantId, missing)).toBeUndefined();
            expect(observation.statements.slice(start)).toHaveLength(2);
            for (let attempt = 0; attempt < 2; attempt++) {
              start = observation.statements.length;
              await expect(
                d.master.getPartiesInTransaction(tx, tenantId, actorUserId, [partyId, missing]),
              ).rejects.toMatchObject({ response: { code: "party_not_found" } });
              const statements = observation.statements.slice(start);
              expect(statements).toHaveLength(2);
              expect(statements[0]).toContain('from "member"');
              expect(statements[1]).toMatch(/from "traceability_parties".* in \(/);
            }
            const repeat = async (read: () => Promise<unknown>) => {
              const start = observation.statements.length;
              const first = await read();
              const firstSql = observation.statements.slice(start);
              const again = observation.statements.length;
              expect(await read()).toEqual(first);
              expect(observation.statements.slice(again)).toEqual(firstSql);
              return firstSql;
            };
            const revisions = await repeat(() =>
              d.shippingRevisions(tx, tenantId, shippingId, { limit: 10, offset: 0 }),
            );
            expect(revisions).toHaveLength(2);
            expect(revisions[0]).toMatch(/from "shipping_event_roots".*for share/);
            expect(revisions[1]).toMatch(/from "traceability_events".*order by/);
            const basis = await repeat(() =>
              d.receiving.getLotReceivingBasisInTransaction(tx, tenantId, actorUserId, lotId, {
                limit: 10,
                offset: 0,
              }),
            );
            expect(basis.some((text) => text.includes('from "member"'))).toBe(true);
            expect(basis.some((text) => text.includes("count(distinct"))).toBe(true);
            expect(basis.some((text) => text.includes("order by"))).toBe(true);
            await repeat(() => d.locks.receivingRevision(tx, tenantId, receiving.created.eventId));
            await repeat(() =>
              d.locks.transformationRevision(tx, tenantId, projection.transformation.created.id),
            );
            const location = refs.bindings.locations[0]?.id;
            if (!location) throw new Error("Missing location");
            const locations = await repeat(() =>
              d.master.getLocationInTransaction(tx, tenantId, actorUserId, location),
            );
            expect(locations.some((text) => text.includes('from "traceability_locations"'))).toBe(
              true,
            );
            return projection;
          });
        try {
          await new UsDatasetShippingSeedStore(h.f.db).verifyTerminalProjection(h.context, 0);
        } finally {
          spy.mockRestore();
          observation.close();
        }
      }),
    );

    it.each(["success", "exception"] as const)(
      "binds every reader lifetime on %s and keeps retained native Date and JSON values privately owned",
      h.phase(async (completion) => {
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        const revoked: (() => unknown)[] = [];
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            const [tx, checked, , , dependencies] = args;
            const { tenantId, actorUserId } = checked;
            await expect(
              Promise.resolve().then(() =>
                dependencies.authorize(tx, randomUUID(), actorUserId, US_CAPABILITY.READ),
              ),
            ).rejects.toThrow("us_dataset_terminal_reader_binding_invalid");
            await expect(
              Promise.resolve().then(() =>
                dependencies.authorize(tx, tenantId, randomUUID(), US_CAPABILITY.READ),
              ),
            ).rejects.toThrow("us_dataset_terminal_reader_binding_invalid");
            await expect(
              Promise.resolve().then(() =>
                dependencies.journal.readHeaderInTransaction(tx, {
                  ...checked,
                  expectedDatabaseName: "wrong_database",
                }),
              ),
            ).rejects.toThrow("us_dataset_terminal_reader_binding_invalid");
            await h.f.db.transaction(async (other) => {
              await expect(
                Promise.resolve().then(() =>
                  dependencies.authorize(other, tenantId, actorUserId, US_CAPABILITY.READ),
                ),
              ).rejects.toThrow("us_dataset_terminal_reader_binding_invalid");
            });
            const projection = await original(...args);
            const lot = await dependencies.points.lot(tx, tenantId, prepared.input.outputLotId);
            if (!lot) throw new Error("Missing observed lot");
            const originalLot = structuredClone(lot);
            lot.createdAt.setTime(0);
            expect(await dependencies.points.lot(tx, tenantId, lot.id)).toEqual(originalLot);
            const receiving = parseUsDatasetReceivingResult(prepared.receiving.receipt?.result);
            const event = await dependencies.points.event(tx, tenantId, receiving.created.eventId);
            if (
              !event ||
              !event.finalizationSnapshot ||
              typeof event.finalizationSnapshot !== "object"
            )
              throw new Error("Missing observed event");
            const originalEvent = structuredClone(event);
            event.createdAt.setTime(0);
            Reflect.set(
              event.finalizationSnapshot,
              "notes",
              "Test mutation must not reach retained raw JSON",
            );
            expect(await dependencies.points.event(tx, tenantId, event.id)).toEqual(originalEvent);
            const transformation = parseUsDatasetTransformationResult(
              prepared.transformation.receipt?.result,
            );
            const bindings = parseUsDatasetReferenceResult(
              prepared.references.receipt?.result,
            ).bindings;
            const firstDocument = receiving.documents[0];
            if (!firstDocument) throw new Error("Missing observed document");
            revoked.push(
              () => dependencies.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ),
              () => dependencies.master.getPartyInTransaction(tx, tenantId, actorUserId, "invalid"),
              () => dependencies.master.getPartiesInTransaction(tx, tenantId, actorUserId, []),
              () =>
                dependencies.master.getLocationInTransaction(tx, tenantId, actorUserId, "invalid"),
              () => dependencies.master.getLocationsInTransaction(tx, tenantId, actorUserId, []),
              () => dependencies.catalog.getProductsInTransaction(tx, tenantId, actorUserId, []),
              () => dependencies.profiles.getProfilesInTransaction(tx, tenantId, actorUserId, []),
              () =>
                dependencies.documents.getDocumentInTransaction(
                  tx,
                  tenantId,
                  actorUserId,
                  firstDocument.record.id,
                ),
              () => dependencies.lots.getLotInTransaction(tx, tenantId, actorUserId, lot.id),
              () =>
                dependencies.receiving.getLiveRecordInTransaction(
                  tx,
                  tenantId,
                  actorUserId,
                  event.id,
                ),
              () =>
                dependencies.receiving.getLotReceivingBasisInTransaction(
                  tx,
                  tenantId,
                  actorUserId,
                  lot.id,
                  { limit: 10, offset: 0 },
                ),
              () =>
                dependencies.transformation.getRecordInTransaction(
                  tx,
                  tenantId,
                  actorUserId,
                  transformation.created.id,
                ),
              () =>
                dependencies.shipping.getRecordInTransaction(
                  tx,
                  tenantId,
                  actorUserId,
                  projection.shipping.shipments[0]?.created.id,
                ),
              () =>
                dependencies.shippingRevisions(tx, tenantId, event.id, { limit: 10, offset: 0 }),
              () => dependencies.journal.readHeaderInTransaction(tx, checked),
              () =>
                dependencies.journal.readStageInTransaction(
                  tx,
                  checked,
                  prepared.datasetId,
                  prepared.intent.unitKey,
                  "shipping",
                ),
              () =>
                dependencies.journal.readStagesInTransaction(tx, checked, prepared.datasetId, []),
              ...Object.values(dependencies.points).map(
                (read) => () => read(tx, tenantId, event.id),
              ),
              () =>
                dependencies.locks.shipping(
                  tx,
                  checked,
                  receiving,
                  transformation,
                  projection.shipping,
                ),
              () => dependencies.locks.transformation(tx, checked, { receiving, transformation }),
              () => dependencies.locks.referenceParents(tx, tenantId, bindings),
              () =>
                dependencies.locks.shippingReferences(
                  tx,
                  tenantId,
                  prepared.intent.unitKey,
                  bindings,
                ),
              () => dependencies.locks.receivingDocuments(tx, tenantId, []),
              () => dependencies.locks.transformationDocuments(tx, tenantId, []),
              () => dependencies.locks.shippingDocuments(tx, tenantId, [], []),
              () => dependencies.locks.receivingRoot(tx, tenantId, event.id),
              () => dependencies.locks.receivingRevision(tx, tenantId, event.id),
              () =>
                dependencies.locks.transformationRevision(tx, tenantId, transformation.created.id),
            );
            if (completion === "exception") throw failure;
            return projection;
          });
        const failure = new Error("Test-only verifier exception after native proof");
        try {
          const owner = new UsDatasetShippingSeedStore(h.f.db);
          expect(Reflect.ownKeys(Object.getPrototypeOf(owner))).not.toContain(
            "#verifyTerminalProjection",
          );
          if (completion === "success") await owner.verifyTerminalProjection(h.context, 0);
          else await expect(owner.verifyTerminalProjection(h.context, 0)).rejects.toBe(failure);
          expect(revoked).toHaveLength(33);
          for (const call of revoked)
            await expect(Promise.resolve().then(call)).rejects.toThrow(
              "us_dataset_terminal_reader_binding_invalid",
            );
        } finally {
          spy.mockRestore();
        }
      }),
    );

    it.each([
      "profile",
      "organization",
      "party",
      "lot",
      "document",
      "receiving root",
      "transformation root",
      "shipping root",
      "event",
    ] as const)(
      "retains real %s protection through the owner's COMMIT",
      h.phase(async (kind) => {
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        const writer = await h.f.pool.connect();
        const observer = { pool: h.f.pool, db: h.f.db };
        let pending: ReturnType<typeof outcome> | undefined;
        let observed = false;
        await writer.query("BEGIN");
        const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        if (!writerPid) throw new Error("Missing owned writer PID");
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            const projection = await original(...args);
            const [tx] = args;
            const readerPid = (
              await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
            ).rows[0]?.pid;
            if (!readerPid) throw new Error("Missing owned reader PID");
            const receiving = parseUsDatasetReceivingResult(prepared.receiving.receipt?.result);
            const transformation = parseUsDatasetTransformationResult(
              prepared.transformation.receipt?.result,
            );
            const refs = parseUsDatasetReferenceResult(prepared.references.receipt?.result);
            const targets = {
              profile: [
                "traceability_profiles",
                "retention_years",
                "tenant_id",
                h.context.tenantId,
              ],
              organization: ["org_profiles", "time_zone", "tenant_id", h.context.tenantId],
              party: ["traceability_parties", "name", "id", refs.bindings.parties[0]?.id],
              lot: ["traceability_lots", "revision", "id", projection.shipping.input.outputLotId],
              document: ["reference_documents", "notes", "id", receiving.documents[0]?.record.id],
              "receiving root": [
                "receiving_event_roots",
                "lifecycle_version",
                "id",
                receiving.created.eventId,
              ],
              "transformation root": [
                "transformation_event_roots",
                "lifecycle_version",
                "id",
                transformation.created.id,
              ],
              "shipping root": [
                "shipping_event_roots",
                "lifecycle_version",
                "id",
                projection.shipping.shipments[0]?.created.id,
              ],
              event: ["traceability_events", "notes", "id", receiving.created.eventId],
            } as const;
            const [table, column, key, id] = targets[kind];
            if (!id) throw new Error("Missing owned protected row");
            pending = outcome(
              writer.query(
                `UPDATE ${table} SET ${column}=${column} WHERE tenant_id=$1 AND ${key}=$2`,
                [h.context.tenantId, id],
              ),
            );
            await waitBlocked(observer, readerPid, writerPid, AbortSignal.timeout(4000));
            observed = true;
            return projection;
          });
        try {
          await new UsDatasetShippingSeedStore(h.f.db).verifyTerminalProjection(h.context, 0);
          expect(observed).toBe(true);
          const result = await pending;
          if (kind === "event") {
            expect(driverCode(result?.error)).toBe("23514");
            expect(result?.error).toMatchObject({
              message: "Frozen Receiving content is immutable",
            });
          } else expect(result?.error).toBeUndefined();
        } finally {
          spy.mockRestore();
          await pending;
          await writer.query("ROLLBACK");
          writer.release();
        }
      }),
    );
  });

  describe("remaining native falsifications", () => {
    const h = specialFixture(base);
    let prepared: Awaited<ReturnType<typeof prepareDatasetShippingFixture>>;
    let projection: UsDatasetShippingProjection;
    beforeEach(
      h.phase(async () => {
        prepared = await prepareDatasetShippingFixture(h.f, h.context, 0);
        projection = await new UsDatasetShippingSeedStore(h.f.db).initializeTerminalProjection(
          h.context,
          0,
        );
      }),
      30_000,
    );

    it.each([
      "profile",
      "organization",
      "party",
      "lot",
      "document",
      "receiving root",
      "transformation root",
      "shipping root",
    ] as const)(
      "preserves writer-first %s UPDATE eligibility and first observation",
      h.phase(async (kind) => {
        if (!base) throw new Error("Missing owned fixture URL");
        const url = new URL(base);
        url.pathname = h.f.databaseName;
        const reader = createDb(url.toString(), { max: 1 });
        const writer = await h.f.pool.connect();
        let reading: ReturnType<typeof outcome<UsDatasetShippingProjection>> | undefined;
        const refs = parseUsDatasetReferenceResult(prepared.references.receipt?.result);
        const targets = {
          profile: ["traceability_profiles", "retention_years=7", "tenant_id", h.context.tenantId],
          organization: [
            "org_profiles",
            "time_zone='America/Chicago'",
            "tenant_id",
            h.context.tenantId,
          ],
          party: [
            "traceability_parties",
            "name=name || ' writer-first'",
            "id",
            refs.bindings.parties[0]?.id,
          ],
          lot: [
            "traceability_lots",
            "updated_at=updated_at+interval '1 second'",
            "id",
            projection.shipping.input.outputLotId,
          ],
          document: [
            "reference_documents",
            "notes='writer-first drift'",
            "id",
            projection.receiving.documents[0]?.record.id,
          ],
          "receiving root": [
            "receiving_event_roots",
            "lifecycle_version=lifecycle_version+1",
            "id",
            projection.receiving.created.eventId,
          ],
          "transformation root": [
            "transformation_event_roots",
            "lifecycle_version=lifecycle_version+1",
            "id",
            projection.transformation.created.id,
          ],
          "shipping root": [
            "shipping_event_roots",
            "lifecycle_version=lifecycle_version+1",
            "id",
            projection.shipping.shipments[0]?.created.id,
          ],
        } as const;
        let entered = false;
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            entered = true;
            return original(...args);
          });
        try {
          const readerPid = (
            await reader.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]?.pid;
          const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
            .rows[0]?.pid;
          if (!readerPid || !writerPid) throw new Error("Missing owned backend PID");
          const [table, change, key, id] = targets[kind];
          if (!id) throw new Error("Missing protected row");
          await writer.query("BEGIN");
          if (
            kind === "receiving root" ||
            kind === "transformation root" ||
            kind === "shipping root"
          ) {
            const denied = await outcome(
              writer.query(`UPDATE ${table} SET ${change} WHERE tenant_id=$1 AND ${key}=$2`, [
                h.context.tenantId,
                id,
              ]),
            );
            expect(driverCode(denied.error)).toBe("23514");
            expect(denied.error).toMatchObject({
              message:
                kind === "receiving root"
                  ? "Invalid Receiving root transition or allocation"
                  : kind === "transformation root"
                    ? "Transformation root lifecycle version must follow a pointer change"
                    : "Shipping root lifecycle version must follow a pointer change",
            });
            expect(entered).toBe(false);
            // Real changed-root writer-first schedules use native lifecycle commands
            // in the unchanged Shipping-projection suite, not illegal raw versions.
            return;
          }
          expect(
            (
              await writer.query(`UPDATE ${table} SET ${change} WHERE tenant_id=$1 AND ${key}=$2`, [
                h.context.tenantId,
                id,
              ])
            ).rowCount,
          ).toBe(1);
          reading = outcome(
            new UsDatasetShippingSeedStore(reader.db).verifyTerminalProjection(h.context, 0),
          );
          await waitBlocked(h.f, writerPid, readerPid, AbortSignal.timeout(4000));
          await writer.query("COMMIT");
          const result = await reading;
          if (kind === "profile" || kind === "organization") {
            expect(driverCode(result.error)).toBe("40001");
            expect(entered).toBe(false);
          } else {
            expect(entered).toBe(true);
            expect(result.error).toMatchObject({
              message:
                kind === "lot" ? "us_dataset_shipping_mismatch" : "us_dataset_cases_mismatch",
            });
          }
          expect(result.value).toBeUndefined();
        } finally {
          await writer.query("ROLLBACK");
          await reading;
          spy.mockRestore();
          writer.release();
          await reader.pool.end();
        }
      }),
    );

    it(
      "observes committed profile UPDATE after outer RR and before inner RC first authorization",
      h.phase(async () => {
        if (!base) throw new Error("Missing owned fixture URL");
        const url = new URL(base);
        url.pathname = h.f.databaseName;
        const reader = createDb(url.toString(), { max: 1 });
        const writer = await h.f.pool.connect();
        const readerPid = (
          await reader.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]?.pid;
        const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        if (!readerPid || !writerPid) throw new Error("Missing owned backend PID");
        const atomicOriginal = UsDatasetJournalStore.prototype.runAtomicStage;
        const coreOriginal = shippingVerification.verifyUsDatasetShippingProjectionCore;
        const profileOriginal = masterSupport.readUsMasterDataProfile;
        let entered = false;
        let observed: unknown;
        let inner: ReturnType<typeof outcome> | undefined;
        const coreSpy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            entered = true;
            return coreOriginal(...args);
          });
        const profileSpy = vi
          .spyOn(masterSupport, "readUsMasterDataProfile")
          .mockImplementation(async (...args) => {
            const row = await profileOriginal(...args);
            if (entered) observed = row;
            return row;
          });
        const atomicSpy = vi
          .spyOn(UsDatasetJournalStore.prototype, "runAtomicStage")
          .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
            await writer.query("BEGIN");
            await writer.query(
              "UPDATE traceability_profiles SET retention_years=7 WHERE tenant_id=$1",
              [h.context.tenantId],
            );
            const pending = atomicOriginal.apply(this, args);
            inner = outcome(pending);
            await waitBlocked(h.f, writerPid, readerPid, AbortSignal.timeout(4000));
            expect(entered).toBe(false);
            await writer.query("COMMIT");
            return pending;
          });
        try {
          expect(
            await new UsDatasetShippingSeedStore(reader.db).verifyTerminalProjection(h.context, 0),
          ).toEqual(projection);
          expect(entered).toBe(true);
          expect(observed).toMatchObject({ retentionYears: 7, timeZone: "America/Los_Angeles" });
        } finally {
          await writer.query("ROLLBACK");
          await inner;
          atomicSpy.mockRestore();
          coreSpy.mockRestore();
          profileSpy.mockRestore();
          writer.release();
          await reader.pool.end();
        }
      }),
    );

    it(
      "rechecks operation cardinality after a real FK-blocked insertion commits",
      h.phase(async () => {
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        const writer = await h.f.pool.connect();
        await writer.query("BEGIN");
        const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        let writing: ReturnType<typeof outcome> | undefined;
        let blocked = false;
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            const result = await original(...args);
            const readerPid = (
              await args[0].execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
            ).rows[0]?.pid;
            if (!readerPid || !writerPid) throw new Error("Missing owned backend PID");
            writing = outcome(
              writer.query(
                "INSERT INTO receiving_operations SELECT (jsonb_populate_record(NULL::receiving_operations,to_jsonb(o)||jsonb_build_object('command','receiving.save'))).* FROM receiving_operations o WHERE tenant_id=$1 AND operation_key=$2 AND command='receiving.create'",
                [h.context.tenantId, prepared.receiving.intent.operationKey],
              ),
            );
            await waitBlocked(h.f, readerPid, writerPid, AbortSignal.timeout(4000));
            blocked = true;
            return result;
          });
        try {
          expect(
            await new UsDatasetShippingSeedStore(h.f.db).verifyTerminalProjection(h.context, 0),
          ).toEqual(projection);
          expect(blocked).toBe(true);
          const written = await writing;
          expect(written?.error).toBeUndefined();
          await writer.query("COMMIT");
          spy.mockRestore();
          const before = await h.f.snapshot();
          await expect(
            new UsDatasetShippingSeedStore(h.f.db).verifyTerminalProjection(h.context, 0),
          ).rejects.toMatchObject({
            message: "us_dataset_cases_mismatch",
            cause: {
              message: "us_dataset_transformation_mismatch",
              cause: { message: "us_dataset_receiving_mismatch" },
            },
          });
          expect(await h.f.snapshot()).toEqual(before);
        } finally {
          spy.mockRestore();
          await writing;
          await writer.query("ROLLBACK");
          writer.release();
        }
      }),
    );

    it(
      "does not retain absence when an unlocked imported lot is independently inserted",
      h.phase(async () => {
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        const id = randomUUID();
        let afterInsert: Awaited<ReturnType<typeof h.f.snapshot>> | undefined;
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            const result = await original(...args);
            const [tx, checked, , , d] = args;
            expect(await d.points.lot(tx, checked.tenantId, id)).toBeUndefined();
            const now = new Date();
            await h.f.db.insert(schema.traceabilityLots).values({
              id,
              tenantId: checked.tenantId,
              productId: projection.shipping.input.outputProductId,
              tlc: "CLOSED-ABSENCE-" + id,
              assignmentBasis: "imported",
              createdBy: checked.actorUserId,
              updatedBy: checked.actorUserId,
              createdAt: now,
              updatedAt: now,
            });
            expect(await d.points.lot(tx, checked.tenantId, id)).toMatchObject({
              id,
              assignmentBasis: "imported",
              createdAt: now,
            });
            expect(
              await d.lots.getLotInTransaction(tx, checked.tenantId, checked.actorUserId, id),
            ).toMatchObject({ id, assignmentBasis: "imported", createdAt: now.toISOString() });
            afterInsert = await h.f.snapshot();
            return result;
          });
        try {
          expect(
            await new UsDatasetShippingSeedStore(h.f.db).verifyTerminalProjection(h.context, 0),
          ).toEqual(projection);
          expect(afterInsert).toBeDefined();
          expect(await h.f.snapshot()).toEqual(afterInsert);
        } finally {
          spy.mockRestore();
        }
      }),
    );

    it(
      "preserves a naturally selected native deadlock victim without retry",
      h.phase(async () => {
        if (!base) throw new Error("Missing owned fixture URL");
        const url = new URL(base);
        url.pathname = h.f.databaseName;
        const reader = createDb(url.toString(), { max: 1 });
        const writer = await h.f.pool.connect();
        let coreError: unknown;
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            try {
              return await original(...args);
            } catch (error) {
              coreError = error;
              throw error;
            }
          });
        let reading: ReturnType<typeof outcome<UsDatasetShippingProjection>> | undefined;
        let writing: ReturnType<typeof outcome> | undefined;
        try {
          const readerPid = (
            await reader.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]?.pid;
          const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
            .rows[0]?.pid;
          if (!readerPid || !writerPid) throw new Error("Missing owned backend PID");
          await writer.query("BEGIN");
          await writer.query(
            "SELECT id FROM transformation_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [h.context.tenantId, projection.transformation.created.id],
          );
          reading = outcome(
            new UsDatasetShippingSeedStore(reader.db).verifyTerminalProjection(h.context, 0),
          );
          await waitBlocked(h.f, writerPid, readerPid, AbortSignal.timeout(4000));
          writing = outcome(
            writer.query(
              "SELECT id FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [h.context.tenantId, projection.receiving.created.eventId],
            ),
          );
          const writerResult = await writing;
          await writer.query("ROLLBACK");
          const ownerResult = await reading;
          const victim = writerResult.error ? "writer" : "owner";
          if (victim === "owner") {
            expect(driverCode(ownerResult.error)).toBe("40P01");
            expect(ownerResult.error).toBe(coreError);
            expect(ownerResult.value).toBeUndefined();
            expect(writerResult.error).toBeUndefined();
          } else {
            expect(driverCode(writerResult.error)).toBe("40P01");
            expect(ownerResult.error).toBeUndefined();
            expect(ownerResult.value).toEqual(projection);
          }
          console.info("Natural native deadlock victim", victim, "40P01");
        } finally {
          await writer.query("ROLLBACK");
          await Promise.all([reading, writing]);
          spy.mockRestore();
          writer.release();
          await reader.pool.end();
        }
      }),
    );

    it(
      "re-observes an independently committed audit phantom inside one private interval",
      h.phase(async () => {
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        let inserted = false;
        let afterInsert: Awaited<ReturnType<typeof h.f.snapshot>> | undefined;
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            await original(...args);
            const audits = await h.f.db.select().from(schema.tenantAuditEvents);
            const row = audits.find(
              (row) => row.requestId === prepared.receiving.intent.operationKey,
            );
            if (!row) throw new Error("Missing prepared Receiving audit");
            await h.f.db.insert(schema.tenantAuditEvents).values({ ...row, id: randomUUID() });
            inserted = true;
            afterInsert = await h.f.snapshot();
            return original(...args);
          });
        try {
          await expect(
            new UsDatasetShippingSeedStore(h.f.db).verifyTerminalProjection(h.context, 0),
          ).rejects.toMatchObject({
            message: "us_dataset_cases_mismatch",
            cause: {
              message: "us_dataset_transformation_mismatch",
              cause: { message: "us_dataset_receiving_mismatch" },
            },
          });
          expect(inserted).toBe(true);
          expect(await h.f.snapshot()).toEqual(afterInsert);
        } finally {
          spy.mockRestore();
        }
      }),
    );

    it(
      "keeps child insertion behind the real frozen-parent lock and native guard",
      h.phase(async () => {
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        const writer = await h.f.pool.connect();
        await writer.query("BEGIN");
        const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        let writing: ReturnType<typeof outcome> | undefined;
        let blocked = false;
        const before = await h.f.snapshot();
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            const result = await original(...args);
            const readerPid = (
              await args[0].execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
            ).rows[0]?.pid;
            if (!readerPid || !writerPid) throw new Error("Missing owned backend PID");
            writing = outcome(
              writer.query(
                "INSERT INTO receiving_event_items SELECT (jsonb_populate_record(NULL::receiving_event_items, to_jsonb(i) || jsonb_build_object('line_no',99))).* FROM receiving_event_items i WHERE tenant_id=$1 AND event_id=$2 LIMIT 1",
                [h.context.tenantId, projection.receiving.created.eventId],
              ),
            );
            await waitBlocked(h.f, readerPid, writerPid, AbortSignal.timeout(4000));
            blocked = true;
            return result;
          });
        try {
          expect(
            await new UsDatasetShippingSeedStore(h.f.db).verifyTerminalProjection(h.context, 0),
          ).toEqual(projection);
          expect(blocked).toBe(true);
          const result = await writing;
          expect(driverCode(result?.error)).toBe("23514");
          expect(result?.error).toMatchObject({
            message: "Finalized receiving children are immutable",
          });
        } finally {
          spy.mockRestore();
          await writing;
          await writer.query("ROLLBACK");
          writer.release();
        }
        expect(await h.f.snapshot()).toEqual(before);
      }),
    );

    it(
      "rechecks authority after owner COMMIT before the actual Trace reader",
      h.phase(async () => {
        const original = UsDatasetShippingSeedStore.prototype.verifyTerminalProjection;
        let revoked = false;
        const spy = vi
          .spyOn(UsDatasetShippingSeedStore.prototype, "verifyTerminalProjection")
          .mockImplementation(async function (this: UsDatasetShippingSeedStore, ...args) {
            const result = await original.apply(this, args);
            await h.f.pool.query(
              "UPDATE member SET role='viewer' WHERE organization_id=$1 AND user_id=$2",
              [h.context.tenantId, h.context.actorUserId],
            );
            revoked = true;
            return result;
          });
        try {
          const result = await outcome(
            new UsDatasetTraceReadinessStore(h.f.db).verify(h.context, {
              kind: "regular",
              index: 0,
            }),
          );
          expect(revoked).toBe(true);
          expect(result.value).toBeUndefined();
          expect(result.error).toMatchObject({ response: { code: "insufficient_permission" } });
        } finally {
          spy.mockRestore();
        }
      }),
    );
  });

  describe("joined Shipping current-status linearization", () => {
    const h = specialFixture(base);
    let projection: UsDatasetShippingProjection;
    beforeEach(
      h.phase(async () => {
        await prepareDatasetShippingFixture(h.f, h.context, 258);
        projection = await new UsDatasetShippingSeedStore(h.f.db).initializeTerminalProjection(
          h.context,
          258,
        );
      }),
      30_000,
    );
    it.each(["amend", "finalized void", "pending void"] as const)(
      "keeps the real joined read linearized against native %s with its discovered root unlocked",
      h.phase(async (kind) => {
        if (!base) throw new Error("Missing owned fixture URL");
        const url = new URL(base);
        url.pathname = h.f.databaseName;
        const reader = createDb(url.toString(), { max: 1 }),
          writer = createDb(url.toString(), { max: 1 });
        const proceed = barrier(),
          locked = barrier();
        let reading: ReturnType<typeof outcome> | undefined;
        let writing: ReturnType<typeof outcome> | undefined;
        try {
          const readerPid = (
            await reader.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]?.pid;
          const writerPid = (
            await writer.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]?.pid;
          if (!readerPid || !writerPid) throw new Error("Missing owned backend PID");
          const shipping = new UsShippingStore(writer.db),
            last = projection.shipping.shipments.at(-1);
          if (!last) throw new Error("Missing last native shipment");
          const amendment =
            kind === "pending void"
              ? await shipping.amend(
                  h.context.tenantId,
                  h.context.actorUserId,
                  last.created.id,
                  {
                    operationKey: randomUUID(),
                    expectedLifecycleVersion: 2,
                    reason: "Owned pending-void schedule",
                  },
                  "closed-status-amend",
                )
              : undefined;
          const proof = (hold: boolean) =>
            reader.db.transaction(
              async (tx) => {
                await lockUsDatasetTransformation(tx, h.context, {
                  receiving: projection.receiving,
                  transformation: projection.transformation,
                });
                if (hold) {
                  locked.release();
                  await proceed.promise;
                }
                const stores = datasetTransformationStores(reader.db);
                await verifyUsDatasetShippingOriginStatus(
                  tx,
                  h.context,
                  stores.journal,
                  projection.transformation,
                  await stores.lots.getLotInTransaction(
                    tx,
                    h.context.tenantId,
                    h.context.actorUserId,
                    projection.transformation.outputLot.id,
                  ),
                );
              },
              { isolationLevel: "read committed" },
            );
          reading = outcome(proof(true));
          await Promise.race([
            locked.promise,
            reading.then(({ error }) => {
              throw error ?? new Error("Reader ended before original lot lock");
            }),
          ]);
          const command = {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            reason: "Owned native writer waiting on lot",
          };
          writing = outcome(
            kind === "amend"
              ? shipping.amend(
                  h.context.tenantId,
                  h.context.actorUserId,
                  last.created.id,
                  command,
                  "closed-status-amend",
                )
              : shipping.void(
                  h.context.tenantId,
                  h.context.actorUserId,
                  amendment?.eventId ?? last.created.id,
                  amendment
                    ? { ...command, expectedLifecycleVersion: 3, expectedDraftVersion: 1 }
                    : command,
                  "closed-status-void",
                ),
          );
          if (kind === "pending void") {
            expect((await writing).error).toBeUndefined();
            proceed.release();
            expect((await reading).error).toMatchObject({
              message: "us_dataset_transformation_mismatch",
            });
          } else {
            await waitBlocked(h.f, readerPid, writerPid, AbortSignal.timeout(4000));
            proceed.release();
            expect((await reading).error).toBeUndefined();
            expect((await writing).error).toBeUndefined();
          }
          const before = await h.f.snapshot();
          await expect(proof(false)).rejects.toThrow("us_dataset_transformation_mismatch");
          expect(await h.f.snapshot()).toEqual(before);
        } finally {
          proceed.release();
          await Promise.all([reading, writing]);
          await reader.pool.end();
          await writer.pool.end();
        }
      }),
    );
  });

  describe.each([0, 1, 181, 259])("regular %i", (index) => {
    const h = specialFixture(base);
    let prepared: Awaited<ReturnType<typeof prepareDatasetShippingFixture>>;
    let fresh: UsDatasetShippingProjection;
    beforeEach(
      h.phase(async () => {
        prepared = await prepareDatasetShippingFixture(h.f, h.context, index);
        fresh = await new UsDatasetShippingSeedStore(h.f.db).initializeTerminalProjection(
          h.context,
          index,
        );
      }),
      30_000,
    );
    it.each(["verify", "replay"] as const)(
      "preserves complete fresh/%s projection, receipt digests and audited no-write rows",
      h.phase(async (mode) => {
        const journal = datasetTransformationStores(h.f.db).journal;
        const stage = await journal.readStage(
          h.context,
          prepared.datasetId,
          prepared.intent.unitKey,
          "shipping",
        );
        if (!stage?.receipt) throw new Error("Missing native receipt");
        expect(stage.revision).toBe(2);
        expect(stage.receipt.result).toEqual(fresh.shipping);
        expect(stage.receipt.resultDigest).toBe(canonicalExportDigest(fresh.shipping));
        expect(fresh.receiving).toEqual(prepared.receiving.receipt?.result);
        expect(fresh.transformation).toEqual(prepared.transformation.receipt?.result);
        const before = await h.f.snapshot();
        const owner = new UsDatasetShippingSeedStore(h.f.db);
        const actual = await (mode === "verify"
          ? owner.verifyTerminalProjection(h.context, index)
          : owner.initializeTerminalProjection(h.context, index));
        expect(actual).toEqual(fresh);
        expect(
          (
            await journal.readStage(
              h.context,
              prepared.datasetId,
              prepared.intent.unitKey,
              "shipping",
            )
          )?.receipt,
        ).toEqual(stage.receipt);
        expect(await h.f.snapshot()).toEqual(before);
      }),
    );
  });

  describe("application and receipt boundary", () => {
    const h = specialFixture(base);
    let shipmentCount = 0;
    beforeEach(
      h.phase(async () => {
        const prepared = await prepareDatasetShippingFixture(h.f, h.context, 0);
        shipmentCount = parseUsDatasetShippingInput(prepared.intent.input).chain.shipping.length;
      }),
      30_000,
    );
    it.each(["profile", "timezone", "lot", "root"] as const)(
      "preserves own immediate-trigger %s visibility and first-error ordering",
      h.phase(async (kind) => {
        const name = "closed_own_" + randomUUID().replaceAll("-", "");
        const changes = {
          profile:
            "UPDATE traceability_profiles SET retention_years=7 WHERE tenant_id=NEW.tenant_id;",
          timezone:
            "UPDATE org_profiles SET time_zone='America/Chicago' WHERE tenant_id=NEW.tenant_id;",
          lot: "UPDATE traceability_lots SET created_at=created_at-interval '1 second' WHERE tenant_id=NEW.tenant_id AND id IN (SELECT lot_id FROM receiving_event_items WHERE tenant_id=NEW.tenant_id);",
          root: "UPDATE receiving_event_roots SET lifecycle_version=lifecycle_version+1 WHERE tenant_id=NEW.tenant_id;",
        };
        await h.f.pool.query(
          `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='shipping' AND NEW.status='finalized' AND (SELECT count(*) FROM traceability_events WHERE tenant_id=NEW.tenant_id AND type='shipping' AND status='finalized')=${shipmentCount} THEN ${changes[kind]} END IF; RETURN NEW; END $$`,
        );
        await h.f.pool.query(
          `CREATE TRIGGER ${name} AFTER UPDATE ON traceability_events FOR EACH ROW EXECUTE FUNCTION ${name}()`,
        );
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        const profileRead = masterSupport.readUsMasterDataProfile;
        let entered = false;
        let privateProfile: unknown;
        const profileSpy = vi
          .spyOn(masterSupport, "readUsMasterDataProfile")
          .mockImplementation(async (...args) => {
            const row = await profileRead(...args);
            if (entered) privateProfile = row;
            return row;
          });
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            entered = true;
            const observed = await args[0].execute<{ value: unknown }>(
              sql.raw(
                kind === "profile"
                  ? "SELECT retention_years AS value FROM traceability_profiles"
                  : kind === "timezone"
                    ? "SELECT time_zone AS value FROM org_profiles"
                    : kind === "root"
                      ? "SELECT lifecycle_version AS value FROM receiving_event_roots"
                      : "SELECT count(*)::int AS value FROM traceability_lots WHERE updated_at>created_at",
              ),
            );
            if (kind === "profile") expect(observed.rows[0]?.value).toBe(7);
            if (kind === "timezone") expect(observed.rows[0]?.value).toBe("America/Chicago");
            if (kind === "root") expect(observed.rows[0]?.value).toBeGreaterThan(2);
            if (kind === "lot") expect(observed.rows[0]?.value).toBeGreaterThan(0);
            return original(...args);
          });
        try {
          const before = await h.f.snapshot();
          const result = await outcome(
            new UsDatasetShippingSeedStore(h.f.db).initializeTerminalProjection(h.context, 0),
          );
          if (kind === "profile") {
            expect(entered).toBe(true);
            expect(result.error).toBeUndefined();
            expect(result.value?.shipping.shipments.length).toBeGreaterThan(0);
            expect(privateProfile).toMatchObject({ retentionYears: 7 });
          } else {
            expect(result.value).toBeUndefined();
            if (kind === "timezone") {
              expect(result.error).toMatchObject({ message: "us_dataset_target_invalid" });
              expect(entered).toBe(true);
              expect(privateProfile).toBeUndefined();
            } else if (kind === "root") {
              expect(driverCode(result.error)).toBe("23514");
              expect(result.error).toMatchObject({
                cause: { message: "Invalid Receiving root transition or allocation" },
              });
              expect(entered).toBe(false);
            } else {
              expect(entered).toBe(true);
              expect(result.error).toMatchObject({
                message: "us_dataset_cases_mismatch",
                cause: {
                  message: "us_dataset_transformation_mismatch",
                  cause: { message: "us_dataset_receiving_mismatch" },
                },
              });
            }
            expect(await h.f.snapshot()).toEqual(before);
          }
        } finally {
          spy.mockRestore();
          profileSpy.mockRestore();
          await h.f.pool.query(`DROP TRIGGER ${name} ON traceability_events`);
          await h.f.pool.query(`DROP FUNCTION ${name}()`);
        }
      }),
    );
    it(
      "rejects pending verify without writes",
      h.phase(async () => {
        const before = await h.f.snapshot();
        await expect(
          new UsDatasetShippingSeedStore(h.f.db).verifyTerminalProjection(h.context, 0),
        ).rejects.toThrow("us_dataset_shipping_prerequisite_incomplete");
        expect(await h.f.snapshot()).toEqual(before);
      }),
    );
    it(
      "does not retain fresh Shipping rows without an existing qualifying lock",
      h.phase(async () => {
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        const observation = observeStatements(h.f.pool);
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            const projection = await original(...args);
            const [tx, checked, , , d, mode] = args;
            expect(mode).toBe("fresh");
            const id = projection.shipping.shipments[0]?.created.id;
            if (!id) throw new Error("Missing fresh shipment");
            expect(await d.points.event(tx, checked.tenantId, id)).toMatchObject({
              status: "finalized",
              finalizedBy: checked.actorUserId,
            });
            expect(await d.points.shippingRoot(tx, checked.tenantId, id)).toMatchObject({
              currentEventId: id,
              pendingDraftId: null,
              lifecycleVersion: 2,
            });
            for (const read of [d.points.event, d.points.shippingRoot]) {
              const start = observation.statements.length;
              const first = await read(tx, checked.tenantId, id);
              expect(first).toBeDefined();
              expect(await read(tx, checked.tenantId, id)).toEqual(first);
              const statements = observation.statements.slice(start);
              expect(statements).toHaveLength(2);
              expect(statements[0]).toEqual(statements[1]);
            }
            return projection;
          });
        try {
          await new UsDatasetShippingSeedStore(h.f.db).initializeTerminalProjection(h.context, 0);
        } finally {
          spy.mockRestore();
          observation.close();
        }
      }),
    );
    it(
      "observes immediate application-trigger document drift and rolls back all native work",
      h.phase(async () => {
        const remove = await specialFault(
          h.f,
          "traceability_events",
          "UPDATE",
          "NEW.type='shipping' AND NEW.status='finalized'",
          "P0001",
          true,
        );
        const original = shippingVerification.verifyUsDatasetShippingProjectionCore;
        let enteredAfterTrigger = false;
        const spy = vi
          .spyOn(shippingVerification, "verifyUsDatasetShippingProjectionCore")
          .mockImplementation(async (...args) => {
            const [tx, checked] = args;
            const drift = await tx.execute<{ n: number }>(
              sql`SELECT count(*)::int AS n FROM reference_documents WHERE tenant_id=${checked.tenantId} AND notes='Synthetic trigger drift'`,
            );
            expect(drift.rows[0]?.n).toBeGreaterThan(0);
            enteredAfterTrigger = true;
            return original(...args);
          });
        try {
          const before = await h.f.snapshot();
          await expect(
            new UsDatasetShippingSeedStore(h.f.db).initializeTerminalProjection(h.context, 0),
          ).rejects.toMatchObject({
            message: "us_dataset_cases_mismatch",
            cause: {
              message: "us_dataset_transformation_mismatch",
              cause: { message: "us_dataset_receiving_mismatch" },
            },
          });
          expect(enteredAfterTrigger).toBe(true);
          expect(await h.f.snapshot()).toEqual(before);
        } finally {
          spy.mockRestore();
          await remove();
        }
      }),
    );
    it(
      "does not release a projection on a real deferred receipt COMMIT error",
      h.phase(async () => {
        const name = "closed_commit_" + randomUUID().replaceAll("-", "");
        await h.f.pool.query(
          `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.stage='shipping' AND NEW.receipt IS NOT NULL THEN RAISE EXCEPTION 'closed_terminal_commit_failure' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$`,
        );
        try {
          await h.f.pool.query(
            `CREATE CONSTRAINT TRIGGER ${name} AFTER UPDATE ON traceability_demo_dataset_stages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`,
          );
          try {
            const before = await h.f.snapshot();
            const result = await outcome(
              new UsDatasetShippingSeedStore(h.f.db).initializeTerminalProjection(h.context, 0),
            );
            expect(result.value).toBeUndefined();
            expect(driverCode(result.error)).toBe("P0001");
            expect(await h.f.snapshot()).toEqual(before);
          } finally {
            await h.f.pool.query(`DROP TRIGGER ${name} ON traceability_demo_dataset_stages`);
          }
        } finally {
          await h.f.pool.query(`DROP FUNCTION ${name}()`);
        }
      }),
    );
  });
});
