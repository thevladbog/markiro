import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  caseUnlinkCommandSchema,
  caseUnlinkResultSchema,
  platformUuidSchema,
  type CaseLinkResult,
} from "@markiro/platform-contracts";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { bumpLotDependencyVersions } from "../lots/us-current-consumers";
import { readCurrentTransformationOrigin } from "../transformation/us-transformation-origin";
import {
  caseCommandDigest,
  caseTransaction,
  caseUnavailable,
  lockCaseOperation,
  replayCaseUnlink,
} from "./us-case-operations";
import { caseRow, lockOutputLot, runCaseLinkCore } from "./us-case-link-core";
export { lockOutputLot, lockEligibleBoxes } from "./us-case-link-core";

const links = schema.traceLotBoxes;
export function linkCases(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
) {
  return caseTransaction(db, (tx) =>
    linkCasesInTransaction(tx, tenantId, actorUserId, id, input, requestId),
  );
}
export function linkCasesInTransaction(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
): Promise<CaseLinkResult> {
  return runCaseLinkCore(tx, tenantId, actorUserId, id, input, requestId, "manual");
}
export function unlinkCase(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  rawLinkId: unknown,
  input: unknown,
  requestId: string,
) {
  return caseTransaction(db, async (tx) => {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.TRANSFORMATION_WRITE);
    const lotId = parseMasterDataInput(platformUuidSchema, id),
      linkId = parseMasterDataInput(platformUuidSchema, rawLinkId),
      value = parseMasterDataInput(caseUnlinkCommandSchema, input);
    const digest = caseCommandDigest("case.unlink", lotId, { linkId, reason: value.reason });
    const stored = await lockCaseOperation(tx, tenantId, "case.unlink", value.operationKey);
    if (stored) return replayCaseUnlink(stored, digest, lotId, linkId);
    await lockOutputLot(tx, tenantId, lotId);
    const [link] = await tx
      .select()
      .from(links)
      .where(and(eq(links.tenantId, tenantId), eq(links.lotId, lotId), eq(links.id, linkId)));
    if (!link) throw new NotFoundException({ code: "case_link_not_found" });
    const b = schema.boxes;
    const [box] = await tx
      .select()
      .from(b)
      .where(and(eq(b.tenantId, tenantId), eq(b.id, link.boxId)))
      .for("update");
    if (!box) throw caseUnavailable();
    if (link.unlinkedAt) throw new ConflictException({ code: "case_link_stale" });
    await bumpLotDependencyVersions(tx, tenantId, [lotId]);
    const origin = await readCurrentTransformationOrigin(tx, tenantId, lotId);
    const before = await caseRow(
      tx,
      tenantId,
      link,
      origin.currentOrigin ? "current" : "gap",
      box.sscc,
    );
    const [removed] = await tx
      .update(links)
      .set({ unlinkedAt: new Date(), unlinkedBy: actorUserId, unlinkReason: value.reason })
      .where(
        and(
          eq(links.tenantId, tenantId),
          eq(links.lotId, lotId),
          eq(links.id, linkId),
          isNull(links.unlinkedAt),
        ),
      )
      .returning();
    if (!removed) throw new ConflictException({ code: "case_link_stale" });
    const result = caseUnlinkResultSchema.parse({
      linkId,
      lotId,
      unlinkedAt: removed.unlinkedAt?.toISOString(),
      unlinkedBy: actorUserId,
      reason: value.reason,
    });
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: "case.unlink",
      outcome: "success",
      targetType: "trace_lot_box",
      targetId: linkId,
      before: { link: before },
      after: {
        tenantId,
        operationKey: value.operationKey,
        lotId,
        boxId: link.boxId,
        linkId,
        ssccAtLink: link.ssccAtLink,
        source: link.linkSource,
        reason: value.reason,
        result,
      },
      requestId,
    });
    await tx.insert(schema.traceLotBoxOperations).values({
      tenantId,
      command: "case.unlink",
      operationKey: value.operationKey,
      inputDigest: digest,
      targetId: linkId,
      result,
    });
    return result;
  });
}
