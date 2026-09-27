/** Pure projection over evidence already selected and authorized by the caller. */
export interface TransformationGenealogyLot {
  id: string;
  currentOrigin: boolean;
}

export interface TransformationGenealogyLine {
  lineNo: number;
  quantity: string;
  unitOfMeasure: string;
  lotId?: string;
  kind?: string;
}

export interface TransformationGenealogySnapshot {
  eventId: string;
  revision: number;
  inputs: readonly TransformationGenealogyLine[];
  outputs: readonly (TransformationGenealogyLine & { lotId: string })[];
}

export interface TransformationGenealogyEvent {
  id: string;
  rootId: string;
  revision: number;
  status: "finalized" | "amended" | "void";
  snapshot: TransformationGenealogySnapshot | null;
}

export interface TransformationGenealogyLink {
  eventId: string;
  inputLotId: string;
  outputLotId: string;
}

export type TransformationGenealogyDiagnostic = {
  code: "cycle" | "limit" | "origin_gap" | "inconsistent_evidence";
  lotId?: string;
  eventId?: string;
};

export type TransformationGenealogyBalance =
  | {
      state: "arithmetic";
      unitOfMeasure: string;
      inputQuantity: string;
      outputQuantity: string;
      deltaQuantity: string;
    }
  | {
      state: "unknown";
      values: { side: "input" | "output"; quantity: string; unitOfMeasure: string }[];
    };

export interface TransformationGenealogyProjectionInput<
  TEvent extends TransformationGenealogyEvent = TransformationGenealogyEvent,
> {
  startLotId: string;
  direction: "upstream" | "downstream";
  mode: "current" | "pinned";
  maxDepth: number;
  maxNodes: number;
  lots: readonly TransformationGenealogyLot[];
  events: readonly TEvent[];
  links: readonly TransformationGenealogyLink[];
  /** Supplied links are a complete sorted prefix of a bounded read. Evidence
   * after its largest key is unknown, not proven absent. Internal selector only.
   */
  linksTruncated?: boolean;
}

export interface TransformationGenealogyProjectionResult<
  TEvent extends TransformationGenealogyEvent = TransformationGenealogyEvent,
> {
  startLotId: string;
  direction: "upstream" | "downstream";
  mode: "current" | "pinned";
  selectedRevisionIds: string[];
  lots: TransformationGenealogyLot[];
  events: TEvent[];
  links: TransformationGenealogyLink[];
  complete: boolean;
  diagnostics: TransformationGenealogyDiagnostic[];
  balance: TransformationGenealogyBalance;
}

