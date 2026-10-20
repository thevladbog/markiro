import type { Db } from "@markiro/db";
import type { UsRequestSnapshot } from "../requests/us-request-snapshot.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import { UsDatasetShippingSeedStore } from "./us-dataset-shipping-seed.js";
import { UsDatasetPlanSeedStore } from "./us-dataset-plan-seed.js";
import { chainTraceExpectation } from "./us-dataset-trace-readiness-evidence.js";
import { usSixMonthRequestSelections } from "./us-six-month-definition.js";
import { canonicalExportDigest } from "./us-demo-canonical.js";
import {
  equalRequest,
  requestError,
  type UsDatasetRequestServices,
  type UsDatasetRequestUnitKey,
} from "./us-dataset-request-contract.js";

const ordered = <T>(items: readonly T[]) =>
  [...items].sort((a, b) => canonicalExportDigest(a).localeCompare(canonicalExportDigest(b)));

/** Re-derive the complete finite closure from native terminal proof, never caller IDs. */
export async function readRequestSelection(
  db: Db,
  context: UsDatasetContext,
  unitKey: UsDatasetRequestUnitKey,
  services: UsDatasetRequestServices,
) {
  const recipe = usSixMonthRequestSelections.find((r) => r.unitKey === unitKey);
  if (!recipe) throw requestError("unit_invalid");
  const plan = await new UsDatasetPlanSeedStore(db, services.planArtifacts).verify(context);
  const chains = [];
  for (const key of recipe.chainKeys) {
    chains.push(
      await new UsDatasetShippingSeedStore(db).verifyTerminalProjection(
        context,
        Number(key.slice("chain_".length)),
      ),
    );
  }
  const expectations = chains.map(({ receiving, transformation, shipping }) =>
    chainTraceExpectation(
      receiving.finalized.record,
      receiving.lots,
      transformation,
      shipping.shipments,
      null,
    ),
  );
  const lots = expectations.flatMap((e) => e.lots);
  const events = expectations.flatMap((e) => e.events);
  const relations = expectations.flatMap((e) =>
    e.edges.map((edge) => {
      const role =
        edge.kind === "transformation_input"
          ? "input"
          : edge.kind === "transformation_output"
            ? "output"
            : edge.kind;
      const lotNode = role === "receiving" || role === "output" ? edge.to : edge.from;
      if (!lotNode.startsWith("lot:")) throw requestError("conflict");
      return { eventId: edge.eventId, lotId: lotNode.slice(4), lineNo: edge.lineNo, role };
    }),
  );
  const scope = { tlcs: [...new Set(lots.map((l) => l.tlc))].sort() };
  return {
    recipe,
    plan,
    scope,
    projectionDigest: canonicalExportDigest(chains),
    selection: {
      scope,
      lotIds: lots.map((l) => l.id).sort(),
      seeds: ordered([
        ...lots.map((l) => ({ kind: "lot", id: l.id })),
        ...events.map((e) => ({ kind: "event", id: e.id })),
      ]),
      records: ordered(
        events.map((e) => ({
          eventId: e.id,
          revision: e.revision,
          rootEventId: e.rootId,
          reason: "match",
        })),
      ),
      relations: ordered(relations),
    },
  };
}
export type DatasetRequestSelection = Awaited<ReturnType<typeof readRequestSelection>>;
export function checkRequestSelection(
  snapshot: UsRequestSnapshot,
  selected: DatasetRequestSelection,
) {
  equalRequest(
    {
      ...snapshot.selection,
      seeds: ordered(snapshot.selection.seeds),
      records: ordered(snapshot.selection.records),
      relations: ordered(snapshot.selection.relations),
    },
    selected.selection,
  );
  equalRequest(snapshot.plan, {
    id: selected.plan.plan.id,
    pdfSha256: selected.plan.artifact.sha256,
  });
  if (snapshot.findings.some((finding) => finding.severity !== "info"))
    throw requestError("conflict");
  if (snapshot.sources.some((source) => source.lifecycle !== "current_finalized"))
    throw requestError("conflict");
}
