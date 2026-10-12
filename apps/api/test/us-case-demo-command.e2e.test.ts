import { runDatasetCasesFixtureBody } from "./support/us-dataset-cases-fixture";
import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  datasetCasesFixtureReceipt,
  datasetCasesHttpClient,
  insertDatasetCasesFixtureSupport,
  prepareDatasetCasesFixture,
} from "./support/us-dataset-cases-fixture";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import { prepareUsDatasetCases } from "../src/modules/traceability/demo/us-dataset-cases-prepare";
import {
  caseDemoCommandDigest,
  parseUsDatasetCasesResult,
} from "../src/modules/traceability/demo/us-dataset-cases-contract";
import { driverCode, outcome, withOwnedWork } from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Guarded demo case command", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated database");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  it("creates all 100 demo links through the supplied transaction", async () => {
    return runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const prepared = await prepareDatasetCasesFixture(f, context, 259);
      await expect(
        f.db.transaction(async (tx) => {
          await insertDatasetCasesFixtureSupport(tx, context, prepared.input);
          const nested = vi.spyOn(f.db, "transaction").mockImplementation(() => {
            throw new Error("unexpected nested transaction");
          });
          const poolRead = vi.spyOn(f.db, "select").mockImplementation(() => {
            throw new Error("unexpected independent pool read");
          });
          try {
            return await new UsCaseStore(f.db).linkDemoInTransaction(
              tx,
              context,
              prepared.datasetId,
              prepared.intent.unitKey,
              "owned-demo-command",
            );
          } finally {
            nested.mockRestore();
            poolRead.mockRestore();
          }
        }),
      ).resolves.toMatchObject({
        lotId: prepared.input.outputLotId,
        unchanged: [],
        created: Array.from({ length: 100 }, () => ({
          linkSource: "demo_seed",
          provenance: "synthetic_demo",
        })),
      });
    });
  });
  it("rolls back all persisted tables and preserves the caller's exact primary error", async () => {
    return runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        p = await prepareDatasetCasesFixture(f, context, 259);
      const before = await f.snapshot(),
        primary = new Error("owned demo caller abort");
      await expect(
        f.db.transaction(async (tx) => {
          await prepareUsDatasetCases(
            tx,
            context,
            p.datasetId,
            p.intent.unitKey,
            { mode: "application" },
            datasetTransformationStores(f.db),
          );
          await insertDatasetCasesFixtureSupport(tx, context, p.input);
          const linked = await new UsCaseStore(f.db).linkDemoInTransaction(
            tx,
            context,
            p.datasetId,
            p.intent.unitKey,
            "owned-demo-abort",
          );
          expect(linked.created).toHaveLength(100);
          expect(linked.unchanged).toEqual([]);
          expect(linked.created.every((row) => row.linkSource === "demo_seed")).toBe(true);
          throw primary;
        }),
      ).rejects.toBe(primary);
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it("retains exact demo audit, public provenance, service operation and no-write completed replay", async () => {
    return runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        p = await prepareDatasetCasesFixture(f, context, 0);
      const stores = datasetTransformationStores(f.db),
        service = new UsCaseStore(f.db),
        requestId = "owned-demo-evidence";
      const completed = await stores.journal.runAtomicStage(context, p.datasetId, 1, p.intent, {
        apply: async (tx) => {
          await prepareUsDatasetCases(
            tx,
            context,
            p.datasetId,
            p.intent.unitKey,
            { mode: "application" },
            stores,
          );
          await insertDatasetCasesFixtureSupport(tx, context, p.input);
          const linked = await service.linkDemoInTransaction(
            tx,
            context,
            p.datasetId,
            p.intent.unitKey,
            requestId,
          );
          return datasetCasesFixtureReceipt(tx, context, p.input, p.intent, linked, requestId);
        },
        verify: async (tx, checked, intent, receipt) => {
          await prepareUsDatasetCases(
            tx,
            checked,
            p.datasetId,
            intent.unitKey,
            { mode: "fresh_verification", receipt },
            stores,
          );
        },
      });
      if (!completed.receipt) throw new Error("Missing completed fixture receipt");
      const receipt = completed.receipt;
      const audits = await f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, context.tenantId),
            eq(schema.tenantAuditEvents.requestId, requestId),
          ),
        );
      expect(audits).toHaveLength(1);
      const operation = (
        await f.db
          .select()
          .from(schema.traceLotBoxOperations)
          .where(eq(schema.traceLotBoxOperations.operationKey, p.intent.operationKey))
      )[0];
      if (!operation || !audits[0]) throw new Error("Missing native evidence");
      expect(audits[0]).toEqual({
        id: audits[0].id,
        createdAt: operation.createdAt,
        organizationId: context.tenantId,
        actorUserId: context.actorUserId,
        action: "case.link",
        outcome: "success",
        targetType: "traceability_lot",
        targetId: p.input.outputLotId,
        requestId,
        before: { links: [] },
        after: {
          tenantId: context.tenantId,
          operationKey: p.intent.operationKey,
          lotId: p.input.outputLotId,
          source: "demo_seed",
          result: operation.result,
          seed: {
            datasetId: p.datasetId,
            recipeVersion: "us-processor-six-month-v1",
            recipeDigest: p.input.definitionDigest,
            unitKey: "chain_0000",
            intentDigest: canonicalExportDigest(p.input),
          },
        },
      });
      expect(operation).toMatchObject({
        tenantId: context.tenantId,
        command: "case.link",
        inputDigest: caseDemoCommandDigest(p.input),
        targetId: p.input.outputLotId,
      });
      expect(audits[0].createdAt).toEqual(operation.createdAt);
      const lookup = await service.lookup(context.tenantId, context.actorUserId, {
        sscc: p.input.support.boxes[0]?.sscc,
      });
      expect(JSON.stringify(lookup)).toContain('"linkSource":"demo_seed"');
      expect(JSON.stringify(lookup)).toContain('"provenance":"synthetic_demo"');
      const listed = await service.list(
        context.tenantId,
        context.actorUserId,
        p.input.outputLotId,
        {},
      );
      expect(JSON.stringify(listed)).toContain('"linkSource":"demo_seed"');
      const before = await f.snapshot();
      const replay = await f.db.transaction(async (tx) => {
        await prepareUsDatasetCases(
          tx,
          context,
          p.datasetId,
          p.intent.unitKey,
          { mode: "replay", receipt },
          stores,
        );
        return service.linkDemoInTransaction(
          tx,
          context,
          p.datasetId,
          p.intent.unitKey,
          "different-request",
        );
      });
      expect(replay).toEqual(operation.result);
      expect(await f.snapshot()).toEqual(before);
      await expect(
        service.link(
          context.tenantId,
          context.actorUserId,
          p.input.outputLotId,
          {
            operationKey: p.intent.operationKey,
            ssccs: p.input.support.boxes.map((box) => box.sscc),
          },
          "manual-collision",
        ),
      ).rejects.toMatchObject({ response: { code: "case_operation_conflict" } });
      expect(await f.snapshot()).toEqual(before);
      const changedResult = {
        ...parseUsDatasetCasesResult(receipt.result),
        requestId: "forged receipt request",
      };
      await expect(
        f.db.transaction((tx) =>
          prepareUsDatasetCases(
            tx,
            context,
            p.datasetId,
            p.intent.unitKey,
            {
              mode: "replay",
              receipt: {
                ...receipt,
                result: changedResult,
                resultDigest: canonicalExportDigest(changedResult),
              },
            },
            stores,
          ),
        ),
      ).rejects.toThrow("us_dataset_cases_conflict");
      await expect(
        f.db.transaction((tx) =>
          prepareUsDatasetCases(
            tx,
            context,
            p.datasetId,
            p.intent.unitKey,
            { mode: "fresh_verification", receipt },
            stores,
          ),
        ),
      ).rejects.toThrow("us_dataset_cases_conflict");
      await f.pool.query(
        "UPDATE member SET role='viewer' WHERE organization_id=$1 AND user_id=$2",
        [context.tenantId, context.actorUserId],
      );
      const denied = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          service.linkDemoInTransaction(
            tx,
            context,
            p.datasetId,
            p.intent.unitKey,
            "stale-owner-replay",
          ),
        ),
      ).rejects.toThrow("us_dataset_target_invalid");
      expect(await f.snapshot()).toEqual(denied);
      await f.pool.query("UPDATE member SET role='owner' WHERE organization_id=$1 AND user_id=$2", [
        context.tenantId,
        context.actorUserId,
      ]);
      const first = replay.created[0];
      if (!first) throw new Error("Missing created link");
      await service.unlink(
        context.tenantId,
        context.actorUserId,
        p.input.outputLotId,
        first.linkId,
        { operationKey: randomUUID(), reason: "owned replay drift" },
        "owned-unlink",
      );
      const unlinked = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          service.linkDemoInTransaction(
            tx,
            context,
            p.datasetId,
            p.intent.unitKey,
            "unlinked-demo-replay",
          ),
        ),
      ).rejects.toThrow("us_dataset_cases_conflict");
      expect(await f.snapshot()).toEqual(unlinked);
    });
  });
  it("rejects client-selected source and malformed SSCC sets over strict authenticated HTTP", async () => {
    return runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        p = await prepareDatasetCasesFixture(f, context, 0);
      await withOwnedWork(async (own) => {
        const request = await datasetCasesHttpClient(f, context, own);
        const before = await f.snapshot();
        const valid = {
          operationKey: randomUUID(),
          ssccs: p.input.support.boxes.map((box) => box.sscc),
        };
        for (const body of [
          { ...valid, source: "demo_seed" },
          { ...valid, linkSource: "demo_seed" },
          { ...valid, synthetic: true },
          { ...valid, ssccs: [valid.ssccs[0], valid.ssccs[0]] },
          { ...valid, ssccs: ["malformed"] },
          { ...valid, ssccs: Array.from({ length: 101 }, () => valid.ssccs[0]) },
        ]) {
          const response = await request(p.input.outputLotId, body);
          expect(response.status).toBe(400);
        }
        const after = await f.snapshot();
        for (const table of [
          "trace_lot_boxes",
          "trace_lot_box_operations",
          "tenant_audit_events",
          "boxes",
          "shifts",
          "traceability_demo_dataset_stages",
        ])
          expect(after[table]).toEqual(before[table]);
      });
    });
  });
  it("refuses another seed unit's operation key without adopting its historical result", async () => {
    return runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        first = await prepareDatasetCasesFixture(f, context, 0);
      await f.db.transaction(async (tx) => {
        await insertDatasetCasesFixtureSupport(tx, context, first.input);
        await new UsCaseStore(f.db).linkDemoInTransaction(
          tx,
          context,
          first.datasetId,
          first.intent.unitKey,
          "first-seed",
        );
      });
      const second = await prepareDatasetCasesFixture(f, context, 1);
      await f.pool.query(
        "DELETE FROM traceability_demo_dataset_stages WHERE dataset_id=$1 AND unit_key=$2 AND stage='cases'",
        [first.datasetId, first.intent.unitKey],
      );
      await f.pool.query(
        "UPDATE traceability_demo_dataset_stages SET operation_key=$1 WHERE dataset_id=$2 AND unit_key=$3 AND stage='cases'",
        [first.intent.operationKey, second.datasetId, second.intent.unitKey],
      );
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          new UsCaseStore(f.db).linkDemoInTransaction(
            tx,
            context,
            second.datasetId,
            second.intent.unitKey,
            "seed-collision",
          ),
        ),
      ).rejects.toThrow("us_dataset_cases_conflict");
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it.each([
    "missing_marker",
    "foreign_marker",
    "wrong_box_id",
    "wrong_device",
    "wrong_shift_product",
    "disassembled",
    "manual_history",
  ])("rejects %s without adoption or partial writes", async (mutation) => {
    return runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        p = await prepareDatasetCasesFixture(f, context, 0);
      const before = await f.snapshot();
      await expect(
        f.db.transaction(async (tx) => {
          await insertDatasetCasesFixtureSupport(tx, context, p.input);
          const box = p.input.support.boxes[0];
          if (!box) throw new Error("Missing box");
          if (mutation === "missing_marker")
            await tx
              .delete(schema.traceabilitySyntheticCaseOrigins)
              .where(eq(schema.traceabilitySyntheticCaseOrigins.boxId, box.id));
          if (mutation === "foreign_marker")
            await tx
              .update(schema.traceabilitySyntheticCaseOrigins)
              .set({ seedId: randomUUID() })
              .where(eq(schema.traceabilitySyntheticCaseOrigins.boxId, box.id));
          if (mutation === "wrong_box_id") {
            await tx
              .delete(schema.traceabilitySyntheticCaseOrigins)
              .where(eq(schema.traceabilitySyntheticCaseOrigins.boxId, box.id));
            await tx
              .update(schema.boxes)
              .set({ id: randomUUID() })
              .where(eq(schema.boxes.id, box.id));
          }
          if (mutation === "wrong_device")
            await tx
              .update(schema.boxes)
              .set({ deviceBoxId: randomUUID() })
              .where(eq(schema.boxes.id, box.id));
          if (mutation === "wrong_shift_product") {
            const [other] = await tx
              .select()
              .from(schema.products)
              .where(
                and(
                  eq(schema.products.tenantId, context.tenantId),
                  sql`${schema.products.id} <> ${p.input.outputProductId}`,
                ),
              )
              .limit(1);
            if (!other) throw new Error("Missing other product");
            await tx
              .update(schema.shifts)
              .set({ productId: other.id })
              .where(eq(schema.shifts.id, p.input.support.shiftId));
          }
          if (mutation === "disassembled")
            await tx
              .update(schema.boxes)
              .set({ disassembledAt: new Date() })
              .where(eq(schema.boxes.id, box.id));
          if (mutation === "manual_history")
            await new UsCaseStore(f.db).linkInTransaction(
              tx,
              context.tenantId,
              context.actorUserId,
              p.input.outputLotId,
              { operationKey: randomUUID(), ssccs: p.input.support.boxes.map((b) => b.sscc) },
              "manual-history",
            );
          return new UsCaseStore(f.db).linkDemoInTransaction(
            tx,
            context,
            p.datasetId,
            p.intent.unitKey,
            "denied-demo",
          );
        }),
      ).rejects.toBeDefined();
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it.each(
    ["link", "dependency", "audit", "operation"].flatMap((boundary) =>
      ["40001", "40P01", "23514"].map((code) => ({ boundary, code })),
    ),
  )(
    "rolls back $boundary $code with one attempt and original driver error",
    async ({ boundary, code }) => {
      return runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          p = await prepareDatasetCasesFixture(f, context, 0);
        const before = await f.snapshot();
        await withOwnedWork(async (own) => {
          const name = "owned_demo_failure_" + randomUUID().replaceAll("-", "");
          const table = {
            link: "trace_lot_boxes",
            dependency: "traceability_lots",
            audit: "tenant_audit_events",
            operation: "trace_lot_box_operations",
          }[boundary];
          if (!table) throw new Error("Invalid failure boundary");
          await f.pool.query(`CREATE SEQUENCE ${name}_attempts`);
          own("sequence", () => f.pool.query(`DROP SEQUENCE ${name}_attempts`).then(() => {}));
          await f.pool.query(
            `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('${name}_attempts'); RAISE EXCEPTION 'owned_demo_injected' USING ERRCODE='${code}'; END $$`,
          );
          own("function", () => f.pool.query(`DROP FUNCTION ${name}()`).then(() => {}));
          await f.pool.query(
            `CREATE TRIGGER ${name} BEFORE ${boundary === "dependency" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
          );
          own("trigger", () => f.pool.query(`DROP TRIGGER ${name} ON ${table}`).then(() => {}));
          let observed: unknown;
          const result = await outcome(
            f.db.transaction(async (tx) => {
              await insertDatasetCasesFixtureSupport(tx, context, p.input);
              try {
                return await new UsCaseStore(f.db).linkDemoInTransaction(
                  tx,
                  context,
                  p.datasetId,
                  p.intent.unitKey,
                  "failure",
                );
              } catch (error) {
                observed = error;
                throw error;
              }
            }),
          );
          expect(driverCode(result.error)).toBe(code);
          expect(result.error).toBe(observed);
          expect(
            (await f.pool.query(`SELECT last_value::int AS n FROM ${name}_attempts`)).rows[0]?.n,
          ).toBe(1);
          expect(await f.snapshot()).toEqual(before);
        });
      });
    },
  );
});
