import type { UsCurrentTraceResult, UsTraceHistoryPage } from "@markiro/platform-contracts";
import type { ReadinessEventTarget } from "../readiness/source.js";

export type TraceEventTarget = ReadinessEventTarget;
export type TraceNode = UsCurrentTraceResult["nodes"][number];
export type TraceEdge = UsCurrentTraceResult["edges"][number];
export type TracePresentationProps = {
  result: UsCurrentTraceResult;
  onOpenLot: (lotId: string) => void;
  onOpenEvent: (target: TraceEventTarget) => void;
};

export function traceRows(result: UsCurrentTraceResult) {
  return result.edges;
}

export function initialTraceTab(result: UsCurrentTraceResult): "graph" | "table" {
  return result.nodes.length > 50 ? "table" : "graph";
}

export function edgeTarget(edge: TraceEdge): TraceEventTarget {
  return {
    type:
      edge.kind === "receiving"
        ? "receiving"
        : edge.kind === "shipping"
          ? "shipping"
          : "transformation",
    eventId: edge.eventId,
    revision: edge.revision,
    lineSide:
      edge.kind === "transformation_input"
        ? "inputs"
        : edge.kind === "transformation_output"
          ? "outputs"
          : "items",
    lineNo: edge.lineNo,
  };
}

export function historyTarget(item: UsTraceHistoryPage["items"][number]): TraceEventTarget {
  return {
    type: item.type,
    eventId: item.eventId,
    revision: item.revision,
    lineSide: null,
    lineNo: null,
  };
}

export function nodeDisplay(node: TraceNode): string {
  return node.kind === "lot" ? node.tlc : node.display;
}

/** Civil dates retain their calendar components, independent of machine timezone. */
export function traceCivilDate(value: string, language: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(2000, 0, 1, 12);
  date.setFullYear(year ?? 2000, (month ?? 1) - 1, day ?? 1);
  return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(date);
}
