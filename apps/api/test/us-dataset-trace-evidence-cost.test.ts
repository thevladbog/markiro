import { describe, expect, it, vi } from "vitest";
import type {
  TraceabilityLot,
  UsCurrentTraceResult,
  UsReadinessResult,
  UsTraceHistoryPage,
} from "@markiro/platform-contracts";
import * as canonical from "../src/modules/traceability/demo/us-demo-canonical";
import {
  checkDatasetTraceEvidence,
  type DatasetTraceExpectation,
} from "../src/modules/traceability/demo/us-dataset-trace-readiness-evidence";

type Inputs = Parameters<typeof checkDatasetTraceEvidence>;
type Case = "regular" | "correction" | "orphan" | "early_mismatch";
type Event = UsCurrentTraceResult["currentEvents"][number];
type Edge = UsCurrentTraceResult["edges"][number];
const instant = "2026-04-01T00:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Local pure-checker DTOs only: none is a native owner, receipt or dataset proof.
function lot(n: number): TraceabilityLot {
  return {
    id: uuid(n),
    productId: uuid(10),
    tlc: `SYNTHETIC-PURE-${n}`,
    source: null,
    assignmentBasis: "imported",
    sourceLockedAt: null,
    status: "active",
    revision: 1,
    createdBy: "synthetic-pure",
    updatedBy: "synthetic-pure",
    createdAt: instant,
    updatedAt: instant,
  };
}
function event(n: number, type: Event["type"], revision = 1): Event {
  return {
    id: uuid(n),
    rootId: uuid(n + 100),
    type,
    eventNumber: `PURE-${n}`,
    revision,
    eventDate: "2026-04-01",
    timeZone: "America/Los_Angeles",
  };
}
function edge(e: Event, kind: Edge["kind"], from: string, to: string, lineNo: number): Edge {
  const side =
    kind === "transformation_input" ? "input" : kind === "transformation_output" ? "output" : kind;
  return {
    id: `${e.id}:${side}:${lineNo}`,
    kind,
    from,
    to,
    eventId: e.id,
    eventNumber: e.eventNumber,
    revision: e.revision,
    lineNo,
    eventDate: e.eventDate,
    timeZone: e.timeZone,
    quantity: "10",
    unitOfMeasure: "kg",
    ...(kind === "receiving" || kind === "shipping" ? { locationDisplay: "Synthetic" } : {}),
  };
}
function readiness(root: TraceabilityLot): UsReadinessResult {
  return {
    scope: {
      lotId: root.id,
      productId: null,
      profileCode: "US_FSMA204_PROCESSOR",
      eventDateFrom: "2026-04-01",
      eventDateTo: "2026-09-30",
      defaulted: false,
    },
    assessedAt: instant,
    state: "assessed",
    recordsChecked: { events: 2, lots: 3 },
    dependenciesChecked: 2,
    findings: [],
    counts: { error: 0, warning: 0, info: 0 },
    groups: { byCte: [], byProduct: [], bySeverity: [] },
    draftWork: { total: 0, items: [], hasMore: false, eventsHref: "/traceability/events" },
  };
}
function regular(correction = false): Inputs {
  const first = lot(1),
    second = lot(2),
    output = lot(3);
  const lots = [first, second, output];
  const receiving = event(20, "receiving", correction ? 2 : 1),
    transformation = event(21, "transformation"),
    shipping = event(22, "shipping");
  const edges = [
    edge(receiving, "receiving", `location:${uuid(30)}`, `lot:${first.id}`, 1),
    edge(receiving, "receiving", `location:${uuid(30)}`, `lot:${second.id}`, 2),
    edge(
      transformation,
      "transformation_input",
      `lot:${first.id}`,
      `transformation:${uuid(21)}`,
      1,
    ),
    edge(
      transformation,
      "transformation_input",
      `lot:${second.id}`,
      `transformation:${uuid(21)}`,
      2,
    ),
    edge(
      transformation,
      "transformation_output",
      `transformation:${uuid(21)}`,
      `lot:${output.id}`,
      1,
    ),
    edge(shipping, "shipping", `lot:${output.id}`, `location:${uuid(31)}`, 1),
  ];
  const nodes: UsCurrentTraceResult["nodes"] = [
    ...lots.map((l) => ({ kind: "lot" as const, id: `lot:${l.id}`, lotId: l.id, tlc: l.tlc })),
    {
      kind: "transformation",
      id: `transformation:${uuid(21)}`,
      eventId: uuid(21),
      display: "Synthetic",
    },
    {
      kind: "location",
      id: `location:${uuid(30)}`,
      locationId: uuid(30),
      display: "Synthetic",
      displayEdgeId: `${receiving.id}:receiving:1`,
    },
    {
      kind: "location",
      id: `location:${uuid(31)}`,
      locationId: uuid(31),
      display: "Synthetic",
      displayEdgeId: `${shipping.id}:shipping:1`,
    },
  ];
  const history: UsTraceHistoryPage = { items: [], nextCursor: null };
  let previous: DatasetTraceExpectation["history"] = null;
  if (correction) {
    const item: UsTraceHistoryPage["items"][number] = {
      eventId: uuid(19),
      rootId: receiving.rootId,
      type: "receiving",
      eventNumber: receiving.eventNumber,
      revision: 1,
      status: "amended",
      reason: "Synthetic amendment",
      previousRevisionId: null,
      nextRevisionId: receiving.id,
      eventDate: receiving.eventDate,
      createdAt: instant,
    };
    history.items.push(item);
    previous = {
      eventId: item.eventId,
      rootId: item.rootId,
      status: item.status,
      nextRevisionId: item.nextRevisionId,
      reason: item.reason,
      eventNumber: item.eventNumber,
      revision: item.revision,
    };
  }
  const graph: UsCurrentTraceResult = {
    rootLotId: first.id,
    direction: "both",
    nodes,
    edges,
    currentEvents: [receiving, transformation, shipping],
    excludedSummary: { count: correction ? 1 : 0 },
    findings: [],
    completion: { state: "complete", returnedNodes: nodes.length, returnedEdges: edges.length },
  };
  const expected: DatasetTraceExpectation = {
    lots,
    events: structuredClone(graph.currentEvents),
    edges: edges.map(({ kind, from, to, eventId, lineNo }) => ({
      kind,
      from,
      to,
      eventId,
      lineNo,
      quantity: "10",
      unitOfMeasure: "kg",
    })),
    history: previous,
  };
  return [
    correction ? "correction_0001" : "chain_0000",
    first,
    expected,
    graph,
    readiness(first),
    history,
  ];
}
function orphan(): Inputs {
  const root = lot(1),
    retained = lot(2);
  const history: UsTraceHistoryPage["items"][number] = {
    eventId: uuid(19),
    rootId: uuid(119),
    type: "receiving",
    eventNumber: "PURE-VOID",
    revision: 1,
    status: "void",
    reason: "Synthetic void",
    previousRevisionId: null,
    nextRevisionId: null,
    eventDate: "2026-04-01",
    createdAt: instant,
  };
  const assessed = readiness(root);
  assessed.recordsChecked = { events: 0, lots: 1 };
  assessed.dependenciesChecked = 0;
  assessed.counts.error = 1;
  assessed.groups = {
    byCte: [{ cte: null, count: 1 }],
    byProduct: [{ productId: root.productId, count: 1 }],
    bySeverity: [{ severity: "error", count: 1 }],
  };
  assessed.findings = [
    {
      key: `origin_gap:::${root.id}:currentOrigin`,
      ruleVersion: "us-readiness-v1",
      code: "origin_gap",
      severity: "error",
      cte: null,
      field: "currentOrigin",
      message: { key: "readiness.origin_gap", params: {} },
      lotId: root.id,
      productId: root.productId,
      eventId: null,
      rootId: null,
      eventNumber: null,
      revision: null,
      eventDate: null,
      lineSide: null,
      lineNo: null,
      relatedEventId: history.eventId,
      relatedEvent: { type: "receiving", eventNumber: history.eventNumber, revision: 1 },
      links: {
        lotHref: `/traceability/lots/${root.id}`,
        eventHref: null,
        relatedEventHref: `/traceability/events/${history.eventId}`,
      },
    },
  ];
  return [
    "orphan_0001",
    root,
    {
      lots: [root, retained],
      events: [],
      edges: [],
      history: {
        eventId: history.eventId,
        rootId: history.rootId,
        status: history.status,
        nextRevisionId: null,
        reason: history.reason,
        eventNumber: history.eventNumber,
        revision: 1,
      },
    },
    {
      rootLotId: root.id,
      direction: "both",
      nodes: [{ kind: "lot", id: `lot:${root.id}`, lotId: root.id, tlc: root.tlc }],
      edges: [],
      currentEvents: [],
      excludedSummary: { count: 1 },
      findings: [{ code: "origin_gap", lotId: root.id }],
      completion: { state: "complete", returnedNodes: 1, returnedEdges: 0 },
    },
    assessed,
    { items: [history], nextCursor: null },
  ];
}

