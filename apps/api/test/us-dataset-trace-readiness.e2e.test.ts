import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import { runDatasetCasesFixtureBody } from "./support/us-dataset-cases-fixture";
import { outcome } from "./support/us-transformation-lock-fixture";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetTraceReadinessStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness";
import type { UsDatasetContext } from "../src/modules/traceability/demo/us-dataset-contract";
import type { UsDatasetTraceReadinessUnit } from "../src/modules/traceability/demo/us-dataset-trace-readiness";
import { UsTraceStore } from "../src/modules/traceability/trace/us-trace-store";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { UsDatasetSpecialChainsSeedStore } from "../src/modules/traceability/demo/us-dataset-special-chains-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetReceivingSeedStore } from "../src/modules/traceability/demo/us-dataset-receiving-seed";
import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { checkDatasetTraceEvidence } from "../src/modules/traceability/demo/us-dataset-trace-readiness-evidence";
import { UsDatasetTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-transformation-seed";
import { UsDatasetCorrectedTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-transformation-seed";
import { UsDatasetCorrectedShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-shipping-seed";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("native dataset unit trace/readiness", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let setup: ReturnType<typeof outcome<typeof f>> | undefined;
  let context: UsDatasetContext;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US URL");
    setup = outcome(createUsDatasetJournalFixture(base));
    const ready = await setup;
    if (ready.error !== undefined) throw ready.error;
    if (!ready.value) throw new Error("Missing owned fixture");
    f = ready.value;
  }, 60000);
  beforeEach(
    async () =>
      runDatasetCasesFixtureBody(async () => {
        context = await f.provision();
      }),
    60000,
  );
  afterAll(async () => {
    const ready = await setup;
    await ready?.value?.close();
  }, 60000);

  // Missing traversal, false completion or writes fail observable native evidence.
  it(
    "verifies completed regular chain 0 without writes",
    async () =>
      runDatasetCasesFixtureBody(async () => {
        await new UsDatasetRegularSeedStore(f.db).initialize(context, { startIndex: 0, count: 1 });
        const before = await f.snapshot();
        const result = await new UsDatasetTraceReadinessStore(f.db).verify(context, {
          kind: "regular",
          index: 0,
        });
        expect(result).toMatchObject({
          unitKey: "chain_0000",
          state: "trace_readiness_verified",
          datasetComplete: false,
        });
        expect(result.lotIds).toHaveLength(3);
        expect(result.currentEventIds).toHaveLength(4);
        expect(result.evidence.every((row) => row.originGap === false)).toBe(true);
        const trace = new UsTraceStore(f.db);
        for (const lotId of result.lotIds) {
          const graph = await trace.read(context.tenantId, context.actorUserId, lotId, {});
          expect(
            graph.edges
              .map(({ kind, quantity, unitOfMeasure }) => [kind, quantity, unitOfMeasure])
              .sort(),
          ).toEqual(
            [
              ["receiving", "300", "lb"],
              ["receiving", "400", "lb"],
              ["transformation_input", "300", "lb"],
              ["transformation_input", "400", "lb"],
              ["transformation_output", "55", "case"],
              ["shipping", "22", "case"],
              ["shipping", "23", "case"],
            ].sort(),
          );
          const { assessedAt, ...readiness } = await trace.readiness(
            context.tenantId,
            context.actorUserId,
            { eventDateFrom: "2026-04-01", eventDateTo: "2026-09-30", lotId },
          );
          void assessedAt;
          const output = lotId === result.lotIds[2];
          expect(readiness.recordsChecked).toEqual({ events: output ? 3 : 2, lots: 3 });
          expect(readiness.dependenciesChecked).toBe(output ? 4 : 2);
          const history = await trace.history(context.tenantId, context.actorUserId, lotId, {
            limit: "100",
          });
          expect(result.evidence.find((row) => row.lotId === lotId)).toEqual({
            lotId,
            originGap: false,
            traceDigest: canonicalExportDigest(graph),
            readinessDigest: canonicalExportDigest(readiness),
            historyDigest: canonicalExportDigest(history),
          });
        }
        const shipping = await new UsDatasetShippingSeedStore(f.db).verify(context, 0);
        const receiving = await new UsDatasetReceivingSeedStore(f.db).verify(context, 0);
        const transformation = await new UsDatasetTransformationSeedStore(f.db).verify(context, 0);
        expect(result.lotIds).toEqual([
          ...receiving.lots.map((lot) => lot.id),
          transformation.outputLot.id,
        ]);
        expect(result.currentEventIds).toEqual([
          receiving.finalized.eventId,
          transformation.finalized.id,
          ...shipping.shipments.map((shipment) => shipment.finalized.id),
        ]);
        expect(shipping.outputLotAfter.status).toBe("active");
        const firstTime = await trace.readiness(context.tenantId, context.actorUserId, {
          eventDateFrom: "2026-04-01",
          eventDateTo: "2026-09-30",
          lotId: result.lotIds[0],
        });
        const repeated = await new UsDatasetTraceReadinessStore(f.db).verify(context, {
          kind: "regular",
          index: 0,
        });
        expect(repeated).toEqual(result);
        expect(repeated).not.toBe(result);
        expect(repeated.lotIds).not.toBe(result.lotIds);
        const nextTime = await trace.readiness(context.tenantId, context.actorUserId, {
          eventDateFrom: "2026-04-01",
          eventDateTo: "2026-09-30",
          lotId: result.lotIds[0],
        });
        expect(nextTime.assessedAt > firstTime.assessedAt).toBe(true);
        for (const value of [
          result,
          result.lotIds,
          result.currentEventIds,
          result.evidence,
          ...result.evidence,
        ])
          expect(Object.isFrozen(value)).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024);
        expect(await f.snapshot()).toEqual(before);
        console.info("Trace/readiness no-write snapshot", {
          tables: Object.keys(before).length,
          hash: canonicalExportDigest(before),
        });
      }),
    30000,
  );

  it.each([
    {
      index: 1,
      receiving: ["325.5", "425"],
      output: "65",
      shipping: ["26", "39"],
      events: 4,
      status: "shipped",
    },
    {
      index: 259,
      receiving: ["500", "500"],
      output: "100",
      shipping: ["100"],
      events: 3,
      status: "shipped",
    },
  ])(
    "verifies chain $index exact native lines",
    async (want) =>
      runDatasetCasesFixtureBody(async () => {
        await new UsDatasetRegularSeedStore(f.db).initialize(context, {
          startIndex: want.index,
          count: 1,
        });
        const before = await f.snapshot();
        const result = await new UsDatasetTraceReadinessStore(f.db).verify(context, {
          kind: "regular",
          index: want.index,
        });
        expect(result.lotIds).toHaveLength(3);
        expect(result.currentEventIds).toHaveLength(want.events);
        const outputLotId = result.lotIds[2];
        if (!outputLotId) throw new Error("Missing output lot");
        const graph = await new UsTraceStore(f.db).read(
          context.tenantId,
          context.actorUserId,
          outputLotId,
          {},
        );
        expect(
          graph.edges
            .filter((e) => e.kind === "receiving")
            .map((e) => e.quantity)
            .sort(),
        ).toEqual([...want.receiving].sort());
        expect(
          graph.edges
            .filter((e) => e.kind === "transformation_input")
            .map((e) => e.quantity)
            .sort(),
        ).toEqual([...want.receiving].sort());
        expect(
          graph.edges.filter((e) => e.kind === "transformation_output").map((e) => e.quantity),
        ).toEqual([want.output]);
        expect(
          graph.edges
            .filter((e) => e.kind === "shipping")
            .map((e) => e.quantity)
            .sort(),
        ).toEqual([...want.shipping].sort());
        expect(
          (await new UsDatasetShippingSeedStore(f.db).verify(context, want.index)).outputLotAfter
            .status,
        ).toBe(want.status);
        expect(await f.snapshot()).toEqual(before);
      }),
    30000,
  );

  it(
    "verifies amended current revision and actual excluded history",
    async () =>
      runDatasetCasesFixtureBody(async () => {
        await new UsDatasetSpecialChainsSeedStore(f.db).initialize(context);
        const corrected = await new UsDatasetSpecialSeedStore(f.db).verify(context, "correction");
        if (corrected.stage !== "amend_receiving") throw new Error("Missing corrected fixture");
        const before = await f.snapshot();
        const result = await new UsDatasetTraceReadinessStore(f.db).verify(context, {
          kind: "correction",
        });
        expect(result.currentEventIds).toContain(corrected.finalized.eventId);
        expect(result.currentEventIds).not.toContain(corrected.predecessor.id);
        expect(result.lotIds).toHaveLength(3);
        for (const lot of corrected.lots) {
          const history = await new UsTraceStore(f.db).history(
            context.tenantId,
            context.actorUserId,
            lot.id,
            {},
          );
          expect(history.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                eventId: corrected.predecessor.id,
                status: "amended",
                nextRevisionId: corrected.finalized.eventId,
              }),
            ]),
          );
        }
        const transformation = await new UsDatasetCorrectedTransformationSeedStore(f.db).verify(
          context,
        );
        const shipping = await new UsDatasetCorrectedShippingSeedStore(f.db).verify(context);
        expect(result.lotIds).toEqual([
          ...corrected.lots.map((lot) => lot.id),
          transformation.outputLot.id,
        ]);
        expect(result.currentEventIds).toEqual([
          corrected.finalized.eventId,
          transformation.finalized.id,
          ...shipping.shipments.map((shipment) => shipment.finalized.id),
        ]);
        expect(
          await new UsDatasetTraceReadinessStore(f.db).verify(context, { kind: "correction" }),
        ).toEqual(result);
        expect(await f.snapshot()).toEqual(before);
      }),
    30000,
  );

  it(
    "retains both orphan lots, void history and missing-origin readiness",
    async () =>
      runDatasetCasesFixtureBody(async () => {
        await new UsDatasetReferenceSeedStore(f.db).initialize(context);
        const orphan = await new UsDatasetSpecialSeedStore(f.db).initialize(context, "orphan");
        if (orphan.stage !== "void_receiving") throw new Error("Missing void fixture");
        const before = await f.snapshot();
        const result = await new UsDatasetTraceReadinessStore(f.db).verify(context, {
          kind: "orphan",
        });
        expect(result.lotIds).toEqual(orphan.lots.map((l) => l.id));
        expect(result.currentEventIds).toEqual([]);
        expect(result.evidence.map((row) => row.originGap)).toEqual([true, true]);
        for (const lotId of result.lotIds) {
          const trace = new UsTraceStore(f.db);
          const r = await trace.readiness(context.tenantId, context.actorUserId, {
            eventDateFrom: "2026-04-01",
            eventDateTo: "2026-09-30",
            lotId,
          });
          expect(r.findings.map(({ code, lotId }) => ({ code, lotId }))).toEqual([
            { code: "origin_gap", lotId },
          ]);
          expect(r.recordsChecked).toEqual({ events: 0, lots: 1 });
          expect(r.dependenciesChecked).toBe(0);
          expect(r.findings[0]?.relatedEventId).toBe(orphan.voided.eventId);
          const lot = orphan.lots.find((row) => row.id === lotId);
          if (!lot) throw new Error("Missing retained lot");
          const graph = await trace.read(context.tenantId, context.actorUserId, lotId, {});
          const history = await trace.history(context.tenantId, context.actorUserId, lotId, {});
          const expected = {
            lots: orphan.lots,
            events: [],
            edges: [],
            history: {
              eventId: orphan.voided.eventId,
              rootId: orphan.voided.record.lifecycle.rootId,
              status: "void" as const,
              nextRevisionId: null,
              reason: orphan.voided.record.lifecycle.voidReason,
              eventNumber: orphan.voided.record.eventNumber,
              revision: orphan.voided.record.revision,
            },
          };
          expect(() =>
            checkDatasetTraceEvidence("orphan_0001", lot, expected, graph, r, history),
          ).not.toThrow();
          // Every mutation starts from actual native evidence that the checker accepts.
          for (const kind of [
            "related_event",
            "severity",
            "field",
            "counts",
            "group_cte",
            "group_product",
            "group_severity",
            "event_identity",
            "line_identity",
            "related_metadata",
            "message",
            "link",
            "key",
            "product",
            "draft_items",
            "draft_more",
          ] as const) {
            const changed = structuredClone(r);
            const finding = changed.findings[0];
            if (!finding) throw new Error("Missing native origin gap");
            if (kind === "related_event") finding.relatedEventId = randomUUID();
            if (kind === "severity") finding.severity = "warning";
            if (kind === "field") finding.field = "lot.source";
            if (kind === "counts") changed.counts.error++;
            if (kind === "group_cte") changed.groups.byCte = [];
            if (kind === "group_product") changed.groups.byProduct = [];
            if (kind === "group_severity") changed.groups.bySeverity = [];
            if (kind === "event_identity") finding.eventId = orphan.voided.eventId;
            if (kind === "line_identity") finding.lineNo = 1;
            if (kind === "related_metadata")
              finding.relatedEvent = {
                type: "receiving",
                eventNumber: "Wrong excluded event",
                revision: 999,
              };
            if (kind === "message") finding.message.key = "readiness.required_kde";
            if (kind === "link") finding.links.relatedEventHref = "/traceability/events/wrong";
            if (kind === "key") finding.key = "unrelated_readiness_finding";
            if (kind === "product") finding.productId = randomUUID();
            if (kind === "draft_more") changed.draftWork.hasMore = true;
            if (kind === "draft_items")
              changed.draftWork.items = [
                {
                  eventId: orphan.voided.eventId,
                  rootId: orphan.voided.eventId,
                  cte: "receiving",
                  eventNumber: orphan.voided.record.eventNumber,
                  revision: 1,
                  eventDate: null,
                  eventHref: "/traceability/receiving/wrong",
                  readinessHref: "/traceability/receiving/wrong/readiness",
                },
              ];
            expect
              .soft(
                () =>
                  checkDatasetTraceEvidence("orphan_0001", lot, expected, graph, changed, history),
                kind,
              )
              .toThrow("us_dataset_trace_readiness_mismatch");
          }
          expect(() =>
            checkDatasetTraceEvidence("orphan_0001", lot, expected, graph, r, {
              items: [],
              nextCursor: null,
            }),
          ).toThrow("us_dataset_trace_readiness_mismatch");
          const wrongHistory = structuredClone(history);
          const item = wrongHistory.items[0];
          if (!item) throw new Error("Missing void history");
          item.status = "amended";
          expect(() =>
            checkDatasetTraceEvidence("orphan_0001", lot, expected, graph, r, wrongHistory),
          ).toThrow("us_dataset_trace_readiness_mismatch");
          expect(() =>
            checkDatasetTraceEvidence(
              "orphan_0001",
              lot,
              expected,
              graph,
              { ...r, findings: [] },
              history,
            ),
          ).toThrow("us_dataset_trace_readiness_mismatch");
        }
        expect(
          await new UsDatasetTraceReadinessStore(f.db).verify(context, { kind: "orphan" }),
        ).toEqual(result);
        expect(await f.snapshot()).toEqual(before);
      }),
    30000,
  );

  it(
    "rejects missing prerequisites and hostile selectors without initialization",
    async () =>
      runDatasetCasesFixtureBody(async () => {
        const store = new UsDatasetTraceReadinessStore(f.db);
        const before = await f.snapshot();
        for (const malformed of [
          null,
          {},
          { kind: "regular", index: -0 },
          { kind: "regular", index: -1 },
          { kind: "regular", index: 260 },
          { kind: "regular", index: 0.5 },
          { kind: "regular", index: 0, extra: true },
          { kind: "correction", index: 0 },
          { kind: "orphan", extra: true },
        ]) {
          await expect(
            store.verify(context, malformed as UsDatasetTraceReadinessUnit),
          ).rejects.toThrow();
        }
        await expect(store.verify(context, { kind: "regular", index: 0 })).rejects.toMatchObject({
          message: "us_dataset_trace_readiness_prerequisite_incomplete",
        });
        expect(await f.snapshot()).toEqual(before);
        await new UsDatasetReferenceSeedStore(f.db).initialize(context);
        await new UsDatasetReceivingSeedStore(f.db).initialize(context, 0);
        const incomplete = await f.snapshot();
        await expect(store.verify(context, { kind: "regular", index: 0 })).rejects.toThrow();
        await expect(store.verify(context, { kind: "correction" })).rejects.toThrow();
        await expect(store.verify(context, { kind: "orphan" })).rejects.toThrow();
        expect(await f.snapshot()).toEqual(incomplete);
      }),
    30000,
  );

  it(
    "authorizes target, tenant and original owner before selector interpretation",
    async () =>
      runDatasetCasesFixtureBody(async () => {
        await new UsDatasetRegularSeedStore(f.db).initialize(context, { startIndex: 0, count: 1 });
        const before = await f.snapshot();
        const store = new UsDatasetTraceReadinessStore(f.db);
        for (const denied of [
          { ...context, tenantId: randomUUID() },
          { ...context, actorUserId: randomUUID() },
          { ...context, expectedDatabaseName: "markiro_us_dev" },
          { ...context, expectedDatabaseUser: "postgres" },
        ]) {
          await expect(
            store.verify(denied as UsDatasetContext, { kind: "regular", index: -1 }),
          ).rejects.toMatchObject({ message: "us_dataset_target_invalid" });
        }
        const alternate = await f.alternateRole();
        await expect(
          new UsDatasetTraceReadinessStore(alternate).verify(context, {
            kind: "regular",
            index: 0,
          }),
        ).rejects.toMatchObject({ message: "us_dataset_target_invalid" });
        expect(await f.snapshot()).toEqual(before);
      }),
    30000,
  );

  it(
    "rejects actual shipping lifecycle drift and performs no repair",
    async () =>
      runDatasetCasesFixtureBody(async () => {
        await new UsDatasetRegularSeedStore(f.db).initialize(context, { startIndex: 0, count: 1 });
        const shipping = await new UsDatasetShippingSeedStore(f.db).verify(context, 0);
        const first = shipping.shipments[0];
        if (!first) throw new Error("Missing shipment");
        await new UsShippingStore(f.db).void(
          context.tenantId,
          context.actorUserId,
          first.finalized.id,
          {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            reason: "Owned synthetic lifecycle drift",
          },
          "owned-trace-drift",
        );
        const before = await f.snapshot();
        await expect(
          new UsDatasetTraceReadinessStore(f.db).verify(context, { kind: "regular", index: 0 }),
        ).rejects.toThrow();
        expect(await f.snapshot()).toEqual(before);
      }),
    30000,
  );

  // Changes that accept incomplete or unrelated evidence must fail even with sound native prerequisites.
  it(
    "rejects limited/unrelated/quantity/count evidence independently of native prerequisite checks",
    async () =>
      runDatasetCasesFixtureBody(async () => {
        await new UsDatasetRegularSeedStore(f.db).initialize(context, { startIndex: 0, count: 1 });
        const receiving = await new UsDatasetReceivingSeedStore(f.db).verify(context, 0);
        const shipping = await new UsDatasetShippingSeedStore(f.db).verify(context, 0);
        const lot = receiving.lots[0];
        if (!lot) throw new Error("Missing input lot");
        const store = new UsTraceStore(f.db);
        const graph = await store.read(context.tenantId, context.actorUserId, lot.id, {});
        const readiness = await store.readiness(context.tenantId, context.actorUserId, {
          eventDateFrom: "2026-04-01",
          eventDateTo: "2026-09-30",
          lotId: lot.id,
        });
        const history = await store.history(context.tenantId, context.actorUserId, lot.id, {});
        // Real service evidence supplies identities; hand-checked lines above independently pin quantities.
        const expected = {
          lots: [...receiving.lots, shipping.originLot],
          events: graph.currentEvents,
          edges: graph.edges.map(
            ({ kind, from, to, eventId, lineNo, quantity, unitOfMeasure }) => ({
              kind,
              from,
              to,
              eventId,
              lineNo,
              quantity,
              unitOfMeasure,
            }),
          ),
          history: null,
        };
        expect(() =>
          checkDatasetTraceEvidence("chain_0000", lot, expected, graph, readiness, history),
        ).not.toThrow();
        const before = await f.snapshot();
        for (const kind of [
          "limit",
          "quantity",
          "event",
          "lot",
          "dependency_count",
          "event_count",
          "lot_count",
          "scope",
          "counts",
          "groups_cte",
          "groups_product",
          "groups_severity",
        ] as const) {
          const g = structuredClone(graph),
            r = structuredClone(readiness);
          if (kind === "limit")
            g.completion = {
              state: "limited",
              limit: "nodes",
              returnedNodes: g.nodes.length,
              returnedEdges: g.edges.length,
            };
          if (kind === "quantity") {
            const edge = g.edges[0];
            if (!edge) throw new Error("Missing real edge");
            edge.quantity = "999";
          }
          if (kind === "event") {
            const event = g.currentEvents[0];
            if (!event) throw new Error("Missing real event");
            g.currentEvents.push({ ...event, id: randomUUID() });
          }
          if (kind === "lot")
            g.nodes.push({
              id: "lot:00000000-0000-4000-8000-000000000000",
              kind: "lot",
              lotId: "00000000-0000-4000-8000-000000000000",
              tlc: "Unrelated synthetic lot",
            });
          if (kind === "dependency_count") r.dependenciesChecked++;
          if (kind === "event_count") r.recordsChecked.events++;
          if (kind === "lot_count") r.recordsChecked.lots++;
          if (kind === "scope") r.scope.eventDateFrom = "2026-05-01";
          if (kind === "counts") r.counts.error++;
          if (kind === "groups_cte") r.groups.byCte = [{ cte: null, count: 1 }];
          if (kind === "groups_product")
            r.groups.byProduct = [{ productId: lot.productId, count: 1 }];
          if (kind === "groups_severity") r.groups.bySeverity = [{ severity: "error", count: 1 }];
          expect
            .soft(() => checkDatasetTraceEvidence("chain_0000", lot, expected, g, r, history), kind)
            .toThrow("us_dataset_trace_readiness_mismatch");
        }
        expect(await f.snapshot()).toEqual(before);
      }),
    30000,
  );
});
