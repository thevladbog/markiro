import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "./us-demo-canonical.js";
import { z } from "zod";
import { UsTraceStore } from "../trace/us-trace-store.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { UsDatasetReferenceSeedStore } from "./us-dataset-reference-seed.js";
import { datasetReferenceError } from "./us-dataset-reference-contract.js";
import { UsDatasetReceivingSeedStore } from "./us-dataset-receiving-seed.js";
import { UsDatasetTransformationSeedStore } from "./us-dataset-transformation-seed.js";
import { UsDatasetCasesSeedStore } from "./us-dataset-cases-seed.js";
import { UsDatasetShippingSeedStore } from "./us-dataset-shipping-seed.js";
import type { UsDatasetRegularResult } from "./us-dataset-regular-contract.js";
import { UsDatasetSpecialSeedStore } from "./us-dataset-special-seed.js";
import { UsDatasetCorrectedTransformationSeedStore } from "./us-dataset-corrected-transformation-seed.js";
import { UsDatasetCorrectedCasesSeedStore } from "./us-dataset-corrected-cases-seed.js";
import { UsDatasetCorrectedShippingSeedStore } from "./us-dataset-corrected-shipping-seed.js";
import type { UsDatasetSpecialChainsResult } from "./us-dataset-special-chains-seed.js";
import { nativeFailure } from "./us-dataset-native-failure.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import {
  chainTraceExpectation,
  checkDatasetTraceEvidence,
  type DatasetTraceExpectation,
} from "./us-dataset-trace-readiness-evidence.js";
import type { UsDatasetHeader } from "./us-dataset-contract.js";

export type UsDatasetTraceReadinessUnit =
  | Readonly<{ kind: "regular"; index: number }>
  | Readonly<{ kind: "correction" }>
  | Readonly<{ kind: "orphan" }>;

export type UsDatasetTraceReadinessResult = Readonly<{
  datasetId: string;
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  unitKey: string;
  state: "trace_readiness_verified";
  datasetComplete: false;
  lotIds: readonly string[];
  currentEventIds: readonly string[];
  evidence: readonly Readonly<{
    lotId: string;
    traceDigest: string;
    readinessDigest: string;
    historyDigest: string;
    originGap: boolean;
  }>[];
}>;

const selector = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("regular"),
      index: z
        .number()
        .int()
        .min(0)
        .max(259)
        .refine((n) => !Object.is(n, -0)),
    })
    .strict(),
  z.object({ kind: z.literal("correction") }).strict(),
  z.object({ kind: z.literal("orphan") }).strict(),
]);

export type NativeTraceOutput =
  | Readonly<{
      kind: "regular";
      native: UsDatasetRegularResult["chains"][number];
      trace: UsDatasetTraceReadinessResult;
    }>
  | Readonly<{
      kind: "correction";
      native: UsDatasetSpecialChainsResult["correction"];
      trace: UsDatasetTraceReadinessResult;
    }>
  | Readonly<{
      kind: "orphan";
      native: UsDatasetSpecialChainsResult["orphan"];
      trace: UsDatasetTraceReadinessResult;
    }>;

type NativeTraceProduced =
  | Readonly<{
      kind: "regular";
      native: UsDatasetRegularResult["chains"][number];
      expected: DatasetTraceExpectation;
    }>
  | Readonly<{
      kind: "correction";
      native: UsDatasetSpecialChainsResult["correction"];
      expected: DatasetTraceExpectation;
    }>
  | Readonly<{
      kind: "orphan";
      native: UsDatasetSpecialChainsResult["orphan"];
      expected: DatasetTraceExpectation;
    }>;