function characterize(name: Case, check: () => void) {
  const original = canonical.canonicalExportDigest;
  const seen = new WeakSet<object>();
  let digestCalls = 0,
    uniqueObjectIdentities = 0,
    repeatedObjectCalls = 0;
  const observer = vi.spyOn(canonical, "canonicalExportDigest");
  observer.mockImplementation(function (this: unknown, ...args: Parameters<typeof original>) {
    digestCalls++;
    const value = args[0];
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
      if (seen.has(value)) repeatedObjectCalls++;
      else {
        seen.add(value);
        uniqueObjectIdentities++;
      }
    }
    try {
      return Reflect.apply(original, this, args);
    } finally {
      observer.mockClear();
    }
  });
  const started = performance.now();
  try {
    check();
    for (const count of [digestCalls, uniqueObjectIdentities, repeatedObjectCalls]) {
      expect(Number.isSafeInteger(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(0);
    }
    expect(digestCalls).toBeLessThan(200);
    expect(digestCalls).toBe(uniqueObjectIdentities + repeatedObjectCalls);
    const counts: Record<Case, readonly number[]> = {
      regular: [60, 24, 36],
      correction: [60, 24, 36],
      orphan: [0, 0, 0],
      early_mismatch: [0, 0, 0],
    };
    expect([digestCalls, uniqueObjectIdentities, repeatedObjectCalls]).toEqual(counts[name]);
    expect(observer.mock.calls.length).toBe(0);
    if (name === "regular" || name === "correction") {
      expect(uniqueObjectIdentities).toBeGreaterThan(0);
      expect(repeatedObjectCalls).toBeGreaterThan(0);
    } else expect(digestCalls).toBe(0);
  } finally {
    const elapsedMs = performance.now() - started;
    observer.mockRestore();
    process.stdout.write(
      `${JSON.stringify({ case: name, digestCalls, uniqueObjectIdentities, repeatedObjectCalls, elapsedMs })}\n`,
    );
  }
}

describe("pure Trace checker cost characterization, not native performance", () => {
  for (const name of ["regular", "correction", "orphan"] as const)
    it(name, () => {
      const inputs = name === "orphan" ? orphan() : regular(name === "correction");
      characterize(name, () => {
        let accepted = false;
        try {
          checkDatasetTraceEvidence(...inputs);
          accepted = true;
        } catch {
          /* No raw DTO/error diagnostics. */
        }
        expect(accepted).toBe(true);
      });
    });
  it("early_mismatch", () => {
    const inputs = regular();
    let touched = false;
    inputs[3].rootLotId = uuid(99);
    Object.defineProperty(inputs[3], "currentEvents", {
      get() {
        touched = true;
        throw new Error("synthetic_late_sentinel");
      },
    });
    characterize("early_mismatch", () => {
      let failure: unknown;
      try {
        checkDatasetTraceEvidence(...inputs);
      } catch (error) {
        failure = error;
      }
      expect(failure instanceof Error ? failure.message : "not_error").toBe(
        "us_dataset_trace_readiness_mismatch",
      );
      const unit: unknown =
        failure instanceof Error
          ? Object.getOwnPropertyDescriptor(failure, "unitKey")?.value
          : undefined;
      const stage: unknown =
        failure instanceof Error
          ? Object.getOwnPropertyDescriptor(failure, "stage")?.value
          : undefined;
      expect(unit).toBe("chain_0000");
      expect(stage).toBe("trace");
      expect(touched).toBe(false);
    });
  });
});