const linkKey = (link: TransformationGenealogyLink) =>
  `${link.eventId}/${link.inputLotId}/${link.outputLotId}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameFrozenValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameFrozenValue(value, right[index]))
    );
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && sameFrozenValue(left[key], right[key]),
    )
  );
}

function milli(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
}

function decimal(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  const whole = magnitude / 1000n;
  const fraction = (magnitude % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** The response contract permits at most 18 integer digits and three decimals. */
const MAX_BALANCE_MILLI_EXCLUSIVE = 10n ** 21n;

function representableBalance(value: bigint): boolean {
  return value > -MAX_BALANCE_MILLI_EXCLUSIVE && value < MAX_BALANCE_MILLI_EXCLUSIVE;
}

function balanceFor(
  events: readonly TransformationGenealogyEvent[],
): TransformationGenealogyBalance {
  const values: { side: "input" | "output"; quantity: string; unitOfMeasure: string }[] = [];
  for (const event of events) {
    if (!event.snapshot) continue;
    for (const line of [...event.snapshot.inputs].sort((a, b) => a.lineNo - b.lineNo))
      values.push({ side: "input", quantity: line.quantity, unitOfMeasure: line.unitOfMeasure });
    for (const line of [...event.snapshot.outputs].sort((a, b) => a.lineNo - b.lineNo))
      values.push({ side: "output", quantity: line.quantity, unitOfMeasure: line.unitOfMeasure });
  }
  const units = new Set(values.map((value) => value.unitOfMeasure));
  if (units.size !== 1 || !values.some((value) => value.side === "input"))
    return { state: "unknown", values };
  const unitOfMeasure = values[0]?.unitOfMeasure;
  if (!unitOfMeasure) return { state: "unknown", values };
  const input = values
    .filter((value) => value.side === "input")
    .reduce((sum, value) => sum + milli(value.quantity), 0n);
  const output = values
    .filter((value) => value.side === "output")
    .reduce((sum, value) => sum + milli(value.quantity), 0n);
  if (![input, output, output - input].every(representableBalance))
    return { state: "unknown", values };
  return {
    state: "arithmetic",
    unitOfMeasure,
    inputQuantity: decimal(input),
    outputQuantity: decimal(output),
    deltaQuantity: decimal(output - input),
  };
}

/** Does not select revisions, query data, authorize a tenant or attest export readiness. */
export function projectTransformationGenealogy<TEvent extends TransformationGenealogyEvent>(
  input: TransformationGenealogyProjectionInput<TEvent>,
): TransformationGenealogyProjectionResult<TEvent> {
  if (
    !Number.isInteger(input.maxDepth) ||
    input.maxDepth < 0 ||
    input.maxDepth > 20 ||
    !Number.isInteger(input.maxNodes) ||
    input.maxNodes < 1 ||
    input.maxNodes > 500
  )
    throw new RangeError("Genealogy traversal bounds are outside the supported range");

  const lotsById = new Map<string, TransformationGenealogyLot>();
  const eventsById = new Map<string, TEvent>();
  const linksByKey = new Map<string, TransformationGenealogyLink>();
  const diagnostics = new Map<string, TransformationGenealogyDiagnostic>();
  const diagnose = (diagnostic: TransformationGenealogyDiagnostic) => {
    const key = `${diagnostic.code}/${diagnostic.eventId ?? ""}/${diagnostic.lotId ?? ""}`;
    diagnostics.set(key, diagnostic);
  };

  for (const lot of input.lots) {
    const prior = lotsById.get(lot.id);
    if (prior && prior.currentOrigin !== lot.currentOrigin)
      diagnose({ code: "inconsistent_evidence", lotId: lot.id });
    lotsById.set(lot.id, lot);
  }
  for (const event of input.events) {
    const prior = eventsById.get(event.id);
    if (prior && !sameFrozenValue(prior, event))
      diagnose({ code: "inconsistent_evidence", eventId: event.id });
    if (!prior) eventsById.set(event.id, event);
    if (
      event.snapshot &&
      (event.snapshot.eventId !== event.id || event.snapshot.revision !== event.revision)
    )
      diagnose({ code: "inconsistent_evidence", eventId: event.id });
    if (!event.snapshot && event.status !== "void")
      diagnose({ code: "inconsistent_evidence", eventId: event.id });
  }
  for (const link of input.links) linksByKey.set(linkKey(link), link);
  const linkReadBoundary = input.linksTruncated ? [...linksByKey.keys()].sort().at(-1) : undefined;
  if (input.linksTruncated) diagnose({ code: "limit" });

  const expected = new Set<string>();
  const inputIndex = new Map<string, Set<string>>();
  const outputIndex = new Map<string, Set<string>>();
  const addIndex = (index: Map<string, Set<string>>, lotId: string, eventId: string) => {
    const ids = index.get(lotId) ?? new Set<string>();
    ids.add(eventId);
    index.set(lotId, ids);
  };
  for (const event of eventsById.values()) {
    if (!event.snapshot) continue;
    const inputs = event.snapshot.inputs.filter(
      (line): line is TransformationGenealogyLine & { lotId: string } =>
        line.kind === "ftl_lot" && line.lotId !== undefined,
    );
    for (const line of inputs) addIndex(inputIndex, line.lotId, event.id);
    for (const line of event.snapshot.outputs) addIndex(outputIndex, line.lotId, event.id);
    for (const source of inputs)
      for (const target of event.snapshot.outputs)
        expected.add(
          linkKey({ eventId: event.id, inputLotId: source.lotId, outputLotId: target.lotId }),
        );
  }
  for (const key of expected)
    if (!linksByKey.has(key)) {
      if (input.linksTruncated && (linkReadBoundary === undefined || key > linkReadBoundary))
        continue;
      const eventId = key.split("/")[0];
      if (eventId) diagnose({ code: "inconsistent_evidence", eventId });
    }
  for (const [key, link] of linksByKey)
    if (!expected.has(key) || !lotsById.has(link.inputLotId) || !lotsById.has(link.outputLotId))
      diagnose({ code: "inconsistent_evidence", eventId: link.eventId });

  // Classify the selected evidence's directed component independently of the
  // requested output cap. A revision two hops beyond the frontier is still
  // connected, even though none of its lots or links may be projected.
  const reachableEvents = new Set<string>();
  const reachableLots = new Set([input.startLotId]);
  const reachabilityQueue = [input.startLotId];
  while (reachabilityQueue.length) {
    const lotId = reachabilityQueue.shift();
    if (!lotId) break;
    const adjacent =
      input.direction === "upstream" ? outputIndex.get(lotId) : inputIndex.get(lotId);
    for (const eventId of [...(adjacent ?? [])].sort()) {
      if (reachableEvents.has(eventId)) continue;
      reachableEvents.add(eventId);
      const snapshot = eventsById.get(eventId)?.snapshot;
      const nextLots =
        input.direction === "upstream"
          ? snapshot?.inputs.filter((line) => line.kind === "ftl_lot").map((line) => line.lotId)
          : snapshot?.outputs.map((line) => line.lotId);
      for (const nextLotId of nextLots ?? []) {
        if (!nextLotId || !lotsById.has(nextLotId) || reachableLots.has(nextLotId)) continue;
        reachableLots.add(nextLotId);
        reachabilityQueue.push(nextLotId);
      }
    }
  }

  const selectedLots = new Set<string>();
  const selectedEvents = new Set<string>();
  const metadataOnlyEvents = new Set<string>();
  const pending: { lotId: string; depth: number }[] = [];
  const queued = new Set<string>();
  if (lotsById.has(input.startLotId)) {
    selectedLots.add(input.startLotId);
    pending.push({ lotId: input.startLotId, depth: 0 });
    queued.add(input.startLotId);
  } else {
    diagnose({ code: "inconsistent_evidence", lotId: input.startLotId });
  }

  while (pending.length) {
    const next = pending.shift();
    if (!next) break;
    const adjacent =
      input.direction === "upstream" ? outputIndex.get(next.lotId) : inputIndex.get(next.lotId);
    const ids = [...(adjacent ?? [])].sort();
    for (const eventId of ids) {
      if (selectedEvents.has(eventId)) continue;
      if (next.depth >= input.maxDepth) {
        diagnose({ code: "limit", lotId: next.lotId });
        continue;
      }
      if (selectedLots.size + selectedEvents.size >= input.maxNodes) {
        diagnose({ code: "limit", eventId });
        continue;
      }
      selectedEvents.add(eventId);
      const event = eventsById.get(eventId);
      const snapshot = event?.snapshot;
      if (!snapshot) continue;
      const related = new Set<string>();
      const traversable = new Set<string>();
      for (const line of snapshot.inputs)
        if (line.kind === "ftl_lot" && line.lotId) {
          related.add(line.lotId);
          if (input.direction === "upstream") traversable.add(line.lotId);
        }
      for (const line of snapshot.outputs) {
        related.add(line.lotId);
        if (input.direction === "downstream") traversable.add(line.lotId);
      }
      for (const lotId of [...related].sort()) {
        if (!lotsById.has(lotId)) {
          diagnose({ code: "inconsistent_evidence", eventId });
          continue;
        }
        if (!selectedLots.has(lotId)) {
          if (selectedLots.size + selectedEvents.size >= input.maxNodes) {
            diagnose({ code: "limit", lotId });
            continue;
          }
          selectedLots.add(lotId);
        }
        if (traversable.has(lotId) && !queued.has(lotId)) {
          queued.add(lotId);
          pending.push({ lotId, depth: next.depth + 1 });
        }
      }
    }
  }

  // Pinned evidence is an explicit historical selection. Preserve even a
  // disconnected revision rather than silently replacing or dropping its ID.
  if (input.mode === "pinned")
    for (const event of [...eventsById.values()].sort((a, b) => a.id.localeCompare(b.id, "en"))) {
      if (selectedEvents.has(event.id)) continue;
      if (input.maxDepth === 0) {
        diagnose({ code: "limit", eventId: event.id });
        continue;
      }
      if (reachableEvents.has(event.id)) {
        if (selectedLots.size + selectedEvents.size >= input.maxNodes) {
          diagnose({ code: "limit", eventId: event.id });
          continue;
        }
        selectedEvents.add(event.id);
        metadataOnlyEvents.add(event.id);
        diagnose({ code: "limit", eventId: event.id });
        continue;
      }
      const related = new Set<string>();
      for (const line of event.snapshot?.inputs ?? [])
        if (line.kind === "ftl_lot" && line.lotId) related.add(line.lotId);
      for (const line of event.snapshot?.outputs ?? []) related.add(line.lotId);
      const missing = [...related].filter((lotId) => !lotsById.has(lotId));
      if (missing.length > 0) {
        diagnose({ code: "inconsistent_evidence", eventId: event.id });
        continue;
      }
      const newLots = [...related].filter((lotId) => !selectedLots.has(lotId));
      if (selectedLots.size + selectedEvents.size + 1 + newLots.length > input.maxNodes) {
        diagnose({ code: "limit", eventId: event.id });
        continue;
      }
      selectedEvents.add(event.id);
      for (const lotId of newLots) selectedLots.add(lotId);
      if (event.snapshot) diagnose({ code: "inconsistent_evidence", eventId: event.id });
    }

  const resultLinks = [...linksByKey.values()]
    .filter(
      (link) =>
        selectedEvents.has(link.eventId) &&
        !metadataOnlyEvents.has(link.eventId) &&
        selectedLots.has(link.inputLotId) &&
        selectedLots.has(link.outputLotId) &&
        expected.has(linkKey(link)),
    )
    .sort((a, b) => linkKey(a).localeCompare(linkKey(b), "en"));
  if (resultLinks.length > 2000) {
    resultLinks.length = 2000;
    diagnose({ code: "limit" });
  }

  // Directed lot cycles are checked independently of the traversal queue, so
  // a diamond with a shared ancestor is not misclassified as a cycle.
  const adjacency = new Map<string, Set<string>>();
  for (const link of resultLinks) {
    const from = input.direction === "upstream" ? link.outputLotId : link.inputLotId;
    const to = input.direction === "upstream" ? link.inputLotId : link.outputLotId;
    const neighbours = adjacency.get(from) ?? new Set<string>();
    neighbours.add(to);
    adjacency.set(from, neighbours);
  }
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (lotId: string) => {
    if (active.has(lotId)) {
      diagnose({ code: "cycle", lotId });
      return;
    }
    if (visited.has(lotId)) return;
    visited.add(lotId);
    active.add(lotId);
    for (const neighbour of [...(adjacency.get(lotId) ?? [])].sort()) visit(neighbour);
    active.delete(lotId);
  };
  visit(input.startLotId);
  for (const lotId of [...selectedLots].sort()) visit(lotId);

  const lots = [...selectedLots].sort().flatMap((id) => {
    const lot = lotsById.get(id);
    return lot ? [lot] : [];
  });
  const events = [...selectedEvents].sort().flatMap((id) => {
    const event = eventsById.get(id);
    return event ? [event] : [];
  });
  if (input.mode === "current" || events.length > 0)
    for (const lot of lots) if (!lot.currentOrigin) diagnose({ code: "origin_gap", lotId: lot.id });
  const orderedDiagnostics = [...diagnostics.values()].sort((a, b) =>
    `${a.code}/${a.eventId ?? ""}/${a.lotId ?? ""}`.localeCompare(
      `${b.code}/${b.eventId ?? ""}/${b.lotId ?? ""}`,
      "en",
    ),
  );
  return {
    startLotId: input.startLotId,
    direction: input.direction,
    mode: input.mode,
    selectedRevisionIds: events.map((event) => event.id),
    lots,
    events,
    links: resultLinks,
    complete: orderedDiagnostics.length === 0,
    diagnostics: orderedDiagnostics,
    balance: balanceFor(events),
  };
}
