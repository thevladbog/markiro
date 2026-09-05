export interface LotGenealogyEdge {
  tenantId: string;
  inputLotId: string;
  outputLotId: string;
}

/**
 * Callers must select a consistent current or pinned event-revision view and
 * establish authorization, completeness and transaction locks. Tenant filtering
 * here is defense in depth; these helpers cannot establish export readiness.
 */
function reachableLots(
  edges: readonly LotGenealogyEdge[],
  tenantId: string,
  lotId: string,
  direction: "ancestors" | "descendants",
): Set<string> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.tenantId !== tenantId) continue;
    const from = direction === "ancestors" ? edge.outputLotId : edge.inputLotId;
    const to = direction === "ancestors" ? edge.inputLotId : edge.outputLotId;
    const neighbours = adjacency.get(from) ?? new Set<string>();
    neighbours.add(to);
    adjacency.set(from, neighbours);
  }
  const visited = new Set([lotId]);
  const pending = [lotId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      pending.push(next);
    }
  }
  visited.delete(lotId);
  return visited;
}

export function ancestorsOf(
  edges: readonly LotGenealogyEdge[],
  tenantId: string,
  lotId: string,
): string[] {
  return [...reachableLots(edges, tenantId, lotId, "ancestors")].sort();
}

export function descendantsOf(
  edges: readonly LotGenealogyEdge[],
  tenantId: string,
  lotId: string,
): string[] {
  return [...reachableLots(edges, tenantId, lotId, "descendants")].sort();
}

/** Checks only whether this edge closes a cycle; duplicate-edge policy is separate. */
export function wouldCreateCycle(
  edges: readonly LotGenealogyEdge[],
  candidate: LotGenealogyEdge,
): boolean {
  return (
    candidate.inputLotId === candidate.outputLotId ||
    reachableLots(edges, candidate.tenantId, candidate.inputLotId, "ancestors").has(
      candidate.outputLotId,
    )
  );
}