/** Internal read-only proof; native stores own prerequisites and current business facts. */
export class UsDatasetTraceReadinessStore {
  constructor(private readonly db: Db) {}
  async verify(
    context: UsDatasetContext,
    rawUnit: UsDatasetTraceReadinessUnit,
  ): Promise<UsDatasetTraceReadinessResult> {
    const journal = new UsDatasetJournalStore(this.db, usSixMonthDefinition);
    const header = await journal.read(context);
    assertBoundedSyntheticJson(rawUnit);
    const parsed = selector.safeParse(rawUnit);
    if (!parsed.success)
      throw Object.assign(new Error("us_dataset_trace_readiness_unit_invalid"), {
        unitKey: "unknown",
        stage: "selector",
      });
    const unit = parsed.data;
    const unitKey =
      unit.kind === "regular"
        ? `chain_${String(unit.index).padStart(4, "0")}`
        : `${unit.kind}_0001`;
    if (!header)
      throw Object.assign(new Error("us_dataset_trace_readiness_prerequisite_incomplete"), {
        unitKey,
        stage: "target",
      });
    let expected: DatasetTraceExpectation;
    if (unit.kind === "regular") {
      const { shipping, receiving, transformation } = await new UsDatasetShippingSeedStore(
        this.db,
      ).verifyTerminalProjection(context, unit.index);
      expected = chainTraceExpectation(
        receiving.finalized.record,
        receiving.lots,
        transformation,
        shipping.shipments,
        null,
      );
    } else {
      const special = await new UsDatasetSpecialSeedStore(this.db).verify(context, unit.kind);
      if (special.stage === "void_receiving") {
        expected = {
          lots: special.lots,
          events: [],
          edges: [],
          history: {
            eventId: special.voided.eventId,
            rootId: special.voided.record.lifecycle.rootId,
            status: "void",
            nextRevisionId: null,
            reason: special.voided.record.lifecycle.voidReason,
            eventNumber: special.voided.record.eventNumber,
            revision: special.voided.record.revision,
          },
        };
      } else {
        const shipping = await new UsDatasetCorrectedShippingSeedStore(this.db).verify(context);
        const transformation = await new UsDatasetCorrectedTransformationSeedStore(this.db).verify(
          context,
        );
        expected = chainTraceExpectation(
          special.finalized.record,
          special.lots,
          transformation,
          shipping.shipments,
          {
            eventId: special.predecessor.id,
            rootId: special.predecessor.lifecycle.rootId,
            status: "amended",
            nextRevisionId: special.finalized.eventId,
            reason: special.predecessor.lifecycle.amendmentReason,
            eventNumber: special.predecessor.eventNumber,
            revision: special.predecessor.revision,
          },
        );
      }
    }
    return evaluateTrace(this.db, context, header, unit, unitKey, expected);
  }
}

/** Lexical evaluator; expected facts never enter an exported call surface. */
async function evaluateTrace(
  db: Db,
  context: UsDatasetContext,
  header: UsDatasetHeader,
  unit: UsDatasetTraceReadinessUnit,
  unitKey: string,
  expected: DatasetTraceExpectation,
): Promise<UsDatasetTraceReadinessResult> {
  const traceStore = new UsTraceStore(db);
  const evidence: UsDatasetTraceReadinessResult["evidence"][number][] = [];
  for (const lot of expected.lots) {
    const trace = await traceStore.read(context.tenantId, context.actorUserId, lot.id, {
      direction: "both",
    });
    const readiness = await traceStore.readiness(context.tenantId, context.actorUserId, {
      eventDateFrom: "2026-04-01",
      eventDateTo: "2026-09-30",
      lotId: lot.id,
    });
    const history = await traceStore.history(context.tenantId, context.actorUserId, lot.id, {
      limit: "100",
    });
    checkDatasetTraceEvidence(unitKey, lot, expected, trace, readiness, history);
    const { assessedAt, ...semanticReadiness } = readiness;
    void assessedAt;
    evidence.push(
      Object.freeze({
        lotId: lot.id,
        traceDigest: canonicalExportDigest(trace),
        readinessDigest: canonicalExportDigest(semanticReadiness),
        historyDigest: canonicalExportDigest(history),
        originGap: unit.kind === "orphan",
      }),
    );
  }
  const result: UsDatasetTraceReadinessResult = Object.freeze({
    datasetId: header.id,
    version: header.version,
    definitionDigest: header.definitionDigest,
    unitKey,
    state: "trace_readiness_verified",
    datasetComplete: false,
    lotIds: Object.freeze(expected.lots.map((lot) => lot.id)),
    currentEventIds: Object.freeze(expected.events.map((event) => event.id)),
    evidence: Object.freeze(evidence),
  });
  assertBoundedSyntheticJson(result);
  return result;
}

