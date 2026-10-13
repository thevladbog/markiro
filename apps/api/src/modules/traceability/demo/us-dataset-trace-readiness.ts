import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { z } from "zod";
import { UsTraceStore } from "../trace/us-trace-store.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { UsDatasetShippingSeedStore } from "./us-dataset-shipping-seed.js";
import { UsDatasetSpecialSeedStore } from "./us-dataset-special-seed.js";
import { UsDatasetCorrectedTransformationSeedStore } from "./us-dataset-corrected-transformation-seed.js";
import { UsDatasetCorrectedShippingSeedStore } from "./us-dataset-corrected-shipping-seed.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import {
  chainTraceExpectation,
  checkDatasetTraceEvidence,
  type DatasetTraceExpectation,
} from "./us-dataset-trace-readiness-evidence.js";

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
    const traceStore = new UsTraceStore(this.db);
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
}
