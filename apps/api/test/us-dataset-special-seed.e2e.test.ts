import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { schema } from "@markiro/db";
import { UsProfileStore } from "../src/modules/traceability/profile/us-profile-store";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import { UsReferenceDocumentStore } from "../src/modules/traceability/documents/us-reference-document-store";
import { describe, expect, it, vi } from "vitest";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import {
  parseUsDatasetSpecialResult,
  type UsDatasetSpecialKind,
} from "../src/modules/traceability/demo/us-dataset-special-contract";
import { verifyUsDatasetSpecial } from "../src/modules/traceability/demo/us-dataset-special-verify";
import { applyUsDatasetSpecial } from "../src/modules/traceability/demo/us-dataset-special-apply";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import {
  captureSpecial,
  consumeSpecial,
  corruptSpecial,
  corruptOrphanSupport,
  specialFault,
  specialFixture,
  specialStores,
} from "./support/us-dataset-special-fixture";
const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Special Receiving durable application", { timeout: 30_000 }, () => {
  const h = specialFixture(base);
  const seed = () => new UsDatasetSpecialSeedStore(h.f.db);
  async function completed(kind: UsDatasetSpecialKind) {
    await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
    const result = await seed().initialize(h.context, kind);
    const stores = specialStores(h.f.db);
    const header = await stores.journal.read(h.context);
    if (!header) throw new Error("Missing header");
    const stage = await stores.journal.readStage(
      h.context,
      header.id,
      kind === "correction" ? "correction_0001" : "orphan_0001",
      result.stage,
    );
    if (!stage?.receipt) throw new Error("Missing lifecycle receipt");
    return { result, stores, header, stage, receipt: stage.receipt };
  }
  it(
    "corrects the actual original with retained lots and immutable history",
    h.phase(async () => {
      const { f, context } = h;
      await new UsDatasetReferenceSeedStore(f.db).initialize(context);
      const s = new UsDatasetSpecialSeedStore(f.db);
      const corrected = await s.initialize(context, "correction");
      expect(corrected.stage).toBe("amend_receiving");
      if (
        corrected.stage !== "amend_receiving" ||
        corrected.finalized.record.content.kind !== "finalized" ||
        corrected.original.finalized.record.content.kind !== "finalized"
      )
        throw new Error("Expected actual correction");
      expect(corrected.finalized.record.revision).toBe(2);
      expect(corrected.finalized.record.lifecycle.lifecycleVersion).toBe(4);
      expect(corrected.finalized.record.content.snapshot.items.map((l) => l.quantity)).toEqual([
        "300",
        "400",
      ]);
      expect(
        corrected.original.finalized.record.content.snapshot.items.map((l) => l.quantity),
      ).toEqual(["250", "400"]);
      expect(corrected.lots.map((l) => l.id)).toEqual(corrected.original.lots.map((l) => l.id));
      const before = await f.snapshot();
      expect(await s.initializeReceiving(context, "correction")).toEqual(corrected.original);
      expect(await s.verify(context, "correction")).toEqual(corrected);
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  it(
    "voids the actual orphan and retains source-locked active lots",
    h.phase(async () => {
      const { f, context } = h;
      await new UsDatasetReferenceSeedStore(f.db).initialize(context);
      const s = new UsDatasetSpecialSeedStore(f.db);
      const orphan = await s.initialize(context, "orphan");
      expect(orphan.stage).toBe("void_receiving");
      if (
        orphan.stage !== "void_receiving" ||
        orphan.original.finalized.record.content.kind !== "finalized"
      )
        throw new Error("Expected actual void");
      expect(orphan.voided.record.status).toBe("void");
      expect(
        orphan.original.finalized.record.content.snapshot.items.map((l) => l.quantity),
      ).toEqual(["200", "200"]);
      expect(orphan.lots.map((l) => [l.id, l.status, l.sourceLockedAt])).toEqual(
        orphan.original.lots.map((l) => [l.id, l.status, l.sourceLockedAt]),
      );
      const before = await f.snapshot();
      expect(await s.initializeReceiving(context, "orphan")).toEqual(orphan.original);
      expect(await s.verify(context, "orphan")).toEqual(orphan);
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  it.each(["correction", "orphan"] as const)(
    "has exact actual rows and stage keys for %s",
    h.phase(async (kind) => {
      const { result } = await completed(kind);
      const counts = (
        await h.f.pool.query(
          "SELECT (SELECT count(*)::int FROM receiving_event_roots) roots, (SELECT count(*)::int FROM traceability_events WHERE type='receiving') revisions, (SELECT count(*)::int FROM traceability_lots) lots, (SELECT count(*)::int FROM reference_documents) docs, (SELECT count(*)::int FROM receiving_operations) operations, (SELECT count(*)::int FROM traceability_events WHERE type<>'receiving') downstream, (SELECT count(*)::int FROM boxes) cases, (SELECT count(*)::int FROM trace_lot_boxes) links",
        )
      ).rows;
      expect(counts).toEqual([
        {
          roots: 1,
          revisions: kind === "correction" ? 2 : 1,
          lots: 2,
          docs: 2,
          operations: kind === "correction" ? 5 : 3,
          downstream: 0,
          cases: 0,
          links: 0,
        },
      ]);
      const lifecycleKey =
        result.stage === "amend_receiving"
          ? result.started.operationKey
          : result.voided.operationKey;
      expect(lifecycleKey).not.toBe(result.original.created.operationKey);
      expect(
        (
          await h.f.pool.query(
            "SELECT operation_key,count(*)::int AS n FROM receiving_operations GROUP BY operation_key ORDER BY n",
          )
        ).rows,
      ).toEqual(
        kind === "correction"
          ? [
              { operation_key: result.original.created.operationKey, n: 2 },
              { operation_key: lifecycleKey, n: 3 },
            ]
          : [
              { operation_key: lifecycleKey, n: 1 },
              { operation_key: result.original.created.operationKey, n: 2 },
            ],
      );
      for (const [i, lot] of result.lots.entries()) {
        const basis = await new UsReceivingStore(h.f.db).getLotReceivingBasis(
          h.context.tenantId,
          h.context.actorUserId,
          lot.id,
          { limit: 10, offset: 0 },
        );
        expect(basis.state).toBe(kind === "correction" ? "present" : "missing");
        expect(basis.supportCount).toBe(kind === "correction" ? 1 : 0);
        if (result.stage === "amend_receiving")
          expect(basis.items).toEqual([
            {
              rootId: result.original.created.eventId,
              eventId: result.finalized.eventId,
              eventNumber: result.finalized.record.eventNumber,
              revision: 2,
              lineNos: [i + 1],
            },
          ]);
      }
      const before = await h.f.snapshot();
      expect(Object.keys(before)).toHaveLength(198);
      expect(await seed().initialize(h.context, kind)).toEqual(result);
      expect(await seed().verifyReceiving(h.context, kind)).toEqual(result.original);
      expect(await seed().verify(h.context, kind)).toEqual(result);
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it.each([
    "no dataset",
    "no references",
    "pending references",
    "no original",
    "pending original",
    "pending lifecycle",
  ])(
    "verify has no writes with %s",
    h.phase(async (state) => {
      const stores = specialStores(h.f.db);
      if (state === "no references") await stores.journal.initialize(h.context);
      if (state === "pending references") {
        const header = await stores.journal.initialize(h.context);
        await stores.journal.captureIntent(h.context, header.id, {
          unitKey: "references",
          stage: "references",
          operationKey: randomUUID(),
          input: {},
          inputDigest: canonicalExportDigest({}),
        });
      }
      if (state === "no original")
        await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      if (state === "pending original") await captureSpecial(h.f.db, h.context, "correction");
      if (state === "pending lifecycle")
        await captureSpecial(h.f.db, h.context, "correction", true);
      const before = await h.f.snapshot();
      await expect(seed().verify(h.context, "correction")).rejects.toThrow(
        "us_dataset_special_prerequisite_incomplete",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it.each(["invalid", "CORRECTION", "", null, 0, {}, Symbol("kind")])(
    "rejects hostile kind %s without writes",
    h.phase(async (kind) => {
      await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      const before = await h.f.snapshot();
      await expect(seed().initialize(h.context, kind as UsDatasetSpecialKind)).rejects.toThrow(
        "us_dataset_special_input_invalid",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it.each(["actor", "tenant", "database", "provenance"])(
    "rejects wrong %s before inspecting hostile kind",
    h.phase(async (kind) => {
      await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      const before = await h.f.snapshot();
      let read = 0;
      const hostile = Object.create(null) as UsDatasetSpecialKind;
      Object.defineProperty(hostile, "toString", {
        get() {
          read++;
          throw new Error("getter inspected");
        },
      });
      const context = {
        ...h.context,
        ...(kind === "actor"
          ? { actorUserId: randomUUID() }
          : kind === "tenant"
            ? { tenantId: randomUUID() }
            : kind === "database"
              ? { expectedDatabaseName: "markiro_us_dev" }
              : { expectedDatabaseUser: "postgres" }),
      };
      await expect(seed().initialize(context as typeof h.context, hostile)).rejects.toThrow(
        /us_dataset_(target_invalid|journal_invalid)/,
      );
      expect(read).toBe(0);
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  const faults = [
    ["business", "traceability_events", "INSERT", "NEW.type='receiving'"],
    ["audit", "tenant_audit_events", "INSERT", "NEW.action LIKE 'traceability.receiving.%'"],
    ["operation", "receiving_operations", "INSERT", "true"],
    [
      "receipt",
      "traceability_demo_dataset_stages",
      "UPDATE",
      "NEW.receipt IS NOT NULL AND NEW.stage<>'references'",
    ],
    ["serialization", "receiving_operations", "INSERT", "true"],
    ["deadlock", "receiving_operations", "INSERT", "true"],
    [
      "postwrite canonical drift",
      "tenant_audit_events",
      "INSERT",
      "NEW.action='traceability.receiving.finalized'",
    ],
  ] as const;
  for (const kind of ["correction", "orphan"] as const)
    for (const lifecycle of [false, true]) {
      it.each(faults)(
        `${kind} ${lifecycle ? "lifecycle" : "original"} rolls back %s and recovers exact pending key`,
        h.phase(async (name, table, action, condition) => {
          const c = await captureSpecial(h.f.db, h.context, kind, lifecycle);
          const code = name === "serialization" ? "40001" : name === "deadlock" ? "40P01" : "P0001";
          const selectedCondition =
            lifecycle && kind === "orphan"
              ? table === "traceability_events"
                ? "NEW.status='void'"
                : name === "postwrite canonical drift"
                  ? "NEW.action='traceability.receiving.voided'"
                  : condition
              : condition;
          const selectedAction =
            lifecycle && kind === "orphan" && table === "traceability_events" ? "UPDATE" : action;
          const remove = await specialFault(
            h.f,
            table,
            selectedAction,
            selectedCondition,
            code,
            name === "postwrite canonical drift",
          );
          const call = lifecycle
            ? kind === "correction"
              ? "amendInTransaction"
              : "voidInTransaction"
            : "createDraftCommandInTransaction";
          const spy = vi.spyOn(UsReceivingStore.prototype, call);
          try {
            const before = await h.f.snapshot();
            let caught: unknown;
            try {
              await (lifecycle
                ? seed().initialize(h.context, kind)
                : seed().initializeReceiving(h.context, kind));
            } catch (error) {
              caught = error;
            }
            if (name === "postwrite canonical drift")
              expect(caught).toMatchObject({ message: "us_dataset_special_mismatch" });
            else expect(caught).toMatchObject({ cause: { code, message: "special_sql_fault" } });
            expect(spy).toHaveBeenCalledTimes(1);
            expect(await h.f.snapshot()).toEqual(before);
            expect(
              await c.stores.journal.readStage(
                h.context,
                c.header.id,
                c.stage.unitKey,
                c.stage.stage,
              ),
            ).toEqual(c.stage);
            if (lifecycle)
              expect(await seed().verifyReceiving(h.context, kind)).toEqual(
                parseUsDatasetSpecialResult(c.original?.receipt?.result),
              );
          } finally {
            spy.mockRestore();
            await remove();
          }
          const recovered = lifecycle
            ? await seed().initialize(h.context, kind)
            : await seed().initializeReceiving(h.context, kind);
          const key =
            recovered.stage === "receiving"
              ? recovered.created.operationKey
              : recovered.stage === "amend_receiving"
                ? recovered.started.operationKey
                : recovered.voided.operationKey;
          expect(key).toBe(c.stage.intent.operationKey);
          const before = await h.f.snapshot();
          expect(
            lifecycle
              ? await seed().initialize(h.context, kind)
              : await seed().initializeReceiving(h.context, kind),
          ).toEqual(recovered);
          expect(await h.f.snapshot()).toEqual(before);
        }),
      );
    }
  for (const lifecycle of [false, true])
    it.each(["correction", "orphan"] as const)(
      `reconciles lost acknowledgement after real %s ${lifecycle ? "lifecycle" : "original"} journal commit`,
      h.phase(async (kind) => {
        await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
        const original = UsDatasetJournalStore.prototype.runAtomicStage;
        const failure = new Error("Synthetic lost committed acknowledgement");
        let committed: Awaited<ReturnType<typeof original>> | undefined;
        const spy = vi
          .spyOn(UsDatasetJournalStore.prototype, "runAtomicStage")
          .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
            const value = await original.apply(this, args);
            if (
              args[3].stage ===
              (lifecycle
                ? kind === "correction"
                  ? "amend_receiving"
                  : "void_receiving"
                : "receiving")
            ) {
              committed = value;
              throw failure;
            }
            return value;
          });
        try {
          await expect(
            lifecycle
              ? seed().initialize(h.context, kind)
              : seed().initializeReceiving(h.context, kind),
          ).rejects.toBe(failure);
        } finally {
          spy.mockRestore();
        }
        if (!committed?.receipt) throw new Error("Missing real committed result");
        const before = await h.f.snapshot();
        expect(
          lifecycle
            ? await seed().initialize(h.context, kind)
            : await seed().initializeReceiving(h.context, kind),
        ).toEqual(committed.receipt.result);
        expect(
          lifecycle
            ? await seed().verify(h.context, kind)
            : await seed().verifyReceiving(h.context, kind),
        ).toEqual(committed.receipt.result);
        expect(await h.f.snapshot()).toEqual(before);
      }),
    );
  it.each([
    "document",
    "lot",
    "operation key",
    "reference",
    "predecessor",
    "digest",
    "record IDs",
    "snapshot",
    "quantity",
    "reason",
  ])(
    "rejects forged actual correction %s without writes",
    h.phase(async (field) => {
      const c = await completed("correction");
      const forged = structuredClone(c.result);
      if (
        forged.stage !== "amend_receiving" ||
        forged.finalized.record.content.kind !== "finalized"
      )
        throw new Error("Expected correction");
      if (field === "document") {
        const doc = forged.original.documents[0];
        if (!doc) throw new Error("Missing doc");
        doc.record.id = randomUUID();
      }
      if (field === "lot") {
        const lot = forged.lots[0];
        if (!lot) throw new Error("Missing lot");
        lot.id = randomUUID();
      }
      if (field === "operation key") forged.started.operationKey = randomUUID();
      if (field === "reference")
        Object.assign(forged.input.references, { operationKey: randomUUID() });
      if (field === "predecessor") forged.predecessor.id = randomUUID();
      if (field === "snapshot") forged.finalized.record.content.snapshot.notes = "forged";
      if (field === "quantity") {
        const line = forged.finalized.record.content.snapshot.items[0];
        if (!line) throw new Error("Missing line");
        line.quantity = "301";
      }
      if (field === "reason") forged.finalized.record.lifecycle.amendmentReason = "forged";
      const receipt = {
        ...c.receipt,
        result: forged,
        resultDigest: field === "digest" ? "a".repeat(64) : canonicalExportDigest(forged),
        recordIds: field === "record IDs" ? [randomUUID()] : c.receipt.recordIds,
      };
      const before = await h.f.snapshot();
      await expect(
        h.f.db.transaction((tx) =>
          verifyUsDatasetSpecial(tx, h.context, c.stage.intent, receipt, c.stores),
        ),
      ).rejects.toThrow(
        field === "digest"
          ? "us_demo_receipt_digest_mismatch"
          : /us_dataset_special_(result_invalid|mismatch)/,
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it.each([
    "saved line",
    "immutable snapshot",
    "reason",
    "audit missing",
    "audit altered",
    "operation missing",
    "operation altered",
    "reference archived",
    "lot archived",
    "lot provenance",
    "root pointer",
  ])(
    "rejects actual owned DB drift %s without writes",
    h.phase(async (mutation) => {
      const c = await completed("correction");
      if (c.result.stage !== "amend_receiving") throw new Error("Expected correction");
      const id = c.result.finalized.eventId,
        key = c.result.started.operationKey;
      if (mutation === "saved line")
        await corruptSpecial(
          h.f,
          "receiving_event_items",
          "UPDATE receiving_event_items SET quantity='301' WHERE event_id=$1 AND line_no=1",
          [id],
        );
      if (mutation === "immutable snapshot")
        await corruptSpecial(
          h.f,
          "traceability_events",
          "UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot,'{notes}','\"drift\"'::jsonb) WHERE id=$1",
          [c.result.original.created.eventId],
        );
      if (mutation === "reason")
        await corruptSpecial(
          h.f,
          "traceability_events",
          "UPDATE traceability_events SET amendment_reason='drift' WHERE id=$1",
          [id],
        );
      if (mutation === "audit missing")
        await h.f.pool.query(
          "DELETE FROM tenant_audit_events WHERE request_id=$1 AND action='traceability.receiving.draft_saved'",
          [key],
        );
      if (mutation === "audit altered")
        await h.f.pool.query(
          "UPDATE tenant_audit_events SET target_id=$1 WHERE request_id=$2 AND action='traceability.receiving.draft_saved'",
          [randomUUID(), key],
        );
      if (mutation === "operation missing")
        await h.f.pool.query(
          "DELETE FROM receiving_operations WHERE operation_key=$1 AND command='receiving.save'",
          [key],
        );
      if (mutation === "operation altered")
        await h.f.pool.query(
          "UPDATE receiving_operations SET input_digest=$1 WHERE operation_key=$2 AND command='receiving.save'",
          ["a".repeat(64), key],
        );
      if (mutation === "reference archived")
        await h.f.pool.query("UPDATE reference_documents SET archived_at=now() WHERE id=$1", [
          c.result.original.documents[0]?.record.id,
        ]);
      if (mutation === "lot archived")
        await h.f.pool.query("UPDATE traceability_lots SET status='archived' WHERE id=$1", [
          c.result.lots[0]?.id,
        ]);
      if (mutation === "lot provenance")
        await h.f.pool.query("UPDATE traceability_lots SET updated_by=$1 WHERE id=$2", [
          randomUUID(),
          c.result.lots[0]?.id,
        ]);
      if (mutation === "root pointer")
        await corruptSpecial(
          h.f,
          "receiving_event_roots",
          "UPDATE receiving_event_roots SET current_event_id=$1 WHERE id=$1",
          [c.result.original.created.eventId],
        );
      const before = await h.f.snapshot();
      await expect(seed().verify(h.context, "correction")).rejects.toThrow(
        "us_dataset_special_mismatch",
      );
      await expect(seed().verifyReceiving(h.context, "correction")).rejects.toThrow(
        "us_dataset_special_mismatch",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it.each(["correction", "orphan"] as const)(
    "rejects unowned public transition before planned %s lifecycle",
    h.phase(async (kind) => {
      await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      const initial = await seed().initializeReceiving(h.context, kind);
      const receiving = new UsReceivingStore(h.f.db);
      await receiving.amend(
        h.context.tenantId,
        h.context.actorUserId,
        initial.created.eventId,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Unexpected public amendment",
        },
        "unowned",
      );
      const before = await h.f.snapshot();
      await expect(seed().initializeReceiving(h.context, kind)).rejects.toThrow(
        "us_dataset_special_mismatch",
      );
      await expect(seed().verifyReceiving(h.context, kind)).rejects.toThrow(
        "us_dataset_special_mismatch",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it(
    "accepts genuine correction consumption technical epochs without replay writes",
    h.phase(async () => {
      const c = await completed("correction");
      const beforeTokens = (
        await h.f.pool.query(
          "SELECT id,receiving_basis_version,current_dependency_version FROM traceability_lots WHERE id=ANY($1::uuid[]) ORDER BY id",
          [c.result.lots.map((l) => l.id)],
        )
      ).rows;
      await consumeSpecial(h.f.db, h.context, c.result);
      const afterTokens = (
        await h.f.pool.query(
          "SELECT id,receiving_basis_version,current_dependency_version FROM traceability_lots WHERE id=ANY($1::uuid[]) ORDER BY id",
          [c.result.lots.map((l) => l.id)],
        )
      ).rows;
      expect(afterTokens).not.toEqual(beforeTokens);
      const before = await h.f.snapshot();
      expect(await seed().initialize(h.context, "correction")).toEqual(c.result);
      expect(await seed().verifyReceiving(h.context, "correction")).toEqual(c.result.original);
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it(
    "rejects genuine orphan consumption without persisting an extra draft",
    h.phase(async () => {
      const c = await completed("orphan");
      const before = await h.f.snapshot();
      await expect(consumeSpecial(h.f.db, h.context, c.result)).rejects.toThrow();
      expect(await h.f.snapshot()).toEqual(before);
      expect(await seed().verify(h.context, "orphan")).toEqual(c.result);
    }),
  );
  it(
    "propagates the actual native SQL error object unchanged through journal rollback",
    h.phase(async () => {
      await captureSpecial(h.f.db, h.context, "correction");
      const remove = await specialFault(h.f, "receiving_operations", "INSERT", "true", "40001");
      const actual = UsReceivingStore.prototype.createDraftCommandInTransaction;
      let nativeError: unknown;
      const spy = vi
        .spyOn(UsReceivingStore.prototype, "createDraftCommandInTransaction")
        .mockImplementation(async function (this: UsReceivingStore, ...args) {
          try {
            return await actual.apply(this, args);
          } catch (error) {
            nativeError = error;
            throw error;
          }
        });
      try {
        const before = await h.f.snapshot();
        const caught = await seed()
          .initializeReceiving(h.context, "correction")
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(nativeError).toMatchObject({ cause: { code: "40001" } });
        expect(caught).toBe(nativeError);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await h.f.snapshot()).toEqual(before);
      } finally {
        spy.mockRestore();
        await remove();
      }
    }),
  );
  it.each(["amend", "void"] as const)(
    "rejects actual public %s after completed correction without rewriting history",
    h.phase(async (kind) => {
      const c = await completed("correction");
      if (c.result.stage !== "amend_receiving") throw new Error("Expected correction");
      const receiving = new UsReceivingStore(h.f.db);
      const input = {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 4,
        reason: "Unexpected public transition",
      };
      if (kind === "amend")
        await receiving.amend(
          h.context.tenantId,
          h.context.actorUserId,
          c.result.finalized.eventId,
          input,
          input.operationKey,
        );
      else
        await receiving.void(
          h.context.tenantId,
          h.context.actorUserId,
          c.result.finalized.eventId,
          { ...input, expectedDraftVersion: null },
          input.operationKey,
        );
      const before = await h.f.snapshot();
      await expect(seed().initialize(h.context, "correction")).rejects.toThrow(
        "us_dataset_special_mismatch",
      );
      await expect(seed().verifyReceiving(h.context, "correction")).rejects.toThrow(
        "us_dataset_special_mismatch",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it(
    "rejects descriptor input before evaluating its getter and preserves captured intent",
    h.phase(async () => {
      const c = await captureSpecial(h.f.db, h.context, "correction");
      let calls = 0;
      const input = { ...c.input };
      Object.defineProperty(input, "recipe", {
        enumerable: true,
        get() {
          calls++;
          throw new Error("unsafe getter");
        },
      });
      const before = await h.f.snapshot();
      await expect(
        h.f.db.transaction((tx) =>
          verifyUsDatasetSpecial(
            tx,
            h.context,
            { ...c.stage.intent, input },
            { recordIds: [], result: {}, resultDigest: canonicalExportDigest({}) },
            c.stores,
          ),
        ),
      ).rejects.toThrow("us_demo_json_invalid");
      expect(calls).toBe(0);
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it.each(["document", "lot", "operation", "unowned draft TLC"])(
    "rejects preexisting %s without adoption",
    h.phase(async (kind) => {
      const c = await captureSpecial(h.f.db, h.context, "correction");
      const recipe =
        "initialReceiving" in c.input.recipe
          ? c.input.recipe.initialReceiving
          : c.input.recipe.receiving;
      const bound = (entries: readonly { key: string; id: string }[], key: string) => {
        const id = entries.find((e) => e.key === key)?.id;
        if (!id) throw new Error("Missing fixture binding");
        return id;
      };
      if (kind === "document") {
        const definitions =
          "correctedChain" in c.input.recipe
            ? c.input.recipe.correctedChain.documents
            : c.input.recipe.documents;
        const d = definitions.find((d) => d.input.number === recipe.references[0]);
        if (!d) throw new Error("Missing document");
        await new UsReferenceDocumentStore(h.f.db).createDocument(
          h.context.tenantId,
          h.context.actorUserId,
          { ...d.input, partyId: bound(c.refs.bindings.parties, d.partyKey) },
          randomUUID(),
        );
      } else if (kind === "lot") {
        const line = recipe.lines[0];
        if (!line) throw new Error("Missing line");
        await new UsLotStore(h.f.db).createLot(
          h.context.tenantId,
          h.context.actorUserId,
          {
            productId: bound(c.refs.bindings.products, line.productKey),
            tlc: line.tlc,
            assignmentBasis: "imported",
            source: {
              kind: "location",
              locationId: bound(c.refs.bindings.locations, recipe.previousSourceLocationKey),
            },
          },
          randomUUID(),
        );
      } else {
        const line = recipe.lines[0];
        if (!line) throw new Error("Missing line");
        await new UsReceivingStore(h.f.db).createDraftCommand(
          h.context.tenantId,
          h.context.actorUserId,
          {
            operationKey: kind === "operation" ? c.stage.intent.operationKey : randomUUID(),
            draft: {
              dateReceived: null,
              locationId: null,
              previousSourceLocationId: null,
              receivedAtNote: null,
              notes: null,
              documentIds: [],
              items:
                kind === "operation"
                  ? []
                  : [
                      {
                        productId: bound(c.refs.bindings.products, line.productKey),
                        lotLinkMode: "create_on_finalize",
                        lotId: null,
                        tlc: line.tlc,
                        source: {
                          kind: "location",
                          locationId: bound(
                            c.refs.bindings.locations,
                            recipe.previousSourceLocationKey,
                          ),
                        },
                        quantity: line.quantity,
                        unitOfMeasure: "lb",
                        exemptSupplier: false,
                        exemptReason: null,
                        exemptReceipt: null,
                        supplierLotReference: null,
                        notes: null,
                      },
                    ],
            },
          },
          randomUUID(),
        );
      }
      const before = await h.f.snapshot();
      await expect(seed().initializeReceiving(h.context, "correction")).rejects.toThrow(
        "us_dataset_special_conflict",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it(
    "preserves genuine second-tenant references when target authorization denies it",
    h.phase(async () => {
      await completed("correction");
      const tenantId = randomUUID(),
        actorUserId = randomUUID();
      // Identity fixture only. All native business/reference facts below use their actual services.
      await h.f.db.insert(schema.organization).values({
        id: tenantId,
        name: "Synthetic other tenant",
        slug: tenantId,
        createdAt: new Date(),
      });
      await h.f.db.insert(schema.user).values({
        id: actorUserId,
        name: "Other synthetic owner",
        email: actorUserId + "@example.test",
      });
      await h.f.db.insert(schema.member).values({
        id: randomUUID(),
        organizationId: tenantId,
        userId: actorUserId,
        role: "owner",
        createdAt: new Date(),
      });
      await new UsProfileStore(h.f.db).provision(
        tenantId,
        actorUserId,
        { code: "US_FSMA204_PROCESSOR", timeZone: "America/Los_Angeles" },
        randomUUID(),
      );
      const stores = specialStores(h.f.db);
      const party = await stores.master.createParty(
        tenantId,
        actorUserId,
        { name: "Other tenant supplier" },
        randomUUID(),
      );
      const document = await stores.documents.createDocument(
        tenantId,
        actorUserId,
        {
          type: "bol",
          typeOtherLabel: null,
          number: "Other tenant document",
          issuedOn: "2026-06-10",
          partyId: party.id,
          notes: null,
        },
        randomUUID(),
      );
      const before = await h.f.snapshot();
      await expect(
        seed().initialize({ ...h.context, tenantId, actorUserId }, "correction"),
      ).rejects.toThrow("us_dataset_target_invalid");
      expect(await stores.documents.getDocument(tenantId, actorUserId, document.id)).toEqual(
        document,
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it(
    "rejects altered pending input without recapture or touching owned business",
    h.phase(async () => {
      const c = await captureSpecial(h.f.db, h.context, "correction");
      const input = { ...c.input, definitionDigest: "a".repeat(64) };
      await h.f.pool.query(
        "UPDATE traceability_demo_dataset_stages SET input=$1,input_digest=$2 WHERE dataset_id=$3 AND unit_key='correction_0001' AND stage='receiving'",
        [input, canonicalExportDigest(input), c.header.id],
      );
      const before = await h.f.snapshot();
      await expect(seed().initializeReceiving(h.context, "correction")).rejects.toThrow(
        "us_dataset_special_dependency_conflict",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it(
    "rejects changed reference identity between captured intent and actual callback",
    h.phase(async () => {
      const c = await captureSpecial(h.f.db, h.context, "correction");
      await h.f.pool.query(
        "UPDATE traceability_demo_dataset_stages SET operation_key=$1 WHERE dataset_id=$2 AND stage='references'",
        [randomUUID(), c.header.id],
      );
      const before = await h.f.snapshot();
      await expect(
        c.stores.journal.runAtomicStage(h.context, c.header.id, c.stage.revision, c.stage.intent, {
          apply: (tx, context, intent) => applyUsDatasetSpecial(tx, context, intent, c.stores),
          verify: (tx, context, intent, receipt) =>
            verifyUsDatasetSpecial(tx, context, intent, receipt, c.stores),
        }),
      ).rejects.toThrow("us_dataset_special_dependency_conflict");
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it.each([
    "transformation input",
    "transformation draft input",
    "transformation output",
    "shipping item",
    "shipping draft item",
    "active case",
    "historical case",
    "genealogy input",
    "genealogy output",
  ] as const)(
    "rejects orphan downstream support drift %s through all four replay APIs without writes",
    h.phase(async (kind) => {
      const c = await completed("orphan");
      const lot = c.result.lots[0];
      if (!lot) throw new Error("Missing actual orphan lot");
      await corruptOrphanSupport(h.f, h.context, lot.id, kind);
      const before = await h.f.snapshot();
      expect(Object.keys(before)).toHaveLength(198);
      const errors: unknown[] = [];
      for (const method of [
        "initializeReceiving",
        "verifyReceiving",
        "initialize",
        "verify",
      ] as const) {
        errors.push(
          await seed()
            [method](h.context, "orphan")
            .then(
              () => null,
              (error: unknown) => error,
            ),
        );
        expect(await h.f.snapshot()).toEqual(before);
      }
      expect(errors).toEqual(
        Array.from({ length: 4 }, () =>
          expect.objectContaining({ message: "us_dataset_special_mismatch" }),
        ),
      );
    }),
  );
  it.each([
    "transformation draft input",
    "transformation output",
    "shipping draft item",
    "active case",
    "genealogy input",
    "genealogy output",
  ] as const)(
    "rejects orphan downstream support drift %s before candidate lifecycle receipt commits",
    h.phase(async (kind) => {
      const c = await captureSpecial(h.f.db, h.context, "orphan", true);
      const original = parseUsDatasetSpecialResult(c.original?.receipt?.result);
      if (original.stage !== "receiving" || !original.lots[0])
        throw new Error("Missing actual original");
      await corruptOrphanSupport(h.f, h.context, original.lots[0].id, kind);
      const before = await h.f.snapshot();
      const error = await seed()
        .initialize(h.context, "orphan")
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(error).toMatchObject({ message: "us_dataset_special_mismatch" });
      expect(await h.f.snapshot()).toEqual(before);
      expect(
        await c.stores.journal.readStage(h.context, c.header.id, c.stage.unitKey, c.stage.stage),
      ).toEqual(c.stage);
    }),
  );
});
