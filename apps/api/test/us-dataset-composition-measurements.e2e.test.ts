import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalExportDigest } from "@markiro/domain";
import { beforeEach, describe, expect, it, type TestContext } from "vitest";
import type { UsDatasetReceipt } from "../src/modules/traceability/demo/us-dataset-contract";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import { UsDatasetCorrectedTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-transformation-seed";
import { UsDatasetCorrectedCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-cases-seed";
import { UsDatasetCorrectedShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-shipping-seed";
import { UsDatasetTraceReadinessStageStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness-stage";
import type { UsDatasetTraceReadinessUnit } from "../src/modules/traceability/demo/us-dataset-trace-readiness";
import {
  UsDatasetUnitCompositionStore,
  type UsDatasetUnitCompositionResult,
} from "../src/modules/traceability/demo/us-dataset-unit-composition";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { assertBoundedSyntheticJson } from "../src/modules/traceability/demo/us-demo-journal-contract";
import { countActualQueries } from "./support/us-dataset-query-counter";
import { specialFixture } from "./support/us-dataset-special-fixture";

type Mode = "initialize" | "verify";
type RawStage = {
  dataset_id: string;
  unit_key: string;
  stage: string;
  revision: number;
  operation_key: string;
  input: Readonly<Record<string, unknown>>;
  input_digest: string;
  receipt: UsDatasetReceipt | null;
};
type Event = {
  id: string;
  tenant_id: string;
  root_event_id: string;
  type: string;
  status: string;
  revision: number;
  superseded_by_event_id: string | null;
};
type Root = { kind: string; id: string; current_event_id: string | null; tenant_id: string };
type Lot = { id: string; tenant_id: string; status: string };
type Box = { id: string; tenant_id: string };
type CaseLink = { box_id: string; lot_id: string; tenant_id: string; unlinked_at: string | null };
type CaseOrigin = { box_id: string; tenant_id: string };
type Segment = { label: string; queries: number; durationMs: number; outcome: "pass" | "fail" };

const inventory = [
  ["M01 same-state-regular0-verify", { kind: "regular", index: 0 }, "verify", 1],
  ["M02 same-state-regular0-replay", { kind: "regular", index: 0 }, "initialize", 1],
  ["M03 populated-four-regular0-verify", { kind: "regular", index: 0 }, "verify", 4],
  ["M04 populated-four-regular0-replay", { kind: "regular", index: 0 }, "initialize", 4],
  ["M05 same-state-correction-verify", { kind: "correction" }, "verify", 1],
  ["M06 same-state-correction-replay", { kind: "correction" }, "initialize", 1],
  ["M07 same-state-orphan-verify", { kind: "orphan" }, "verify", 1],
  ["M08 same-state-orphan-replay", { kind: "orphan" }, "initialize", 1],
  ["M09 fresh-regular181", { kind: "regular", index: 181 }, "initialize", 0],
  ["M10 fresh-regular259", { kind: "regular", index: 259 }, "initialize", 0],
  ["M11 fresh-correction", { kind: "correction" }, "initialize", 0],
  ["M12 fresh-orphan", { kind: "orphan" }, "initialize", 0],
] as const satisfies readonly (readonly [string, UsDatasetTraceReadinessUnit, Mode, number])[];
const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("finite dataset composition public-call measurements", () => {
  const h = specialFixture(base);
  let prepared: UsDatasetUnitCompositionResult[] = [];
  beforeEach(
    h.phase(async (test: TestContext) => {
      prepared = [];
      const selected = inventory.find(([name]) => name === test.task.name);
      if (!selected) throw new Error("Unlisted finite measurement");
      const [, unit, , population] = selected;
      const started = performance.now();
      try {
        // Only completed-state preconditions; fresh cases install no dataset prerequisites.
        for (let index = 0; index < population; index++)
          prepared.push(
            await new UsDatasetUnitCompositionStore(h.f.db).initialize(
              h.context,
              unit.kind === "regular" ? { kind: "regular", index } : unit,
            ),
          );
      } finally {
        console.info("M setup only", {
          name: test.task.name,
          elapsedMs: performance.now() - started,
        });
      }
    }),
    60_000,
  );

  async function checkpoint() {
    const snapshot = await h.f.snapshot();
    const stages = (
      await h.f.pool.query<{ row: RawStage }>(
        "SELECT to_jsonb(s) AS row FROM traceability_demo_dataset_stages s ORDER BY unit_key,stage",
      )
    ).rows.map(({ row }) => row);
    const headers = (await h.f.pool.query("SELECT * FROM traceability_demo_datasets")).rows;
    const events = (
      await h.f.pool.query<Event>(
        "SELECT id,tenant_id,root_event_id,type,status,revision,superseded_by_event_id FROM traceability_events ORDER BY id",
      )
    ).rows;
    const lots = (
      await h.f.pool.query<Lot>("SELECT id,tenant_id,status FROM traceability_lots ORDER BY id")
    ).rows;
    const boxes = (await h.f.pool.query<Box>("SELECT id,tenant_id FROM boxes ORDER BY id")).rows;
    const links = (
      await h.f.pool.query<CaseLink>(
        "SELECT box_id,lot_id,tenant_id,unlinked_at FROM trace_lot_boxes ORDER BY box_id",
      )
    ).rows;
    const origins = (
      await h.f.pool.query<CaseOrigin>(
        "SELECT box_id,tenant_id FROM traceability_synthetic_case_origins ORDER BY box_id",
      )
    ).rows;
    const roots = (
      await h.f.pool.query<Root>(
        "SELECT 'receiving' AS kind,id,tenant_id,current_event_id FROM receiving_event_roots UNION ALL SELECT 'transformation' AS kind,id,tenant_id,current_event_id FROM transformation_event_roots UNION ALL SELECT 'shipping' AS kind,id,tenant_id,current_event_id FROM shipping_event_roots ORDER BY kind,id",
      )
    ).rows;
    return { snapshot, stages, headers, events, lots, boxes, links, origins, roots };
  }

  function progress(output: UsDatasetUnitCompositionResult, rows: readonly RawStage[]) {
    const trace = output.trace;
    const saved = rows.find(
      (row) => row.unit_key === trace.unitKey && row.stage === "trace_readiness",
    );
    const predecessorStage = output.kind === "orphan" ? "void_receiving" : "shipping";
    const predecessor = rows.find(
      (row) => row.unit_key === trace.unitKey && row.stage === predecessorStage,
    );
    if (!saved || !predecessor?.receipt) throw new Error("Missing actual progress/predecessor");
    const unit: UsDatasetTraceReadinessUnit =
      output.kind === "regular"
        ? { kind: "regular", index: output.native.index }
        : { kind: output.kind };
    const input = {
      codec: "us-dataset-trace-readiness-stage-v1",
      datasetId: trace.datasetId,
      version: usSixMonthDefinition.version,
      definitionDigest: usSixMonthDefinition.digest,
      unit,
      predecessor: {
        unitKey: trace.unitKey,
        stage: predecessorStage,
        operationKey: predecessor.operation_key,
        inputDigest: predecessor.input_digest,
        resultDigest: predecessor.receipt.resultDigest,
        revision: 2,
      },
    };
    expect(saved.input).toEqual(input);
    expect(saved.input_digest).toBe(canonicalExportDigest(input));
    expect(saved.receipt).toEqual({
      recordIds: [...new Set([...trace.lotIds, ...trace.currentEventIds])],
      resultDigest: canonicalExportDigest(trace),
      result: trace,
    });
  }

  function completeState(
    state: Awaited<ReturnType<typeof checkpoint>>,
    outputs: readonly UsDatasetUnitCompositionResult[],
  ) {
    expect(state.headers).toHaveLength(1);
    const expectedStages = ["references:references"];
    for (const output of outputs) {
      const names =
        output.kind === "orphan"
          ? ["receiving", "void_receiving", "trace_readiness"]
          : output.kind === "correction"
            ? [
                "receiving",
                "amend_receiving",
                "transformation",
                "cases",
                "shipping",
                "trace_readiness",
              ]
            : ["receiving", "transformation", "cases", "shipping", "trace_readiness"];
      expectedStages.push(...names.map((name) => `${output.trace.unitKey}:${name}`));
      progress(output, state.stages);
    }
    expect(state.stages.map((row) => `${row.unit_key}:${row.stage}`).sort()).toEqual(
      expectedStages.sort(),
    );
    for (const row of state.stages) {
      expect(row.dataset_id).toBe(outputs[0]?.trace.datasetId);
      expect(row.revision).toBe(2);
      expect(row.operation_key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(row.input_digest).toBe(canonicalExportDigest(row.input));
      if (!row.receipt) throw new Error("Uncompleted actual stage");
      expect(row.receipt.resultDigest).toBe(canonicalExportDigest(row.receipt.result));
    }
    const lots = outputs.flatMap((output) => [...output.trace.lotIds]);
    const currentEvents = outputs.flatMap((output) => [...output.trace.currentEventIds]);
    expect(new Set(lots).size).toBe(lots.length);
    expect(new Set(currentEvents).size).toBe(currentEvents.length);
    expect(state.lots.map(({ id }) => id).sort()).toEqual(lots.sort());
    expect(
      state.events
        .filter(({ status }) => status === "finalized")
        .map(({ id }) => id)
        .sort(),
    ).toEqual(currentEvents.sort());
    for (const row of [
      ...state.events,
      ...state.lots,
      ...state.roots,
      ...state.boxes,
      ...state.links,
      ...state.origins,
    ])
      expect(row.tenant_id).toBe(h.context.tenantId);
    const orphan = outputs.some((output) => output.kind === "orphan");
    const correction = outputs.some((output) => output.kind === "correction");
    const shippingCount = outputs.reduce(
      (count, output) => count + (output.kind === "orphan" ? 0 : output.native.shipmentCount),
      0,
    );
    expect(state.roots.filter(({ kind }) => kind === "receiving")).toHaveLength(outputs.length);
    expect(state.roots.filter(({ kind }) => kind === "transformation")).toHaveLength(
      outputs.length - Number(orphan),
    );
    expect(state.roots.filter(({ kind }) => kind === "shipping")).toHaveLength(shippingCount);
    expect(
      state.roots
        .flatMap(({ current_event_id }) => (current_event_id === null ? [] : [current_event_id]))
        .sort(),
    ).toEqual([...currentEvents].sort());
    expect(state.events).toHaveLength(currentEvents.length + Number(orphan) + Number(correction));
    expect(state.events.filter(({ status }) => status === "amended")).toHaveLength(
      Number(correction),
    );
    expect(state.events.filter(({ status }) => status === "void")).toHaveLength(Number(orphan));
    const boxes = outputs.reduce(
      (count, output) =>
        count +
        (output.kind === "orphan"
          ? 0
          : output.kind === "correction"
            ? 60
            : output.native.index === 259
              ? 100
              : output.native.index === 181
                ? 75
                : ([55, 65, 50, 70][output.native.index] ?? Number.NaN)),
      0,
    );
    expect(state.boxes).toHaveLength(boxes);
    expect(state.links.map(({ box_id }) => box_id)).toEqual(state.boxes.map(({ id }) => id));
    expect(state.origins.map(({ box_id }) => box_id)).toEqual(state.boxes.map(({ id }) => id));
    for (const link of state.links) {
      expect(link.unlinked_at).toBeNull();
      expect(lots).toContain(link.lot_id);
    }
    if (outputs.length === 4) {
      expect(
        outputs.map((output) => (output.kind === "regular" ? output.native.index : output.kind)),
      ).toEqual([0, 1, 2, 3]);
      expect(state.stages).toHaveLength(21);
      expect(state.lots).toHaveLength(12);
      expect(state.boxes).toHaveLength(240);
      expect(state.roots.filter(({ kind }) => kind === "shipping")).toHaveLength(8);
    }
    console.info("M actual population census", {
      stages: state.stages.length,
      lots: state.lots.length,
      boxes: state.boxes.length,
      shippingRoots: shippingCount,
      events: state.events.length,
    });
  }

  function owned(output: UsDatasetUnitCompositionResult) {
    expect(output.trace.datasetComplete).toBe(false);
    expect(output.trace.state).toBe("trace_readiness_verified");
    expect(output.trace.version).toBe(usSixMonthDefinition.version);
    expect(output.trace.definitionDigest).toBe(usSixMonthDefinition.digest);
    for (const value of [
      output,
      output.native,
      output.trace,
      output.trace.lotIds,
      output.trace.currentEventIds,
      output.trace.evidence,
      ...output.trace.evidence,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    assertBoundedSyntheticJson(output);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(256 * 1024);
  }

  for (const [name, unit, mode, population] of inventory)
    it(
      name,
      h.phase(async (test: TestContext) => {
        const started = performance.now();
        const sourceSha256 = createHash("sha256")
          .update(readFileSync("test/us-dataset-composition-measurements.e2e.test.ts"))
          .digest("hex");
        const segments: Segment[] = [];
        let passed = false;
        async function measure<T>(label: string, run: () => Promise<T>): Promise<T> {
          // Catch inside the unchanged counter so failed dispatch costs survive; rethrow the exact error.
          const measured = await countActualQueries(h.f.pool, async () => {
            try {
              return { ok: true, value: await run() } as const;
            } catch (error) {
              return { ok: false, error } as const;
            }
          });
          const segment: Segment = {
            label,
            queries: measured.count,
            durationMs: measured.durationMs,
            outcome: measured.value.ok && !test.signal.aborted ? "pass" : "fail",
          };
          segments.push(segment);
          console.info("M public-call forwarding", { name, ...segment });
          if (!measured.value.ok) throw measured.value.error;
          if (test.signal.aborted) throw test.signal.reason;
          return measured.value.value;
        }
        try {
          const before = await measure("pre-snapshot-and-census", checkpoint);
          const owner = new UsDatasetUnitCompositionStore(h.f.db);
          const stage = new UsDatasetTraceReadinessStageStore(h.f.db);
          let actual: UsDatasetUnitCompositionResult;
          let expected: UsDatasetUnitCompositionResult;
          let between: Awaited<ReturnType<typeof checkpoint>> | undefined;
          let specialHistory: Event | undefined;
          let orphanRoot: Root | undefined;
          let retainedLots: Lot[] = [];

          async function specialNative(selectedMode: Mode) {
            const prefix = population === 0 ? "oracle" : "standalone";
            const journal = new UsDatasetJournalStore(h.f.db, usSixMonthDefinition);
            await measure(`${prefix}-journal-before`, () => journal.read(h.context));
            await measure(`${prefix}-References`, () =>
              new UsDatasetReferenceSeedStore(h.f.db)[selectedMode](h.context),
            );
            const header = await measure(`${prefix}-journal-header`, () => journal.read(h.context));
            if (!header) throw new Error("Missing real special header");
            expect(header.id).toBe(actual.trace.datasetId);
            if (unit.kind === "regular") throw new Error("Special selector required");
            const lifecycle = await measure(`${prefix}-special-lifecycle`, () =>
              new UsDatasetSpecialSeedStore(h.f.db)[selectedMode](h.context, unit.kind),
            );
            const historical =
              lifecycle.stage === "void_receiving"
                ? lifecycle.voided.record
                : lifecycle.predecessor;
            specialHistory = {
              id: historical.id,
              tenant_id: h.context.tenantId,
              root_event_id: historical.lifecycle.rootId,
              type: "receiving",
              status: unit.kind === "orphan" ? "void" : "amended",
              revision: 1,
              superseded_by_event_id:
                lifecycle.stage === "amend_receiving" ? lifecycle.finalized.eventId : null,
            };
            if (unit.kind === "orphan") {
              if (lifecycle.stage !== "void_receiving")
                throw new Error("Expected actual void lifecycle");
              expect(lifecycle.voided.record.status).toBe("void");
              expect(lifecycle.lots.map(({ status }) => status)).toEqual(["active", "active"]);
              orphanRoot = {
                kind: "receiving",
                id: lifecycle.voided.record.lifecycle.rootId,
                tenant_id: h.context.tenantId,
                current_event_id: null,
              };
              retainedLots = lifecycle.lots.map(({ id, status }) => ({
                id,
                status,
                tenant_id: h.context.tenantId,
              }));
              return {
                kind: "orphan",
                native: {
                  unitKey: "orphan_0001",
                  lifecycleResultDigest: canonicalExportDigest(lifecycle),
                },
              } as const;
            }
            if (lifecycle.stage !== "amend_receiving")
              throw new Error("Expected actual amended lifecycle");
            expect(lifecycle.predecessor.status).toBe("amended");
            expect(lifecycle.predecessor.lifecycle.supersededByEventId).toBe(
              lifecycle.finalized.eventId,
            );
            expect(lifecycle.predecessor.revision).toBe(1);
            expect(lifecycle.finalized.record.revision).toBe(2);
            const transformation = await measure(`${prefix}-corrected-Transformation`, () =>
              new UsDatasetCorrectedTransformationSeedStore(h.f.db)[selectedMode](h.context),
            );
            const cases = await measure(`${prefix}-corrected-Cases`, () =>
              new UsDatasetCorrectedCasesSeedStore(h.f.db)[selectedMode](h.context),
            );
            const shipping = await measure(`${prefix}-corrected-Shipping`, () =>
              new UsDatasetCorrectedShippingSeedStore(h.f.db)[selectedMode](h.context),
            );
            expect(
              transformation.finalized.snapshot.outputs.map(({ quantity }) => quantity),
            ).toEqual(["60"]);
            expect(cases.support.boxes).toHaveLength(60);
            expect(
              shipping.shipments.map(({ finalized }) =>
                finalized.snapshot.items.map(({ quantity }) => quantity),
              ),
            ).toEqual([["50"]]);
            expect(shipping.outputLotAfter.status).toBe("active");
            return {
              kind: "correction",
              native: {
                unitKey: "correction_0001",
                lifecycleResultDigest: canonicalExportDigest(lifecycle),
                transformationResultDigest: canonicalExportDigest(transformation),
                casesResultDigest: canonicalExportDigest(cases),
                shippingResultDigest: canonicalExportDigest(shipping),
                shipmentCount: 1,
              },
            } as const;
          }

          async function independent(selectedMode: Mode): Promise<UsDatasetUnitCompositionResult> {
            if (unit.kind === "regular") {
              const shipping = await measure("oracle-Shipping", () =>
                new UsDatasetShippingSeedStore(h.f.db).verify(h.context, unit.index),
              );
              const facts =
                unit.index === 181
                  ? { quantity: "75", shipped: ["57"], status: "active" }
                  : unit.index === 259
                    ? { quantity: "100", shipped: ["100"], status: "shipped" }
                    : { quantity: "55", shipped: ["22", "23"], status: "active" };
              expect(shipping.input.chain.transformation.output.quantity).toBe(facts.quantity);
              expect(shipping.input.chain.cases).toHaveLength(Number(facts.quantity));
              expect(
                shipping.shipments.map(({ finalized }) =>
                  finalized.snapshot.items.map(({ quantity }) => quantity),
                ),
              ).toEqual(facts.shipped.map((quantity) => [quantity]));
              expect(shipping.outputLotAfter.status).toBe(facts.status);
              const trace = await measure("oracle-inclusive-Trace-stage", () =>
                stage.verify(h.context, unit),
              );
              expect(trace.evidence.map(({ originGap }) => originGap)).toEqual([
                false,
                false,
                false,
              ]);
              return {
                kind: "regular",
                native: {
                  index: unit.index,
                  unitKey: shipping.input.chain.unitKey,
                  shipmentCount: shipping.shipments.length,
                  shippingResultDigest: canonicalExportDigest(shipping),
                },
                trace,
              };
            }
            const native = await specialNative(selectedMode);
            const trace = await measure(
              `${population === 0 ? "oracle" : "standalone"}-inclusive-Trace-stage`,
              () => stage[selectedMode](h.context, unit),
            );
            expect(trace.evidence.map(({ originGap }) => originGap)).toEqual(
              unit.kind === "orphan" ? [true, true] : [false, false, false],
            );
            return { ...native, trace };
          }

          if (population === 0) {
            expect(prepared).toEqual([]);
            expect(before.headers).toEqual([]);
            expect(before.stages).toEqual([]);
            expect(before.lots).toEqual([]);
            expect(before.events).toEqual([]);
            expect(before.roots).toEqual([]);
            expect(before.boxes).toEqual([]);
            expect(before.links).toEqual([]);
            expect(before.origins).toEqual([]);
            actual = await measure("owner-inclusive-fresh-initialize", () =>
              owner.initialize(h.context, unit),
            );
            expected = await independent("verify");
          } else {
            expect(prepared).toHaveLength(population);
            completeState(before, prepared);
            const preparedSelected = prepared[0];
            if (!preparedSelected) throw new Error("Missing prepared completed unit");
            actual = preparedSelected;
            if (unit.kind === "regular") {
              const regular = await measure("standalone-regular-range", () =>
                new UsDatasetRegularSeedStore(h.f.db)[mode](h.context, { startIndex: 0, count: 1 }),
              );
              expect(regular.chains).toHaveLength(1);
              const native = regular.chains[0];
              if (!native) throw new Error("Missing standalone native result");
              expect(native).toMatchObject({ index: 0, unitKey: "chain_0000", shipmentCount: 2 });
              const trace = await measure("standalone-inclusive-Trace-stage", () =>
                stage[mode](h.context, unit),
              );
              expect(trace.lotIds).toHaveLength(3);
              expect(trace.currentEventIds).toHaveLength(4);
              expect(trace.evidence.map(({ originGap }) => originGap)).toEqual([
                false,
                false,
                false,
              ]);
              expected = { kind: "regular", native, trace };
            } else expected = await independent(mode);
            between = await measure("between-snapshot-and-census", checkpoint);
            expect(between).toEqual(before);
            actual = await measure("owner-inclusive-completed-" + mode, () =>
              owner[mode](h.context, unit),
            );
          }
          expect(actual).toEqual(expected);
          owned(actual);
          for (const value of [expected, expected.native, expected.trace])
            expect(value === actual || value === actual.native || value === actual.trace).toBe(
              false,
            );
          const after = await measure("post-snapshot-and-census", checkpoint);
          const historical = specialHistory;
          if (historical)
            expect(after.events.filter(({ id }) => id === historical.id)).toEqual([historical]);
          if (orphanRoot) {
            expect(after.roots).toEqual([orphanRoot]);
            expect(after.lots).toEqual(retainedLots.sort((a, b) => a.id.localeCompare(b.id)));
          }
          const outputs = population === 0 ? [actual] : [actual, ...prepared.slice(1)];
          completeState(after, outputs);
          if (population > 0) {
            expect(after).toEqual(between);
            expect(after).toEqual(before);
            expect(actual).toEqual(prepared[0]);
          }
          passed = true;
        } finally {
          const bodyMs = performance.now() - started;
          const segmentMs = segments.reduce((total, segment) => total + segment.durationMs, 0);
          console.info("M whole body ledger", {
            name,
            mode,
            preparedPopulation: population,
            sourceSha256,
            outcome: passed && !test.signal.aborted ? "pass" : "fail",
            bodyMs,
            queries: segments.reduce((total, segment) => total + segment.queries, 0),
            segmentMs,
            unclassifiedWallMs: bodyMs - segmentMs,
            segments,
          });
        }
      }),
    );
});
