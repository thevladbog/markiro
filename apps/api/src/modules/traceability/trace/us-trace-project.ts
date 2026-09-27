import type { UsCurrentTraceResult } from "@markiro/platform-contracts";
import { UOM_CODES_V1 } from "@markiro/domain";
import type { TraceEventEvidence, TraceFrontierPage, TraceLine } from "./us-trace-evidence";
export type TraceGraph = Pick<UsCurrentTraceResult, "nodes" | "edges" | "currentEvents">;
type Limit = "depth" | "nodes" | "edges";
type Node = TraceGraph["nodes"][number];
type LotNode = Extract<Node, { kind: "lot" }>;
type Direction = "backward" | "forward";
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const eventOrder = (a: { eventDate: string; id: string }, b: { eventDate: string; id: string }) =>
  compare(a.eventDate, b.eventDate) || compare(a.id, b.id);
const sideOrder = { receiving: 0, input: 1, output: 2, shipping: 3 };
const lineOrder = (a: TraceLine, b: TraceLine) =>
  sideOrder[a.side] - sideOrder[b.side] || a.lineNo - b.lineNo;

/** Adds an entire frozen event, or returns the exact unmodified graph. */
export function addCompleteEvent(
  graph: TraceGraph,
  event: TraceEventEvidence,
  limits: { maxNodes: number; maxEdges: number; depth: number; maxDepth: number },
): { kind: "added"; graph: TraceGraph } | { kind: "limited"; graph: TraceGraph; limit: Limit } {
  if (graph.currentEvents.some((item) => item.id === event.id)) return { kind: "added", graph };
  const existing = new Set(graph.nodes.map((n) => n.id));
  const nodes = new Map<string, Node>();
  const add = (node: Node) => {
    const prior = nodes.get(node.id) ?? graph.nodes.find((item) => item.id === node.id);
    if (prior?.kind === "lot" && node.kind === "lot" && prior.tlc !== node.tlc)
      throw new Error("Conflicting frozen lot identity");
    if (!existing.has(node.id)) nodes.set(node.id, node);
  };
  const eventNode = `transformation:${event.id}`;
  if (event.type === "transformation")
    add({ id: eventNode, kind: "transformation", eventId: event.id, display: event.display });
  const edges: TraceGraph["edges"] = [];
  for (const line of [...event.lines].sort(lineOrder)) {
    if (line.lotId !== null) {
      if (!line.tlc) throw new Error("Missing frozen lot identity");
      add({ id: `lot:${line.lotId}`, kind: "lot", lotId: line.lotId, tlc: line.tlc });
    }
    if (line.side === "receiving" || line.side === "shipping") {
      add({
        id: line.nodeId,
        kind: "location",
        locationId: line.nodeId.slice("location:".length),
        display: line.display,
        displayEdgeId: `${event.id}:${line.side}:${line.lineNo}`,
      });
    } else if (line.lotId === null) {
      add({
        id: line.nodeId,
        kind: "material",
        eventId: event.id,
        lineNo: line.lineNo,
        display: line.display,
      });
    }
    const unitOfMeasure = UOM_CODES_V1.find((unit) => unit === line.unitOfMeasure);
    if (
      (line.quantity === null) !== (line.unitOfMeasure === null) ||
      (line.unitOfMeasure !== null && !unitOfMeasure)
    )
      throw new Error("Invalid frozen quantity");
    edges.push({
      id: `${event.id}:${line.side}:${line.lineNo}`,
      kind:
        line.side === "input"
          ? "transformation_input"
          : line.side === "output"
            ? "transformation_output"
            : line.side,
      from:
        line.side === "receiving" || line.side === "input"
          ? line.nodeId
          : line.side === "output"
            ? eventNode
            : `lot:${line.lotId}`,
      to:
        line.side === "receiving" || line.side === "output"
          ? `lot:${line.lotId}`
          : line.side === "input"
            ? eventNode
            : line.nodeId,
      eventId: event.id,
      eventNumber: event.eventNumber,
      revision: event.revision,
      lineNo: line.lineNo,
      eventDate: event.eventDate,
      timeZone: event.timeZone,
      ...(line.side === "receiving" || line.side === "shipping"
        ? { locationDisplay: line.display }
        : {}),
      ...(line.quantity !== null && unitOfMeasure
        ? { quantity: line.quantity, unitOfMeasure }
        : {}),
    });
  }
  if (limits.depth >= limits.maxDepth && [...nodes.values()].some((n) => n.kind === "lot"))
    return { kind: "limited", graph, limit: "depth" };
  if (graph.nodes.length + nodes.size > limits.maxNodes)
    return { kind: "limited", graph, limit: "nodes" };
  if (graph.edges.length + edges.length > limits.maxEdges)
    return { kind: "limited", graph, limit: "edges" };
  const { id, rootId, type, eventNumber, revision, eventDate, timeZone } = event;
  return {
    kind: "added",
    graph: {
      nodes: [...graph.nodes, ...nodes.values()],
      edges: [...graph.edges, ...edges],
      currentEvents: [
        ...graph.currentEvents,
        { id, rootId, type, eventNumber, revision, eventDate, timeZone },
      ],
    },
  };
}