/** A closed producer: exported calls accept only a context and unit selector. */
export function createUnitNativeTraceEngine(db: Db) {
  const journal = new UsDatasetJournalStore(db, usSixMonthDefinition);
  const references = new UsDatasetReferenceSeedStore(db);
  const receiving = new UsDatasetReceivingSeedStore(db);
  const transformation = new UsDatasetTransformationSeedStore(db);
  const cases = new UsDatasetCasesSeedStore(db);
  const shipping = new UsDatasetShippingSeedStore(db);
  const special = new UsDatasetSpecialSeedStore(db);
  const correctedTransformation = new UsDatasetCorrectedTransformationSeedStore(db);
  const correctedCases = new UsDatasetCorrectedCasesSeedStore(db);
  const correctedShipping = new UsDatasetCorrectedShippingSeedStore(db);

  function annotate(error: unknown, unitKey: string, stage: string, regular: boolean): unknown {
    if (regular) {
      if (error instanceof Error && Object.isExtensible(error)) {
        try {
          Object.defineProperties(error, {
            unitKey: { value: unitKey, enumerable: true, configurable: true, writable: true },
            stage: { value: stage, enumerable: true, configurable: true, writable: true },
          });
        } catch {
          // Preserve original driver/domain identity.
        }
      }
    } else if (error !== null && (typeof error === "object" || typeof error === "function")) {
      for (const [key, value] of [
        ["unitKey", unitKey],
        ["stage", stage],
      ] as const) {
        try {
          if (Object.isExtensible(error) && !(key in error))
            Object.defineProperty(error, key, {
              value,
              enumerable: true,
              configurable: true,
              writable: true,
            });
        } catch {
          // Preserve unusual thrown objects unchanged.
        }
      }
    }
    return nativeFailure(error);
  }

  async function execute(
    context: UsDatasetContext,
    rawUnit: UsDatasetTraceReadinessUnit,
    mode: "initialize" | "verify",
  ): Promise<NativeTraceOutput> {
    let unitKey = "unknown";
    let stage = "target";
    let regular = true;
    let unit: z.infer<typeof selector>;
    let header: UsDatasetHeader;
    try {
      // Actual database target, original owner and profile precede even a hostile selector.
      await journal.read(context);
      stage = "selector";
      assertBoundedSyntheticJson(rawUnit);
      const parsed = selector.safeParse(rawUnit);
      if (!parsed.success) throw new Error("us_dataset_trace_readiness_unit_invalid");
      unit = parsed.data;
      unitKey =
        unit.kind === "regular"
          ? `chain_${String(unit.index).padStart(4, "0")}`
          : `${unit.kind}_0001`;
      regular = unit.kind === "regular";
      stage = "references";
      unitKey = "references";
      await references[mode](context);
      const current = await journal.read(context);
      if (!current) throw datasetReferenceError("us_dataset_references_incomplete");
      header = current;
      unitKey =
        unit.kind === "regular"
          ? `chain_${String(unit.index).padStart(4, "0")}`
          : `${unit.kind}_0001`;
    } catch (error) {
      throw annotate(error, unitKey, stage, regular);
    }

    let produced: NativeTraceProduced;
    try {
      if (unit.kind === "regular") {
        stage = "receiving";
        const rows = await journal.readStageCompletions(
          context,
          header.id,
          (["receiving", "transformation", "cases", "shipping"] as const).map((name) => ({
            unitKey,
            stage: name,
          })),
        );
        const completed = rows.every((row) => row?.revision === 2 && row.receiptPresent);
        if (!completed) {
          await receiving[mode](context, unit.index);
          stage = "transformation";
          await transformation[mode](context, unit.index);
          stage = "cases";
          await cases[mode](context, unit.index);
        }
        stage = "shipping";
        const projection =
          completed || mode === "verify"
            ? await shipping.verifyTerminalProjection(context, unit.index)
            : await shipping.initializeTerminalProjection(context, unit.index);
        produced = {
          kind: "regular",
          native: Object.freeze({
            index: unit.index,
            unitKey: projection.shipping.input.chain.unitKey,
            shipmentCount: projection.shipping.shipments.length,
            shippingResultDigest: canonicalExportDigest(projection.shipping),
          }),
          expected: chainTraceExpectation(
            projection.receiving.finalized.record,
            projection.receiving.lots,
            projection.transformation,
            projection.shipping.shipments,
            null,
          ),
        };
      } else if (unit.kind === "correction") {
        stage = "amend_receiving";
        const lifecycle = await special[mode](context, "correction");
        if (lifecycle.stage !== "amend_receiving")
          throw new Error("us_dataset_special_result_invalid");
        stage = "transformation";
        const corrected = await correctedTransformation[mode](context);
        stage = "cases";
        const correctedCase = await correctedCases[mode](context);
        stage = "shipping";
        const dispatched = await correctedShipping[mode](context);
        produced = {
          kind: "correction",
          native: Object.freeze({
            unitKey: "correction_0001" as const,
            lifecycleResultDigest: canonicalExportDigest(lifecycle),
            transformationResultDigest: canonicalExportDigest(corrected),
            casesResultDigest: canonicalExportDigest(correctedCase),
            shippingResultDigest: canonicalExportDigest(dispatched),
            shipmentCount: dispatched.shipments.length,
          }),
          expected: chainTraceExpectation(
            lifecycle.finalized.record,
            lifecycle.lots,
            corrected,
            dispatched.shipments,
            {
              eventId: lifecycle.predecessor.id,
              rootId: lifecycle.predecessor.lifecycle.rootId,
              status: "amended",
              nextRevisionId: lifecycle.finalized.eventId,
              reason: lifecycle.predecessor.lifecycle.amendmentReason,
              eventNumber: lifecycle.predecessor.eventNumber,
              revision: lifecycle.predecessor.revision,
            },
          ),
        };
      } else {
        stage = "void_receiving";
        const lifecycle = await special[mode](context, "orphan");
        if (lifecycle.stage !== "void_receiving")
          throw new Error("us_dataset_special_result_invalid");
        produced = {
          kind: "orphan",
          native: Object.freeze({
            unitKey: "orphan_0001" as const,
            lifecycleResultDigest: canonicalExportDigest(lifecycle),
          }),
          expected: {
            lots: lifecycle.lots,
            events: [],
            edges: [],
            history: {
              eventId: lifecycle.voided.eventId,
              rootId: lifecycle.voided.record.lifecycle.rootId,
              status: "void",
              nextRevisionId: null,
              reason: lifecycle.voided.record.lifecycle.voidReason,
              eventNumber: lifecycle.voided.record.eventNumber,
              revision: lifecycle.voided.record.revision,
            },
          },
        };
      }
    } catch (error) {
      throw annotate(error, unitKey, stage, regular);
    }
    // Native transactions have committed; read models reload current authority independently.
    const trace = await evaluateTrace(db, context, header, unit, unitKey, produced.expected);
    if (produced.kind === "regular")
      return Object.freeze({ kind: produced.kind, native: produced.native, trace });
    if (produced.kind === "correction")
      return Object.freeze({ kind: produced.kind, native: produced.native, trace });
    return Object.freeze({ kind: produced.kind, native: produced.native, trace });
  }

  return Object.freeze({
    initialize: (context: UsDatasetContext, unit: UsDatasetTraceReadinessUnit) =>
      execute(context, unit, "initialize"),
    verify: (context: UsDatasetContext, unit: UsDatasetTraceReadinessUnit) =>
      execute(context, unit, "verify"),
  });
}
