import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  caseListQuerySchema,
  caseListResultSchema,
  caseLookupQuerySchema,
  caseLookupResultSchema,
  caseRowSchema,
  platformUuidSchema,
  type CaseRow,
} from "@markiro/platform-contracts";
import { NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { readCurrentTransformationOrigin } from "../transformation/us-transformation-origin";
import { caseUnavailable } from "./us-case-operations";

const links = schema.traceLotBoxes;
const boxes = schema.boxes;
const markers = schema.traceabilitySyntheticCaseOrigins;
type Joined = {
  link: typeof links.$inferSelect;
  currentSscc: string | null;
  syntheticBoxId: string | null;
  linkedAtCursor: string;
};

function caseRow(row: Joined, originState: "current" | "gap"): CaseRow {
  const link = row.link;
  const parsed = caseRowSchema.safeParse({
    linkId: link.id,
    boxId: link.boxId,
    lotId: link.lotId,
    ssccAtLink: link.ssccAtLink,
    linkSource: link.linkSource,
    provenance: row.syntheticBoxId ? "synthetic_demo" : "existing_record",
    linkedAt: link.linkedAt.toISOString(),
    linkedBy: link.linkedBy,
    unlinkedAt: link.unlinkedAt?.toISOString() ?? null,
    unlinkedBy: link.unlinkedBy,
    unlinkReason: link.unlinkReason,
    originState,
    ssccState: link.ssccAtLink === row.currentSscc ? "consistent" : "inconsistent",
  });
  if (!parsed.success) throw caseUnavailable();
  return parsed.data;
}

function joinedLinks(tx: UsMasterDataTransaction) {
  return tx
    .select({
      link: links,
      currentSscc: boxes.sscc,
      syntheticBoxId: markers.boxId,
      linkedAtCursor: sql<string>`to_char(${links.linkedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(links)
    .innerJoin(boxes, and(eq(boxes.tenantId, links.tenantId), eq(boxes.id, links.boxId)))
    .leftJoin(markers, and(eq(markers.tenantId, links.tenantId), eq(markers.boxId, links.boxId)));
}

/** Live cursor pagination; concurrent inserts may appear on later pages. */
export function listCases(
  db: Db,
  tenantId: string,
  actorUserId: string,
  rawLotId: unknown,
  rawQuery: unknown,
) {
  return db.transaction(
    async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const lotId = parseMasterDataInput(platformUuidSchema, rawLotId);
      const queryInput =
        typeof rawQuery === "object" &&
        rawQuery !== null &&
        "history" in rawQuery &&
        typeof rawQuery.history === "boolean"
          ? { ...rawQuery, history: String(rawQuery.history) }
          : rawQuery;
      const query = parseMasterDataInput(caseListQuerySchema, queryInput);
      const origin = await readCurrentTransformationOrigin(tx, tenantId, lotId);
      const originState = origin.currentOrigin ? "current" : "gap";
      const cursor = query.cursor
        ? (JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as [string, string])
        : null;
      const cursorPredicate = cursor
        ? sql`(${links.linkedAt}, ${links.id}) > (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
        : undefined;
      const [count] = await tx
        .select({ activeCount: sql<number>`count(*)::int` })
        .from(links)
        .where(and(eq(links.tenantId, tenantId), eq(links.lotId, lotId), isNull(links.unlinkedAt)));
      const rows = await joinedLinks(tx)
        .where(
          and(
            eq(links.tenantId, tenantId),
            eq(links.lotId, lotId),
            query.history ? undefined : isNull(links.unlinkedAt),
            cursorPredicate,
          ),
        )
        .orderBy(asc(links.linkedAt), asc(links.id))
        .limit(query.limit + 1);
      const visible = rows.slice(0, query.limit);
      const last = visible.at(-1);
      const nextCursor =
        rows.length > query.limit && last
          ? Buffer.from(JSON.stringify([last.linkedAtCursor, last.link.id])).toString("base64url")
          : null;
      const parsed = caseListResultSchema.safeParse({
        lotId,
        originState,
        activeCount: count?.activeCount ?? 0,
        rows: visible.map((row) => caseRow(row, originState)),
        nextCursor,
      });
      if (!parsed.success) throw caseUnavailable();
      return parsed.data;
    },
    { isolationLevel: "repeatable read" },
  );
}

export function lookupCase(db: Db, tenantId: string, actorUserId: string, rawQuery: unknown) {
  return db.transaction(
    async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const query = parseMasterDataInput(caseLookupQuerySchema, rawQuery);
      const [box] = await tx
        .select({ id: boxes.id, sscc: boxes.sscc, syntheticBoxId: markers.boxId })
        .from(boxes)
        .leftJoin(markers, and(eq(markers.tenantId, boxes.tenantId), eq(markers.boxId, boxes.id)))
        .where(and(eq(boxes.tenantId, tenantId), eq(boxes.sscc, query.sscc)))
        .limit(1);
      if (!box || !box.sscc) throw new NotFoundException({ code: "case_not_found" });
      const [row] = await joinedLinks(tx)
        .where(and(eq(links.tenantId, tenantId), eq(links.boxId, box.id), isNull(links.unlinkedAt)))
        .limit(1);
      let activeLink: CaseRow | null = null;
      if (row) {
        const origin = await readCurrentTransformationOrigin(tx, tenantId, row.link.lotId);
        activeLink = caseRow(row, origin.currentOrigin ? "current" : "gap");
      }
      const parsed = caseLookupResultSchema.safeParse({
        boxId: box.id,
        sscc: box.sscc,
        provenance: box.syntheticBoxId ? "synthetic_demo" : "existing_record",
        activeLink,
      });
      if (!parsed.success) throw caseUnavailable();
      return parsed.data;
    },
    { isolationLevel: "repeatable read" },
  );
}