/** The reader owns I/O; traversal and graph decisions depend only on its evidence pages. */
export async function walkCurrentTrace(
  root: LotNode,
  query: { direction: "both" | Direction; maxDepth: number; maxNodes: number },
  read: (lotIds: readonly string[], direction: Direction) => Promise<TraceFrontierPage>,
): Promise<{ graph: TraceGraph; limit?: Limit }> {
  let graph: TraceGraph = { nodes: [root], edges: [], currentEvents: [] };
  const directions: Direction[] =
    query.direction === "both" ? ["backward", "forward"] : [query.direction];
  let frontier = new Map(directions.map((d) => [d, new Set([root.lotId])]));
  const visited = new Set<string>();
  let limit: Limit | undefined;
  for (let depth = 0; frontier.size && depth <= query.maxDepth; depth++) {
    const candidates = new Map<string, { event: TraceEventEvidence; directions: Set<Direction> }>();
    let hasMore = false;
    for (const direction of directions) {
      const ids = [...(frontier.get(direction) ?? [])]
        .filter((id) => !visited.has(`${direction}:${id}`))
        .sort(compare);
      if (!ids.length) continue;
      ids.forEach((id) => visited.add(`${direction}:${id}`));
      const page = await read(ids, direction);
      hasMore ||= page.hasMore;
      for (const event of page.events) {
        const candidate = candidates.get(event.id) ?? { event, directions: new Set<Direction>() };
        candidate.directions.add(direction);
        candidates.set(event.id, candidate);
      }
    }
    const next = new Map<Direction, Set<string>>();
    for (const candidate of [...candidates.values()].sort((a, b) => eventOrder(a.event, b.event))) {
      // A co-input/co-output may already be rendered without having been reached
      // in this direction. Rendering that node does not discharge its lot hop.
      if (
        depth === query.maxDepth &&
        candidate.event.type === "transformation" &&
        [...candidate.directions].some((direction) =>
          candidate.event.lines.some(
            (line) =>
              line.side === (direction === "backward" ? "input" : "output") &&
              line.lotId !== null &&
              !visited.has(`${direction}:${line.lotId}`),
          ),
        )
      ) {
        limit = "depth";
        break;
      }
      const result = addCompleteEvent(graph, candidate.event, { ...query, maxEdges: 2000, depth });
      if (result.kind === "limited") {
        limit = result.limit;
        break;
      }
      graph = result.graph;
      if (depth === query.maxDepth || candidate.event.type !== "transformation") continue;
      for (const direction of candidate.directions) {
        for (const line of candidate.event.lines) {
          if (
            line.side !== (direction === "backward" ? "input" : "output") ||
            line.lotId === null ||
            visited.has(`${direction}:${line.lotId}`)
          )
            continue;
          const ids = next.get(direction) ?? new Set<string>();
          ids.add(line.lotId);
          next.set(direction, ids);
        }
      }
    }
    // A 2,001st event necessarily exceeds the 2,000 evidence-edge budget.
    if (!limit && hasMore) limit = "edges";
    if (limit) break;
    frontier = next;
  }
  const ordered = [...graph.currentEvents].sort(eventOrder);
  const eventIndex = new Map(ordered.map((event, index) => [event.id, index]));
  const edgeSide = (kind: TraceGraph["edges"][number]["kind"]) =>
    kind === "transformation_input"
      ? 1
      : kind === "transformation_output"
        ? 2
        : kind === "receiving"
          ? 0
          : 3;
  graph = {
    nodes: [
      root,
      ...graph.nodes.filter((n) => n.id !== root.id).sort((a, b) => compare(a.id, b.id)),
    ],
    currentEvents: ordered,
    edges: [...graph.edges].sort(
      (a, b) =>
        (eventIndex.get(a.eventId) ?? 0) - (eventIndex.get(b.eventId) ?? 0) ||
        edgeSide(a.kind) - edgeSide(b.kind) ||
        a.lineNo - b.lineNo,
    ),
  };
  return { graph, ...(limit ? { limit } : {}) };
}
