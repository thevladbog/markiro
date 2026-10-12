import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  composeDatasetCases,
  runDatasetCasesFixtureBody,
} from "./support/us-dataset-cases-fixture";
import { verifyUsDatasetCases } from "../src/modules/traceability/demo/us-dataset-cases-verify";
import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { schema } from "@markiro/db";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { parseUsDatasetTransformationResult } from "../src/modules/traceability/demo/us-dataset-transformation-contract";
import { parseUsDatasetReferenceResult } from "../src/modules/traceability/demo/us-dataset-reference-contract";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { prepareDatasetCasesFixture } from "./support/us-dataset-cases-fixture";
import {
  insertUsDatasetCasesSupport,
  readUsDatasetCasesSupport,
} from "../src/modules/traceability/demo/us-dataset-cases-support";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import { driverCode } from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Dataset Cases current verifier", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  type Composition = Awaited<ReturnType<typeof composeDatasetCases>>;
  type Context = Awaited<ReturnType<typeof f.provision>>;
  const replay = (context: Context, c: Composition) =>
    c.stores.journal.runAtomicStage(context, c.datasetId, c.stage.revision, c.intent, {
      apply: async () => {
        throw new Error("completed replay must not apply");
      },
      verify: (tx, checked, intent, receipt) =>
        verifyUsDatasetCases(tx, checked, intent, receipt, "replay", c.stores),
    });
  async function rejected(context: Context, c: Composition) {
    const before = await f.snapshot();
    await expect(replay(context, c)).rejects.toThrow("us_dataset_cases_mismatch");
    expect(await f.snapshot()).toEqual(before);
  }

  it.each([
    [0, 55],
    [133, 75],
    [259, 100],
  ])("preserves exact immutable receipt and physical defaults for chain %i", async (index, count) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        c = await composeDatasetCases(f, context, index);
      expect(c.result.linked.created).toHaveLength(count);
      expect(c.result.linked.unchanged).toEqual([]);
      expect(c.result.support.shift).toMatchObject({
        status: "planned",
        mode: "aggregation",
        numberSeq: index + 1,
      });
      for (const link of c.result.linked.created)
        expect(link).toMatchObject({
          linkSource: "demo_seed",
          linkedBy: context.actorUserId,
          provenance: "synthetic_demo",
          originState: "current",
          ssccState: "consistent",
          unlinkedAt: null,
          unlinkedBy: null,
          unlinkReason: null,
        });
      const before = await f.snapshot();
      expect((await replay(context, c)).receipt).toEqual(c.receipt);
      expect(await f.snapshot()).toEqual(before);
      expect(new Date(c.result.support.shift.createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(c.input.support.capturedAt).getTime(),
      );
      for (const table of [
        "box_items",
        "scan_events",
        "codes",
        "shift_number_counters",
        "sscc_counters",
      ])
        expect(
          (
            await f.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [
              context.tenantId,
            ])
          ).rows,
        ).toEqual([{ n: 0 }]);
    }),
  );

  it.each([
    [
      "shift product",
      "shifts",
      "product_id=(SELECT id FROM products WHERE tenant_id=shifts.tenant_id AND id<>shifts.product_id LIMIT 1)",
      "shift",
    ],
    ["shift status", "shifts", "status='active'", "shift"],
    ["shift physical date", "shifts", "production_date='2026-09-01'", "shift"],
    ["shift pallets", "shifts", "pallets_enabled=true", "shift"],
    ["shift planned quantity", "shifts", "planned_qty=1", "shift"],
    ["shift origin", "shifts", "created_from='station'", "shift"],
    ["shift station owner", "shifts", "station_close_owner_device_id=gen_random_uuid()", "shift"],
    ["shift closure", "shifts", "first_box_closure_at=now()", "shift"],
    ["device identity", "boxes", "device_box_id='changed'", "box"],
    ["box closure", "boxes", "closed_at=now()", "box"],
    ["box closure receipt", "boxes", "closure_received_at=now()", "box"],
    ["print verified", "boxes", "print_verified_at=now()", "box"],
    ["print skipped", "boxes", "print_skipped_at=now()", "box"],
    ["disassembly", "boxes", "disassembled_at=now()", "box"],
    ["box opened clock", "boxes", "opened_at=opened_at + interval '1 second'", "box"],
  ] as const)("rejects allowed-field %s drift without repair", async (_name, table, set, target) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        c = await composeDatasetCases(f, context, 0);
      await f.pool.query(`UPDATE ${table} SET ${set} WHERE tenant_id=$1 AND id=$2`, [
        context.tenantId,
        target === "shift" ? c.input.support.shiftId : c.input.support.boxes[0]?.id,
      ]);
      await rejected(context, c);
    }),
  );

  it.each(["extra owned box", "physical item", "retargeted shift"] as const)(
    "rejects %s using actual constrained rows",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          c = await composeDatasetCases(f, context, 0),
          box = c.input.support.boxes[0];
        if (!box) throw new Error("Missing box");
        if (kind === "extra owned box")
          await f.db.insert(schema.boxes).values({
            tenantId: context.tenantId,
            shiftId: c.input.support.shiftId,
            deviceBoxId: randomUUID(),
          });
        if (kind === "physical item")
          await f.db.insert(schema.boxItems).values({
            tenantId: context.tenantId,
            boxId: box.id,
            codeHash: "0".repeat(64),
            addedAt: new Date(),
          });
        if (kind === "retargeted shift") {
          const id = randomUUID();
          await f.db.insert(schema.shifts).values({
            id,
            tenantId: context.tenantId,
            productId: c.input.outputProductId,
            mode: "aggregation",
            numberMonthKey: c.input.support.numberMonthKey,
            numberSeq: 9000,
          });
          await f.pool.query("UPDATE boxes SET shift_id=$1 WHERE tenant_id=$2 AND id=$3", [
            id,
            context.tenantId,
            box.id,
          ]);
        }
        await rejected(context, c);
      }),
  );

  it.each(["unlink", "relink", "extra active link"] as const)(
    "rejects public %s while preserving all native history",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          c = await composeDatasetCases(f, context, 0),
          cases = new UsCaseStore(f.db),
          first = c.result.linked.created[0];
        if (!first) throw new Error("Missing link");
        if (kind === "extra active link") {
          const shift = randomUUID();
          await f.db.insert(schema.shifts).values({
            id: shift,
            tenantId: context.tenantId,
            productId: c.input.outputProductId,
            mode: "aggregation",
            numberMonthKey: "JAN26",
            numberSeq: 9999,
          });
          await f.db.insert(schema.boxes).values({
            tenantId: context.tenantId,
            shiftId: shift,
            deviceBoxId: randomUUID(),
            sscc: "999999990000001560",
          });
          await cases.link(
            context.tenantId,
            context.actorUserId,
            c.input.outputLotId,
            { operationKey: randomUUID(), ssccs: ["999999990000001560"] },
            "extra-link",
          );
        } else {
          await cases.unlink(
            context.tenantId,
            context.actorUserId,
            c.input.outputLotId,
            first.linkId,
            { operationKey: randomUUID(), reason: "Synthetic public unlink" },
            "public-unlink",
          );
          if (kind === "relink") {
            const replacement = await cases.link(
              context.tenantId,
              context.actorUserId,
              c.input.outputLotId,
              { operationKey: randomUUID(), ssccs: [first.ssccAtLink] },
              "public-relink",
            );
            expect(replacement.created[0]?.linkId).not.toBe(first.linkId);
          }
        }
        await rejected(context, c);
      }),
  );

  it.each(["archive", "void", "pending amendment", "finalized amendment"] as const)(
    "rejects actual %s current origin",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          c = await composeDatasetCases(f, context, 0);
        const upstream = await c.stores.journal.readStage(
          context,
          c.datasetId,
          c.intent.unitKey,
          "transformation",
        );
        if (!upstream?.receipt) throw new Error("Missing upstream");
        const transformation = parseUsDatasetTransformationResult(upstream.receipt.result);
        const args = {
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Synthetic lifecycle drift",
        };
        if (kind === "archive")
          await c.stores.lots.changeStatus(
            context.tenantId,
            context.actorUserId,
            c.input.outputLotId,
            { status: "archived", expectedRevision: 1, reason: args.reason },
            "archive",
          );
        else if (kind === "void")
          await c.stores.transformation.void(
            context.tenantId,
            context.actorUserId,
            transformation.created.id,
            args,
            "void",
          );
        else {
          const amended = await c.stores.transformation.amend(
            context.tenantId,
            context.actorUserId,
            transformation.created.id,
            args,
            "amend",
          );
          if (kind === "finalized amendment") {
            const ready = await c.stores.transformation.checkReadiness(
              context.tenantId,
              context.actorUserId,
              amended.eventId,
              { expectedDraftVersion: 1 },
            );
            expect(ready.state).toBe("complete");
            await c.stores.transformation.finalize(
              context.tenantId,
              context.actorUserId,
              amended.eventId,
              {
                operationKey: randomUUID(),
                expectedDraftVersion: 1,
                expectedInputDigest: ready.inputDigest,
              },
              "finalize",
            );
          }
        }
        await rejected(context, c);
      }),
  );

  it.each(["requestId", "operationKey", "supportClock", "actor", "recordIds"] as const)(
    "rejects rehashed %s receipt",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          c = await composeDatasetCases(f, context, 0);
        const result = {
          ...c.result,
          requestId: kind === "requestId" ? "forged" : c.result.requestId,
          operationKey: kind === "operationKey" ? randomUUID() : c.result.operationKey,
          support: {
            ...c.result.support,
            shift: {
              ...c.result.support.shift,
              createdAt:
                kind === "supportClock"
                  ? "2026-01-01T00:00:00.000Z"
                  : c.result.support.shift.createdAt,
            },
          },
          linked: {
            ...c.result.linked,
            created: c.result.linked.created.map((link) => ({
              ...link,
              linkedBy: kind === "actor" ? randomUUID() : link.linkedBy,
            })),
          },
        };
        const receipt = {
          ...c.receipt,
          result,
          resultDigest: canonicalExportDigest(result),
          recordIds: kind === "recordIds" ? [randomUUID()] : c.receipt.recordIds,
        };
        const before = await f.snapshot();
        await expect(
          f.db.transaction((tx) =>
            verifyUsDatasetCases(tx, context, c.intent, receipt, "replay", c.stores),
          ),
        ).rejects.toThrow("us_dataset_cases_mismatch");
        expect(await f.snapshot()).toEqual(before);
      }),
  );

  it("accepts actual Shipping consumption and mutable box registry clocks without changing receipt bytes", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        c = await composeDatasetCases(f, context, 0),
        shipping = new UsShippingStore(f.db);
      const stage = await c.stores.journal.readStage(
        context,
        c.datasetId,
        "references",
        "references",
      );
      if (!stage?.receipt) throw new Error("Missing references");
      const refs = parseUsDatasetReferenceResult(stage.receipt.result);
      const processor = refs.bindings.locations.find((row) => row.key === "processor")?.id;
      const recipient = refs.bindings.locations.find((row) => row.key.includes("recipient"))?.id;
      const document = await c.stores.documents.createDocument(
        context.tenantId,
        context.actorUserId,
        {
          type: "bol",
          typeOtherLabel: null,
          number: "SYNTHETIC-SHIP-01",
          issuedOn: "2026-09-30",
          partyId: null,
          notes: null,
        },
        "shipping-document",
      );
      const saved = await shipping.createDraft(
        context.tenantId,
        context.actorUserId,
        {
          operationKey: randomUUID(),
          draft: {
            eventDate: "2026-09-30",
            shipFromLocationId: processor,
            recipientLocationId: recipient,
            carrierReference: null,
            notes: "Synthetic downstream",
            items: [{ lotId: c.input.outputLotId, quantity: "1", unitOfMeasure: "case" }],
            documentIds: [document.id],
          },
        },
        "shipping",
      );
      const ready = await shipping.checkReadiness(context.tenantId, context.actorUserId, saved.id, {
        expectedDraftVersion: 1,
      });
      expect(ready.state).toBe("complete");
      await shipping.finalize(
        context.tenantId,
        context.actorUserId,
        saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: ready.inputDigest,
        },
        "shipping-finalize",
      );
      expect(
        await shipping.getLotShippingBalance(
          context.tenantId,
          context.actorUserId,
          c.input.outputLotId,
          {},
        ),
      ).toEqual({
        lotId: c.input.outputLotId,
        originUom: "case",
        balance: {
          state: "known",
          unitOfMeasure: "case",
          supply: "55",
          used: "1",
          remaining: "54",
        },
      });
      await f.pool.query(
        "UPDATE boxes SET registry_version=registry_version+1,updated_at=now() WHERE tenant_id=$1",
        [context.tenantId],
      );
      const before = await f.snapshot();
      expect((await replay(context, c)).receipt).toEqual(c.receipt);
      expect(await f.snapshot()).toEqual(before);
    }));

  it.each([
    "database",
    "foreign tenant",
    "malformed tenant",
    "role",
    "owner",
    "absent header",
  ] as const)("guards %s before reading hostile evidence", async (kind) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      if (kind !== "absent header") await prepareDatasetCasesFixture(f, context, 0);
      if (kind === "role")
        await f.pool.query("UPDATE member SET role='viewer' WHERE user_id=$1", [
          context.actorUserId,
        ]);
      if (kind === "owner")
        await f.pool.query('UPDATE "user" SET name=$1 WHERE id=$2', [
          "changed owner",
          context.actorUserId,
        ]);
      const checked = {
        ...context,
        expectedDatabaseName: kind === "database" ? "wrong_db" : context.expectedDatabaseName,
        tenantId:
          kind === "foreign tenant"
            ? randomUUID()
            : kind === "malformed tenant"
              ? "bad"
              : context.tenantId,
      };
      let touched = false;
      const hostile = {
        get input(): never {
          touched = true;
          throw new Error("hostile evidence");
        },
        unitKey: "chain_0000",
        stage: "cases" as const,
        operationKey: randomUUID(),
        inputDigest: "0".repeat(64),
      };
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          verifyUsDatasetCases(
            tx,
            checked,
            hostile,
            { result: {}, resultDigest: "0".repeat(64), recordIds: [] },
            "replay",
            datasetTransformationStores(f.db),
          ),
        ),
      ).rejects.toThrow(
        kind === "absent header" ? "us_dataset_conflict" : "us_dataset_target_invalid",
      );
      expect(touched).toBe(false);
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it("never adopts support collisions and preserves the raw uniqueness cause", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        p = await prepareDatasetCasesFixture(f, context, 0);
      await f.db.transaction((tx) => insertUsDatasetCasesSupport(tx, context, p.input));
      const before = await f.snapshot();
      const error = await f.db
        .transaction((tx) => insertUsDatasetCasesSupport(tx, context, p.input))
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        message: "us_dataset_cases_conflict",
        cause: expect.any(Error),
      });
      expect(driverCode(error)).toBe("23505");
      expect(await f.snapshot()).toEqual(before);
    }));

  it("rejects missing support without initializing it", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        p = await prepareDatasetCasesFixture(f, context, 0),
        before = await f.snapshot();
      await expect(
        f.db.transaction((tx) => readUsDatasetCasesSupport(tx, context, p.input)),
      ).rejects.toThrow("us_dataset_cases_mismatch");
      expect(await f.snapshot()).toEqual(before);
    }));

  it("propagates unrelated FK driver failure without mapping it to an owned uniqueness conflict", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        p = await prepareDatasetCasesFixture(f, context, 0),
        before = await f.snapshot();
      const error = await f.db
        .transaction((tx) =>
          insertUsDatasetCasesSupport(tx, context, { ...p.input, outputProductId: randomUUID() }),
        )
        .catch((cause: unknown) => cause);
      expect(driverCode(error)).toBe("23503");
      expect(error).not.toMatchObject({ message: "us_dataset_cases_conflict" });
      expect(await f.snapshot()).toEqual(before);
    }));

  it.each([
    ["actor", "actor_user_id=NULL"],
    ["action", "action='changed'"],
    ["outcome", "outcome='failure'"],
    ["target type", "target_type='changed'"],
    ["target", "target_id='changed'"],
    ["before", "before='{}'::jsonb"],
    ["after", "after='{}'::jsonb"],
    ["request", "request_id='changed'"],
    ["clock", "created_at=created_at + interval '1 second'"],
  ])("rejects allowed native audit %s drift", async (_name, set) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        c = await composeDatasetCases(f, context, 0);
      const updated = await f.pool.query(
        `UPDATE tenant_audit_events SET ${set} WHERE organization_id=$1 AND request_id=$2 AND action='case.link'`,
        [context.tenantId, c.result.requestId],
      );
      expect(updated.rowCount).toBe(1);
      await rejected(context, c);
    }),
  );

  it.each(["marker identity", "marker version", "marker deletion", "operation digest"] as const)(
    "retains DB immutability for %s and unchanged verifier evidence",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          c = await composeDatasetCases(f, context, 0),
          before = await f.snapshot();
        const statement =
          kind === "operation digest"
            ? "UPDATE trace_lot_box_operations SET input_digest=repeat('0',64) WHERE tenant_id=$1"
            : kind === "marker deletion"
              ? "DELETE FROM traceability_synthetic_case_origins WHERE tenant_id=$1"
              : `UPDATE traceability_synthetic_case_origins SET ${kind === "marker identity" ? "seed_id='foreign-seed'" : "seed_version=2"} WHERE tenant_id=$1`;
        const failed = await f.pool
          .query(statement, [context.tenantId])
          .catch((error: unknown) => error);
        expect(driverCode(failed)).toBe("23514");
        expect((await replay(context, c)).receipt).toEqual(c.receipt);
        expect(await f.snapshot()).toEqual(before);
      }),
  );

  it.each(["identity", "version", "missing"] as const)(
    "rejects initially wrong marker %s without bypassing immutability",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          p = await prepareDatasetCasesFixture(f, context, 0);
        await f.db.insert(schema.shifts).values({
          id: p.input.support.shiftId,
          tenantId: context.tenantId,
          productId: p.input.outputProductId,
          mode: "aggregation",
          numberMonthKey: p.input.support.numberMonthKey,
          numberSeq: p.input.support.numberSeq,
        });
        await f.db.insert(schema.boxes).values(
          p.input.support.boxes.map((box) => ({
            ...box,
            tenantId: context.tenantId,
            shiftId: p.input.support.shiftId,
          })),
        );
        if (kind !== "missing")
          await f.db.insert(schema.traceabilitySyntheticCaseOrigins).values(
            p.input.support.boxes.map((box) => ({
              tenantId: context.tenantId,
              boxId: box.id,
              seedId: kind === "identity" ? "foreign-seed" : p.datasetId,
              seedVersion: kind === "version" ? 2 : 1,
            })),
          );
        const before = await f.snapshot();
        await expect(
          f.db.transaction((tx) => readUsDatasetCasesSupport(tx, context, p.input)),
        ).rejects.toThrow("us_dataset_cases_mismatch");
        expect(await f.snapshot()).toEqual(before);
      }),
  );

  it("rejects allowed-field device drift without repairing persisted rows", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        c = await composeDatasetCases(f, context, 0);
      await f.pool.query(
        "UPDATE boxes SET terminal_id='unexpected-device' WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, c.input.support.boxes[0]?.id],
      );
      const before = await f.snapshot();
      await expect(
        c.stores.journal.runAtomicStage(context, c.datasetId, c.stage.revision, c.intent, {
          apply: async () => {
            throw new Error("completed replay must not apply");
          },
          verify: (tx, checked, intent, receipt) =>
            verifyUsDatasetCases(tx, checked, intent, receipt, "replay", c.stores),
        }),
      ).rejects.toThrow("us_dataset_cases_mismatch");
      expect(await f.snapshot()).toEqual(before);
    }));
});
