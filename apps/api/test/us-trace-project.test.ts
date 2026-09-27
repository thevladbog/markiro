import { describe, expect, it } from "vitest";
import { usCurrentTraceResultSchema } from "@markiro/platform-contracts";
import {
  addCompleteEvent,
  walkCurrentTrace,
  type TraceGraph,
} from "../src/modules/traceability/trace/us-trace-project";
import type {
  TraceEventEvidence,
  TraceFrontierPage,
} from "../src/modules/traceability/trace/us-trace-evidence";

const id = (n: number) => `${n.toString().padStart(8, "0")}-1111-4111-8111-111111111111`;
const lot = (n: number) => ({
  id: `lot:${id(n)}`,
  kind: "lot" as const,
  lotId: id(n),
  tlc: `LOT-${n}`,
});
const root: TraceGraph = { nodes: [lot(1)], edges: [], currentEvents: [] };
const event: TraceEventEvidence = {
  id: id(10),
  rootId: id(10),
  type: "transformation",
  eventNumber: "TR-10",
  revision: 2,
  eventDate: "2026-09-27",
  timeZone: "America/New_York",
  display: "Saved processor",
  lines: [1, 2, 3, 4].map((n) => ({
    side: n <= 2 ? "input" : "output",
    lineNo: n <= 2 ? n : n - 2,
    lotId: id(n),
    nodeId: `lot:${id(n)}`,
    quantity: ["500", "400", "110", "70"][n - 1] ?? null,
    unitOfMeasure: n <= 2 ? "lb" : "case",
    display: "Saved product",
    tlc: `LOT-${n}`,
  })),
};
const limits = { maxNodes: 500, maxEdges: 2000, depth: 0, maxDepth: 16 };
const reader =
  (events: readonly TraceEventEvidence[]) =>
  async (
    ids: readonly string[],
    direction: "backward" | "forward",
  ): Promise<TraceFrontierPage> => ({
    events: events.filter((e) =>
      e.lines.some(
        (line) =>
          line.lotId !== null &&
          ids.includes(line.lotId) &&
          (direction === "backward"
            ? ["output", "receiving"].includes(line.side)
            : ["input", "shipping"].includes(line.side)),
      ),
    ),
    hasMore: false,
  });

