import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  caseLinkCommandSchema,
  caseLinkResultSchema,
  caseRowSchema,
  caseUnlinkCommandSchema,
  caseUnlinkResultSchema,
  platformUuidSchema,
} from "@markiro/platform-contracts";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
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
  replayCaseLink,
  replayCaseUnlink,
} from "./us-case-operations";

const links = schema.traceLotBoxes;
type Link = typeof links.$inferSelect;
export async function lockOutputLot(tx: UsMasterDataTransaction, tenantId: string, lotId: string) {
  const t = schema.traceabilityLots;
  const [lot] = await tx
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.id, lotId)))
    .for("update");
  if (!lot) throw new NotFoundException({ code: "case_lot_not_found" });
  return lot;
}
export async function lockEligibleBoxes(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
  ssccs: readonly string[],
) {
  const t = schema.boxes;
  const boxes = await tx
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), inArray(t.sscc, [...ssccs])))
    .orderBy(asc(t.sscc), asc(t.id))
    .for("update");
  if (boxes.length !== ssccs.length) throw new NotFoundException({ code: "case_not_found" });
  const active = await tx
    .select()
    .from(links)
    .where(
      and(
        eq(links.tenantId, tenantId),
        inArray(
          links.boxId,
          boxes.map((box) => box.id),
        ),
        isNull(links.unlinkedAt),
      ),
    );
  return boxes.map((box) => {
    if (box.disassembledAt) throw new ConflictException({ code: "case_disassembled" });
    const link = active.find((row) => row.boxId === box.id);
    if (link && link.ssccAtLink !== box.sscc)
      throw new ConflictException({ code: "case_sscc_inconsistent" });
    if (link && link.lotId !== lotId) throw new ConflictException({ code: "case_link_conflict" });
    return { ...box, activeLink: link, activeLinkToSameLot: link !== undefined };
  });
}
async function caseRow(
  tx: UsMasterDataTransaction,
  tenantId: string,
  link: Link,
  originState: "current" | "gap",
  currentSscc: string | null,
) {
  const t = schema.traceabilitySyntheticCaseOrigins;
  const [marker] = await tx
    .select({ boxId: t.boxId })
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.boxId, link.boxId)));
  const parsed = caseRowSchema.safeParse({
    linkId: link.id,
    boxId: link.boxId,
    lotId: link.lotId,
    ssccAtLink: link.ssccAtLink,
    linkSource: link.linkSource,
    provenance: marker ? "synthetic_demo" : "existing_record",
    linkedAt: link.linkedAt.toISOString(),
    linkedBy: link.linkedBy,
    unlinkedAt: link.unlinkedAt?.toISOString() ?? null,
    unlinkedBy: link.unlinkedBy,
    unlinkReason: link.unlinkReason,
    originState,
    ssccState: link.ssccAtLink === currentSscc ? "consistent" : "inconsistent",
  });
  if (!parsed.success) throw caseUnavailable();
  return parsed.data;
}
export function linkCases(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
) {
  return caseTransaction(db, async (tx) => {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.TRANSFORMATION_WRITE);
    const lotId = parseMasterDataInput(platformUuidSchema, id),
      value = parseMasterDataInput(caseLinkCommandSchema, input);
    const digest = caseCommandDigest("case.link", lotId, value);
    const stored = await lockCaseOperation(tx, tenantId, "case.link", value.operationKey);
    if (stored) return replayCaseLink(stored, digest, lotId);
    await lockOutputLot(tx, tenantId, lotId);
    const boxes = await lockEligibleBoxes(tx, tenantId, lotId, [...value.ssccs].sort());
    const toCreate = boxes.filter((box) => !box.activeLinkToSameLot);
    if (toCreate.length) await bumpLotDependencyVersions(tx, tenantId, [lotId]);
    const origin = await readCurrentTransformationOrigin(tx, tenantId, lotId);
    if (toCreate.length && !origin.currentOrigin)
      throw new ConflictException({ code: "case_origin_not_current" });
    const originState = origin.currentOrigin ? "current" : "gap";
    const created = [],
      unchanged = [];
    for (const box of boxes) {
      if (box.activeLink)
        unchanged.push(await caseRow(tx, tenantId, box.activeLink, originState, box.sscc));
      else {
        if (!box.sscc) throw caseUnavailable();
        const [link] = await tx
          .insert(links)
          .values({
            tenantId,
            boxId: box.id,
            lotId,
            ssccAtLink: box.sscc,
            linkSource: "manual",
            linkedBy: actorUserId,
          })
          .returning();
        if (!link) throw caseUnavailable();
        created.push(await caseRow(tx, tenantId, link, originState, box.sscc));
      }
    }
    const result = caseLinkResultSchema.parse({ lotId, created, unchanged });
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: "case.link",
      outcome: "success",
      targetType: "traceability_lot",
      targetId: lotId,
      before: { links: unchanged },
      after: { tenantId, operationKey: value.operationKey, lotId, source: "manual", result },
      requestId,
    });
    await tx.insert(schema.traceLotBoxOperations).values({
      tenantId,
      command: "case.link",
      operationKey: value.operationKey,
      inputDigest: digest,
      targetId: lotId,
      result,
    });
    return result;
  });
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
