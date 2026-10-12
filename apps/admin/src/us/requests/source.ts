import type { ExportFinding } from "@markiro/platform-contracts";
import type { ReadinessEventTarget } from "../readiness/source.js";

// CanonicalExportRow.sourceRecord from rows.ts / registry-v1.ts. Do not infer
// event identity from free text or metadata findings.
export function requestFindingTarget(finding: ExportFinding): ReadinessEventTarget | null {
  const match =
    /^(receiving|shipping|transformation):([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}):([1-9][0-9]*):(item|input|output):([1-9][0-9]*)$/.exec(
      finding.sourceRecord,
    );
  if (!match) return null;
  const [, type, eventId, revisionText, role, lineText] = match;
  if ((type !== "receiving" && type !== "shipping" && type !== "transformation") || !eventId)
    return null;
  if (type === "transformation" ? role !== "input" && role !== "output" : role !== "item")
    return null;
  const revision = Number(revisionText);
  const lineNo = Number(lineText);
  if (
    !Number.isSafeInteger(revision) ||
    !Number.isSafeInteger(lineNo) ||
    (finding.eventId !== undefined && finding.eventId !== eventId) ||
    (finding.revision !== undefined && finding.revision !== revision) ||
    (finding.lineNo !== undefined && finding.lineNo !== lineNo)
  )
    return null;
  return {
    type,
    eventId,
    revision,
    lineNo,
    lineSide: role === "input" ? "inputs" : role === "output" ? "outputs" : "items",
  };
}
