import type { UsReadinessFinding } from "@markiro/platform-contracts";

export type ReadinessEventTarget = {
  type: "receiving" | "transformation" | "shipping";
  eventId: string;
  revision: number;
  lineSide: "items" | "inputs" | "outputs" | null;
  lineNo: number | null;
};

export function sourceTarget(finding: UsReadinessFinding): ReadinessEventTarget | null {
  if (finding.eventId === null || finding.cte === null || finding.revision === null) return null;
  return {
    type: finding.cte,
    eventId: finding.eventId,
    revision: finding.revision,
    lineSide: finding.lineSide,
    lineNo: finding.lineNo,
  };
}

export function relatedSourceTarget(finding: UsReadinessFinding): ReadinessEventTarget | null {
  if (finding.relatedEventId === null || finding.relatedEvent === null) return null;
  return {
    type: finding.relatedEvent.type,
    eventId: finding.relatedEventId,
    revision: finding.relatedEvent.revision,
    lineSide: null,
    lineNo: null,
  };
}
