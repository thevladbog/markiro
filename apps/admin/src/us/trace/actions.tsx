import { Button } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { edgeTarget, type TraceEdge, type TracePresentationProps } from "./projection.js";
import { presentationCopy } from "./presentation-copy.js";

export function TraceLotActions({
  result,
  onOpenLot,
}: Pick<TracePresentationProps, "result" | "onOpenLot">) {
  const { i18n } = useTranslation();
  const copy = presentationCopy(i18n.language);
  return (
    <div role="group" aria-label={copy.lots} className="us-trace-lots">
      {result.nodes
        .filter((node) => node.kind === "lot")
        .map((node) => (
          <Button key={node.id} variant="secondary" onClick={() => onOpenLot(node.lotId)}>
            {copy.openLot} {node.tlc} · {node.lotId}
          </Button>
        ))}
    </div>
  );
}

export function TraceEventAction({
  edge,
  onOpenEvent,
}: {
  edge: TraceEdge;
  onOpenEvent: TracePresentationProps["onOpenEvent"];
}) {
  const { i18n } = useTranslation();
  const copy = presentationCopy(i18n.language);
  return (
    <Button
      variant="secondary"
      data-trace-edge-action={edge.id}
      onClick={() => onOpenEvent(edgeTarget(edge))}
    >
      {edge.eventNumber} · {copy.revision} {edge.revision} · {copy[edge.kind]} · {copy.line}{" "}
      {edge.lineNo}
    </Button>
  );
}