describe("current trace projection", () => {
  it("preserves different frozen location names with their exact event and line across candidate orders", async () => {
    const firstShipment: TraceEventEvidence = {
      ...event,
      type: "shipping",
      eventNumber: "SHIP-10",
      lines: [
        {
          side: "shipping",
          lineNo: 1,
          lotId: id(1),
          tlc: "LOT-1",
          nodeId: `location:${id(20)}`,
          display: "Original frozen name",
          quantity: "5",
          unitOfMeasure: "kg",
        },
      ],
    };
    const shipping: TraceEventEvidence = {
      ...firstShipment,
      id: id(11),
      rootId: id(11),
      type: "shipping",
      eventNumber: "SHIP-11",
      lines: [{ ...firstShipment.lines[0]!, lineNo: 2, display: "Later frozen name" }],
    };
    const results = [];
    for (const candidates of [
      [firstShipment, shipping],
      [shipping, firstShipment],
    ]) {
      const { graph } = await walkCurrentTrace(
        lot(1),
        { direction: "both", maxDepth: 16, maxNodes: 500 },
        reader(candidates),
      );
      expect(graph.edges).toMatchObject([
        { eventId: id(10), lineNo: 1, locationDisplay: "Original frozen name" },
        { eventId: id(11), lineNo: 2, locationDisplay: "Later frozen name" },
      ]);
      expect(graph.nodes.filter((node) => node.kind === "location")).toEqual([
        {
          id: `location:${id(20)}`,
          kind: "location",
          locationId: id(20),
          display: "Original frozen name",
          displayEdgeId: `${id(10)}:shipping:1`,
        },
      ]);
      results.push(
        usCurrentTraceResultSchema.parse({
          ...graph,
          rootLotId: id(1),
          direction: "both",
          excludedSummary: { count: 0 },
          findings: [],
          completion: { state: "complete", returnedNodes: 2, returnedEdges: 2 },
        }),
      );
    }
    expect(results[0]).toEqual(results[1]);
  });
  it("withholds a boundary hop to an already-rendered lot not yet visited in that direction", async () => {
    // First star renders co-input 2 but forward traversal only visits outputs 3/4.
    const backToCoInput: TraceEventEvidence = {
      ...event,
      id: id(11),
      rootId: id(11),
      eventNumber: "TR-11",
      lines: [
        { ...event.lines[2]!, side: "input", lineNo: 1 },
        { ...event.lines[1]!, side: "output", lineNo: 1 },
      ],
    };
    const hidden: TraceEventEvidence = {
      ...event,
      id: id(12),
      rootId: id(12),
      eventNumber: "TR-12",
      lines: [
        { ...event.lines[1]!, lineNo: 1 },
        { ...event.lines[2]!, lotId: id(5), nodeId: `lot:${id(5)}`, tlc: "LOT-5" },
      ],
    };
    const result = await walkCurrentTrace(
      lot(1),
      { direction: "both", maxDepth: 1, maxNodes: 500 },
      reader([event, backToCoInput, hidden]),
    );
    expect(result.limit).toBe("depth");
    expect(result.graph.currentEvents.map((e) => e.id)).toEqual([id(10)]);
    expect(result.graph.edges).toHaveLength(4);
  });
  it("distinguishes a terminal positive-depth frontier from one further lot hop", async () => {
    const request = { direction: "forward" as const, maxDepth: 1, maxNodes: 500 };
    const terminal = await walkCurrentTrace(lot(1), request, reader([event]));
    expect(terminal.limit).toBeUndefined();
    expect(terminal.graph.edges).toHaveLength(4);
    const further: TraceEventEvidence = {
      ...event,
      id: id(11),
      rootId: id(11),
      lines: [
        { ...event.lines[2]!, side: "input", lineNo: 1 },
        { ...event.lines[2]!, lotId: id(5), nodeId: `lot:${id(5)}`, tlc: "LOT-5" },
      ],
    };
    const limited = await walkCurrentTrace(lot(1), request, reader([event, further]));
    expect(limited.limit).toBe("depth");
    expect(limited.graph).toEqual(terminal.graph);
  });
  it("rejects conflicting frozen TLCs instead of hiding them behind a prior lot node", () => {
    expect(() =>
      addCompleteEvent(
        root,
        { ...event, lines: [{ ...event.lines[0]!, tlc: "OTHER" }, ...event.lines.slice(1)] },
        limits,
      ),
    ).toThrow("Conflicting frozen lot identity");
  });
  it("projects the four 2-to-2 lines once with exact quantities and provenance", () => {
    const result = addCompleteEvent(root, event, limits);
    expect(result.kind).toBe("added");
    expect(result.graph.nodes).toHaveLength(5);
    expect(result.graph.edges.map((e) => [e.kind, e.lineNo, e.quantity, e.from, e.to])).toEqual([
      ["transformation_input", 1, "500", `lot:${id(1)}`, `transformation:${id(10)}`],
      ["transformation_input", 2, "400", `lot:${id(2)}`, `transformation:${id(10)}`],
      ["transformation_output", 1, "110", `transformation:${id(10)}`, `lot:${id(3)}`],
      ["transformation_output", 2, "70", `transformation:${id(10)}`, `lot:${id(4)}`],
    ]);
    expect(
      result.graph.edges.every(
        (e) => e.eventId === id(10) && e.revision === 2 && e.eventDate === "2026-09-27",
      ),
    ).toBe(true);
    expect(addCompleteEvent(result.graph, event, limits).graph).toBe(result.graph);
    expect(root.nodes).toEqual([lot(1)]);
    expect(root.edges).toEqual([]);
  });
  it.each([
    [4, 2000, "nodes"],
    [500, 3, "edges"],
    [500, 2000, "depth"],
  ] as const)("withholds a whole event at caps %s/%s (%s)", (maxNodes, maxEdges, limit) => {
    expect(
      addCompleteEvent(root, event, {
        ...limits,
        maxNodes,
        maxEdges,
        maxDepth: limit === "depth" ? 0 : 16,
      }),
    ).toEqual({ kind: "limited", graph: root, limit });
  });
  it("includes a non-FTL-only origin with no invented TLC", () => {
    const e: TraceEventEvidence = {
      ...event,
      lines: [
        {
          side: "input",
          lineNo: 1,
          lotId: null,
          nodeId: `material:${event.id}:1`,
          quantity: "0.250",
          unitOfMeasure: "lb",
          display: "Ingredient",
          tlc: null,
        },
        { ...event.lines[2]!, lotId: id(1), nodeId: `lot:${id(1)}`, tlc: "LOT-1" },
      ],
    };
    const result = addCompleteEvent(root, e, { ...limits, maxDepth: 0 });
    expect(result.kind).toBe("added");
    expect(result.graph.nodes.find((n) => n.kind === "material")).toEqual({
      id: `material:${event.id}:1`,
      kind: "material",
      eventId: event.id,
      lineNo: 1,
      display: "Ingredient",
    });
    expect(result.graph.edges.map((e) => e.quantity)).toEqual(["0.250", "110"]);
  });
  it("orders candidate and line permutations deterministically and terminates cycles", async () => {
    const cycle: TraceEventEvidence = {
      ...event,
      id: id(11),
      rootId: id(11),
      eventNumber: "TR-11",
      lines: [
        { ...event.lines[2]!, side: "input", lineNo: 1 },
        { ...event.lines[0]!, side: "output", lineNo: 1 },
      ],
    };
    const first = await walkCurrentTrace(
      lot(1),
      { direction: "both", maxDepth: 16, maxNodes: 500 },
      reader([event, cycle]),
    );
    const second = await walkCurrentTrace(
      lot(1),
      { direction: "both", maxDepth: 16, maxNodes: 500 },
      reader([cycle, { ...event, lines: [...event.lines].reverse() }]),
    );
    expect(first).toEqual(second);
    expect(first.graph.edges).toHaveLength(6);
    expect(first.limit).toBeUndefined();
  });
  it("does not traverse co-inputs as descendants", async () => {
    const sibling: TraceEventEvidence = {
      ...event,
      id: id(12),
      rootId: id(12),
      lines: [
        event.lines[1]!,
        { ...event.lines[2]!, lotId: id(5), nodeId: `lot:${id(5)}`, tlc: "LOT-5" },
      ],
    };
    const result = await walkCurrentTrace(
      lot(1),
      { direction: "forward", maxDepth: 16, maxNodes: 500 },
      reader([event, sibling]),
    );
    expect(result.graph.currentEvents.map((e) => e.id)).toEqual([id(10)]);
  });
  it("marks a reader sentinel as limited even when the prefix fits", async () => {
    const result = await walkCurrentTrace(
      lot(1),
      { direction: "forward", maxDepth: 16, maxNodes: 500 },
      async () => ({ events: [event], hasMore: true }),
    );
    expect(result.limit).toBe("edges");
  });
  it("allows exactly 500 nodes and 2000 edges, rejecting the next entire event", () => {
    const receiving: TraceEventEvidence = {
      ...event,
      type: "receiving",
      lines: [{ ...event.lines[0]!, side: "receiving", nodeId: `location:${id(20)}` }],
    };
    let graph: TraceGraph = {
      nodes: Array.from({ length: 499 }, (_, n) => lot(n + 1)),
      edges: [],
      currentEvents: [],
    };
    for (let n = 0; n < 2000; n++) {
      const next = addCompleteEvent(
        graph,
        { ...receiving, id: id(n + 1000), rootId: id(n + 1000) },
        limits,
      );
      expect(next.kind).toBe("added");
      graph = next.graph;
    }
    expect(graph.nodes).toHaveLength(500);
    expect(graph.edges).toHaveLength(2000);
    expect(addCompleteEvent(graph, { ...receiving, id: id(4000) }, limits)).toEqual({
      kind: "limited",
      limit: "edges",
      graph,
    });
  });
});
