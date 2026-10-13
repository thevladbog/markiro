import { canonicalExportDigest } from "@markiro/domain";
import type {
  ReceivingLiveRecord,
  TraceabilityLot,
  UsCurrentTraceResult,
  UsReadinessResult,
  UsTraceHistoryPage,
} from "@markiro/platform-contracts";
import type { UsDatasetTransformationEvidence } from "./us-dataset-transformation-content.js";
import type { UsDatasetShippingShipmentResult } from "./us-dataset-shipping-contract.js";

type Edge = Pick<
  UsCurrentTraceResult["edges"][number],
  "kind" | "from" | "to" | "eventId" | "lineNo" | "quantity" | "unitOfMeasure"
>;
export type DatasetTraceExpectation = {
  lots: readonly TraceabilityLot[];
  events: UsCurrentTraceResult["currentEvents"];
  edges: Edge[];
  history: Pick<
    UsTraceHistoryPage["items"][number],
    "eventId" | "rootId" | "status" | "nextRevisionId" | "reason" | "eventNumber" | "revision"
  > | null;
};

export function chainTraceExpectation(
  receiving: ReceivingLiveRecord,
  lots: readonly TraceabilityLot[],
  transformation: UsDatasetTransformationEvidence,
  shipments: readonly UsDatasetShippingShipmentResult[],
  history: DatasetTraceExpectation["history"],
): DatasetTraceExpectation {
  if (receiving.content.kind !== "finalized")
    throw new Error("us_dataset_trace_readiness_prerequisite_incomplete");
  const r = receiving.content.snapshot,
    t = transformation.finalized;
  const events: DatasetTraceExpectation["events"] = [
    {
      id: receiving.id,
      rootId: receiving.lifecycle.rootId,
      type: "receiving",
      eventNumber: receiving.eventNumber,
      revision: receiving.revision,
      eventDate: r.dateReceived,
      timeZone: receiving.timeZone,
    },
    {
      id: t.id,
      rootId: t.lifecycle?.rootId ?? t.id,
      type: "transformation",
      eventNumber: t.eventNumber,
      revision: t.revision,
      eventDate: t.snapshot.eventDate,
      timeZone: t.timeZone,
    },
  ];
  const edges: Edge[] = r.items.map((line) => ({
    kind: "receiving",
    from: `location:${r.previousSourceDescription.locationId}`,
    to: `lot:${line.lotId}`,
    eventId: receiving.id,
    lineNo: line.lineNo,
    quantity: line.quantity,
    unitOfMeasure: line.unitOfMeasure,
  }));
  edges.push(
    ...t.snapshot.inputs.map((line): Edge => ({
      kind: "transformation_input",
      from: line.kind === "ftl_lot" ? `lot:${line.lotId}` : `material:${t.id}:${line.lineNo}`,
      to: `transformation:${t.id}`,
      eventId: t.id,
      lineNo: line.lineNo,
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
    })),
    ...t.snapshot.outputs.map((line): Edge => ({
      kind: "transformation_output",
      from: `transformation:${t.id}`,
      to: `lot:${line.lotId}`,
      eventId: t.id,
      lineNo: line.lineNo,
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
    })),
  );
  for (const { finalized: s } of shipments) {
    events.push({
      id: s.id,
      rootId: s.lifecycle?.rootId ?? s.id,
      type: "shipping",
      eventNumber: s.eventNumber,
      revision: s.revision,
      eventDate: s.snapshot.eventDate,
      timeZone: s.timeZone,
    });
    edges.push(
      ...s.snapshot.items.map((line): Edge => ({
        kind: "shipping",
        from: `lot:${line.lotId}`,
        to: `location:${s.snapshot.recipient.locationId}`,
        eventId: s.id,
        lineNo: line.lineNo,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
      })),
    );
  }
  return { lots: [...lots, transformation.outputLot], events, edges, history };
}

