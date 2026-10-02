import { assessFrozenReadiness, DomainError, type ReadinessRuleFinding } from "@markiro/domain";
import {
  usReadinessResultSchema,
  type UsProfileCode,
  type UsReadinessFinding,
  type UsReadinessResult,
  type UsReadinessScope,
} from "@markiro/platform-contracts";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { unavailable } from "../receiving/us-receiving-persistence";
import { readUsReadinessEvidence } from "./us-readiness-evidence";
import { UsReadinessScopeTooLargeException } from "./us-readiness-errors";

const severityOrder = { error: 0, warning: 1, info: 2 };
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deduplicateAndSort(input: readonly ReadinessRuleFinding[]): UsReadinessFinding[] {
  const unique = new Map<string, UsReadinessFinding>();
  for (const { lineId, ...finding } of input) {
    const key = [
      finding.code,
      finding.eventId ?? "",
      lineId ?? "",
      finding.lotId ?? "",
      finding.field,
    ].join(":");
    unique.set(key, {
      ...finding,
      key,
      links: {
        lotHref: finding.lotId === null ? null : `/traceability/lots/${finding.lotId}`,
        eventHref:
          finding.eventId === null ? null : `/traceability/${finding.cte}/${finding.eventId}`,
        relatedEventHref:
          finding.relatedEventId === null ? null : `/traceability/events/${finding.relatedEventId}`,
      },
    });
    if (unique.size > 10000) throw new UsReadinessScopeTooLargeException();
  }
  return [...unique.values()].sort(
    (left, right) =>
      severityOrder[left.severity] - severityOrder[right.severity] ||
      compareText(left.eventDate ?? "9999-12-31", right.eventDate ?? "9999-12-31") ||
      compareText(
        left.rootId ?? left.eventId ?? left.lotId ?? "",
        right.rootId ?? right.eventId ?? right.lotId ?? "",
      ) ||
      (left.lineNo ?? 0) - (right.lineNo ?? 0) ||
      compareText(left.code, right.code) ||
      compareText(left.key, right.key),
  );
}

function countSeverities(findings: readonly UsReadinessFinding[]): UsReadinessResult["counts"] {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}

function groupFindings(findings: readonly UsReadinessFinding[]): UsReadinessResult["groups"] {
  const ctes = new Map<UsReadinessFinding["cte"], number>();
  const products = new Map<string | null, number>();
  const severities = countSeverities(findings);
  for (const finding of findings) {
    ctes.set(finding.cte, (ctes.get(finding.cte) ?? 0) + 1);
    products.set(finding.productId, (products.get(finding.productId) ?? 0) + 1);
  }
  return {
    byCte: [...ctes]
      .sort(([a], [b]) => compareText(a ?? "", b ?? ""))
      .map(([cte, count]) => ({ cte, count })),
    byProduct: [...products]
      .sort(([a], [b]) => compareText(a ?? "", b ?? ""))
      .map(([productId, count]) => ({ productId, count })),
    bySeverity: (["error", "warning", "info"] as const)
      .filter((level) => severities[level] > 0)
      .map((severity) => ({ severity, count: severities[severity] })),
  };
}

/** One complete response from the caller's authorized repeatable-read snapshot. */
export async function assessUsReadiness(
  tx: UsMasterDataTransaction,
  tenantId: string,
  scope: UsReadinessScope,
  profileCode: UsProfileCode,
  assessedAt = new Date().toISOString(),
): Promise<UsReadinessResult> {
  const deadline = performance.now() + 5000;
  if (scope.profileCode !== profileCode) throw unavailable();
  const evidence = await readUsReadinessEvidence(tx, tenantId, scope);
  let rules: ReadinessRuleFinding[];
  try {
    rules = assessFrozenReadiness({ profileCode, ...evidence.facts }, { maxFindings: 10000 });
  } catch (error) {
    if (error instanceof DomainError && error.code === "readiness_finding_limit_exceeded")
      throw new UsReadinessScopeTooLargeException();
    throw error;
  }
  const findings = deduplicateAndSort(rules);
  const items = evidence.draftWork.items.slice(0, 50);
  const result = usReadinessResultSchema.safeParse({
    scope,
    assessedAt,
    state: evidence.selectedEventCount + evidence.selectedLotCount ? "assessed" : "empty",
    recordsChecked: { events: evidence.selectedEventCount, lots: evidence.selectedLotCount },
    dependenciesChecked: evidence.dependencyCount,
    counts: countSeverities(findings),
    groups: groupFindings(findings),
    findings,
    draftWork: {
      total: evidence.draftWork.total,
      items,
      hasMore: evidence.draftWork.total > items.length,
      eventsHref: "/traceability/events",
    },
  });
  if (!result.success || performance.now() >= deadline) throw unavailable();
  return result.data;
}
