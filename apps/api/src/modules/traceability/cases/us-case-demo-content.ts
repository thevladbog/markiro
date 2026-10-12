import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { CaseLinkResult } from "@markiro/platform-contracts";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support.js";
import type { UsDatasetContext } from "../demo/us-dataset-contract.js";
import type {
  UsDatasetCasesContentInput,
  UsDatasetCasesContentError,
} from "../demo/us-dataset-cases-content.js";
import type { caseDemoAuditIdentity } from "../demo/us-dataset-cases-contract.js";
import { lockEligibleBoxes, runCaseLinkCore } from "./us-case-link-core.js";

/** Caller has authorized, reconstructed its accepted input and locked operations/origins/lots. */
export async function linkPreparedDemoCasesInTransaction(
  tx: UsMasterDataTransaction,
  context: UsDatasetContext,
  input: UsDatasetCasesContentInput,
  operationKey: string,
  requestId: string,
  identity: Readonly<{ digest: string; seed: ReturnType<typeof caseDemoAuditIdentity> }>,
  saved: CaseLinkResult | null,
  error: UsDatasetCasesContentError,
): Promise<CaseLinkResult> {
  const ssccs = input.support.boxes.map((box) => box.sscc).sort();
  const fail = () => error("us_dataset_cases_conflict");
  const shifts = schema.shifts;
  const [shift] = await tx
    .select()
    .from(shifts)
    .where(and(eq(shifts.tenantId, context.tenantId), eq(shifts.id, input.support.shiftId)))
    .for("share");
  if (
    !shift ||
    shift.productId !== input.outputProductId ||
    shift.mode !== "aggregation" ||
    shift.status !== "planned" ||
    shift.numberMonthKey !== input.support.numberMonthKey ||
    shift.numberSeq !== input.support.numberSeq
  )
    throw fail();
  const boxes = await lockEligibleBoxes(tx, context.tenantId, input.outputLotId, ssccs);
  const markers = schema.traceabilitySyntheticCaseOrigins;
  const ownedMarkers = await tx
    .select()
    .from(markers)
    .where(
      and(
        eq(markers.tenantId, context.tenantId),
        inArray(
          markers.boxId,
          boxes.map((box) => box.id),
        ),
      ),
    )
    .orderBy(asc(markers.boxId))
    .for("share");
  const links = schema.traceLotBoxes;
  const history = await tx
    .select()
    .from(links)
    .where(
      and(
        eq(links.tenantId, context.tenantId),
        inArray(
          links.boxId,
          boxes.map((box) => box.id),
        ),
      ),
    );
  if (ownedMarkers.length !== boxes.length || history.length !== (saved ? boxes.length : 0))
    throw fail();
  for (const box of boxes) {
    const binding = input.support.boxes.find((row) => row.id === box.id);
    const marker = ownedMarkers.find((row) => row.boxId === box.id);
    if (
      !binding ||
      binding.sscc !== box.sscc ||
      binding.deviceBoxId !== box.deviceBoxId ||
      box.shiftId !== input.support.shiftId ||
      marker?.seedId !== input.references.datasetId ||
      marker.seedVersion !== 1
    )
      throw fail();
    if (saved) {
      const expected = saved.created.find((row) => row.boxId === box.id),
        link = box.activeLink;
      if (
        !expected ||
        !link ||
        canonicalExportDigest({
          id: link.id,
          lotId: link.lotId,
          sscc: link.ssccAtLink,
          source: link.linkSource,
          actor: link.linkedBy,
          at: link.linkedAt.toISOString(),
          unlinkedAt: link.unlinkedAt,
          unlinkedBy: link.unlinkedBy,
          unlinkReason: link.unlinkReason,
        }) !==
          canonicalExportDigest({
            id: expected.linkId,
            lotId: expected.lotId,
            sscc: expected.ssccAtLink,
            source: expected.linkSource,
            actor: expected.linkedBy,
            at: expected.linkedAt,
            unlinkedAt: null,
            unlinkedBy: null,
            unlinkReason: null,
          })
      )
        throw fail();
    } else if (box.activeLink) throw fail();
  }
  return runCaseLinkCore(
    tx,
    context.tenantId,
    context.actorUserId,
    input.outputLotId,
    { operationKey: operationKey, ssccs },
    requestId,
    {
      source: "demo_seed",
      digest: identity.digest,
      seed: identity.seed,
    },
  );
}