export function checkDatasetTraceEvidence(
  unitKey: string,
  lot: TraceabilityLot,
  expected: DatasetTraceExpectation,
  trace: UsCurrentTraceResult,
  readiness: UsReadinessResult,
  history: UsTraceHistoryPage,
): void {
  const fail = (stage: string, facts?: unknown): never => {
    throw Object.assign(new Error("us_dataset_trace_readiness_mismatch", { cause: facts }), {
      unitKey,
      stage,
    });
  };
  const same = (a: unknown, b: unknown) => canonicalExportDigest(a) === canonicalExportDigest(b);
  const ordered = <T>(values: readonly T[]) =>
    [...values].sort((a, b) => canonicalExportDigest(a).localeCompare(canonicalExportDigest(b)));
  const orphan = expected.events.length === 0;
  const visibleLots = orphan ? [lot] : expected.lots;
  const actualLots = trace.nodes
    .filter((n) => n.kind === "lot")
    .map((n) => ({ lotId: n.lotId, tlc: n.tlc }));
  if (
    trace.rootLotId !== lot.id ||
    trace.direction !== "both" ||
    trace.completion.state !== "complete" ||
    !same(ordered(actualLots), ordered(visibleLots.map((l) => ({ lotId: l.id, tlc: l.tlc })))) ||
    !same(ordered(trace.currentEvents), ordered(expected.events))
  )
    fail("trace");
  const actualEdges = trace.edges.map(
    ({ kind, from, to, eventId, lineNo, quantity, unitOfMeasure }) => ({
      kind,
      from,
      to,
      eventId,
      lineNo,
      quantity,
      unitOfMeasure,
    }),
  );
  if (
    !same(ordered(actualEdges), ordered(expected.edges)) ||
    !same(trace.findings, orphan ? [{ code: "origin_gap", lotId: lot.id }] : [])
  )
    fail("trace");
  const expectedNodes = new Set([
    ...(orphan ? [lot] : expected.lots).map((l) => `lot:${l.id}`),
    ...expected.edges.flatMap((e) => [e.from, e.to]),
  ]);
  if (!same([...expectedNodes].sort(), trace.nodes.map((n) => n.id).sort())) fail("trace");
  if (expected.history && (orphan || expected.lots.slice(0, 2).some((l) => l.id === lot.id))) {
    const actual = history.items.find((row) => row.eventId === expected.history?.eventId);
    if (
      !actual ||
      !same(
        {
          eventId: actual.eventId,
          rootId: actual.rootId,
          status: actual.status,
          nextRevisionId: actual.nextRevisionId,
          reason: actual.reason,
          eventNumber: actual.eventNumber,
          revision: actual.revision,
        },
        expected.history,
      ) ||
      trace.excludedSummary.count < 1
    )
      fail("history");
  }
  if (orphan && (trace.nodes.length !== 1 || trace.excludedSummary.count !== 1)) fail("trace");
  const selectedEvents = new Set(
    expected.edges
      .filter((e) => e.from === `lot:${lot.id}` || e.to === `lot:${lot.id}`)
      .map((e) => e.eventId),
  );
  // The native lot filter selects events; each selected event brings all its lot lines.
  const selectedLots = new Set([
    lot.id,
    ...expected.edges
      .filter((e) => selectedEvents.has(e.eventId))
      .flatMap((e) => [e.from, e.to])
      .filter((id) => id.startsWith("lot:"))
      .map((id) => id.slice(4)),
  ]);
  // Each exact consumer line has one proven Receiving/Transformation origin.
  const dependencies = expected.edges.filter(
    (edge) =>
      selectedEvents.has(edge.eventId) &&
      (edge.kind === "transformation_input" || edge.kind === "shipping"),
  ).length;
  if (
    readiness.scope.lotId !== lot.id ||
    readiness.scope.productId !== null ||
    readiness.scope.profileCode !== "US_FSMA204_PROCESSOR" ||
    readiness.scope.eventDateFrom !== "2026-04-01" ||
    readiness.scope.eventDateTo !== "2026-09-30" ||
    readiness.scope.defaulted ||
    readiness.state !== "assessed" ||
    readiness.recordsChecked.lots !== selectedLots.size ||
    readiness.recordsChecked.events !== selectedEvents.size ||
    readiness.dependenciesChecked !== dependencies ||
    readiness.draftWork.total !== 0
  )
    fail("readiness", readiness);
  const findings: UsReadinessResult["findings"] = [];
  if (orphan) {
    const excluded = expected.history;
    if (!excluded || excluded.status !== "void") return fail("readiness");
    // Pin the existing readiness-v1 orphan rule to the checked retained lot/void revision.
    findings.push({
      key: `origin_gap:::${lot.id}:currentOrigin`,
      ruleVersion: "us-readiness-v1",
      code: "origin_gap",
      severity: "error",
      cte: null,
      field: "currentOrigin",
      message: { key: "readiness.origin_gap", params: {} },
      lotId: lot.id,
      productId: lot.productId,
      eventId: null,
      rootId: null,
      eventNumber: null,
      revision: null,
      eventDate: null,
      lineSide: null,
      lineNo: null,
      relatedEventId: excluded.eventId,
      relatedEvent: {
        type: "receiving",
        eventNumber: excluded.eventNumber,
        revision: excluded.revision,
      },
      links: {
        lotHref: `/traceability/lots/${lot.id}`,
        eventHref: null,
        relatedEventHref: `/traceability/events/${excluded.eventId}`,
      },
    });
  }
  const counts = { error: orphan ? 1 : 0, warning: 0, info: 0 };
  const groups: UsReadinessResult["groups"] = orphan
    ? {
        byCte: [{ cte: null, count: 1 }],
        byProduct: [{ productId: lot.productId, count: 1 }],
        bySeverity: [{ severity: "error", count: 1 }],
      }
    : { byCte: [], byProduct: [], bySeverity: [] };
  if (
    !same(readiness.findings, findings) ||
    !same(readiness.counts, counts) ||
    !same(readiness.groups, groups) ||
    !same(readiness.draftWork, {
      total: 0,
      items: [],
      hasMore: false,
      eventsHref: "/traceability/events",
    })
  )
    fail("readiness", readiness);
}
