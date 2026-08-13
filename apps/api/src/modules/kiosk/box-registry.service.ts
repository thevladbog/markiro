import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { canonicalizeKm, isValidSscc, kmKey } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import {
  encodeBoxRegistryCursor,
  resolveBoxRegistryWindow,
  type BoxRegistryQueryDto,
  type KioskBoxRegistryChange,
  type KioskBoxRegistryPage,
  type ResolvedBoxRegistryWindow,
} from "./box-registry.dto";

export const MAX_BOX_REGISTRY_MEMBERS = 500;

export interface BoxRegistryCandidate {
  id: string;
  sscc: string | null;
  productId: string;
  productGtin14: string;
  closedAt: Date | null;
  closureReceivedAt: Date | null;
  disassembledAt: Date | null;
  updatedAt: Date;
}

export interface BoxRegistryMemberFact {
  boxId: string;
  codeHash: string;
  addedAt: Date;
  displacedAt: Date | null;
  removedAt: Date | null;
  registryScannedAt: Date | null;
  registryUpdatedAt: Date | null;
  canonicalRaw: string | null;
  canonicalGtin14: string | null;
  totalMembershipCount: number;
}

export type BoxRegistrySelectExecutor = Pick<Db, "select">;

/**
 * Resolves bounded membership/current-owner/canonical-code facts in two
 * set-based queries. It is intentionally Nest-free and accepts a transaction
 * handle as well as the root DB so order admission can reuse exactly the same
 * evidence and eligibility evaluator.
 */
export async function resolveBoxRegistryFacts(
  executor: BoxRegistrySelectExecutor,
  tenantId: string,
  candidates: readonly BoxRegistryCandidate[],
): Promise<Map<string, BoxRegistryMemberFact[]>> {
  const result = new Map<string, BoxRegistryMemberFact[]>();
  if (candidates.length === 0) return result;
  const boxIds = candidates.map((candidate) => candidate.id);
  const counts = await executor
    .select({ boxId: schema.boxItems.boxId, total: count() })
    .from(schema.boxItems)
    .where(and(eq(schema.boxItems.tenantId, tenantId), inArray(schema.boxItems.boxId, boxIds)))
    .groupBy(schema.boxItems.boxId);
  const countByBox = new Map(counts.map((row) => [row.boxId, Number(row.total)]));
  const boundedBoxIds = boxIds.filter(
    (boxId) => (countByBox.get(boxId) ?? 0) <= MAX_BOX_REGISTRY_MEMBERS,
  );

  for (const boxId of boxIds) result.set(boxId, []);
  if (boundedBoxIds.length === 0) return result;

  const rows = await executor
    .select({
      boxId: schema.boxItems.boxId,
      codeHash: schema.boxItems.codeHash,
      addedAt: schema.boxItems.addedAt,
      displacedAt: schema.boxItems.displacedAt,
      removedAt: schema.boxItems.removedAt,
      registryScannedAt: schema.codeRegistry.scannedAt,
      registryUpdatedAt: schema.codeRegistry.updatedAt,
      canonicalRaw: schema.codes.canonicalRaw,
      canonicalGtin14: schema.codes.gtin14,
    })
    .from(schema.boxItems)
    .leftJoin(
      schema.codeRegistry,
      and(
        eq(schema.codeRegistry.tenantId, schema.boxItems.tenantId),
        eq(schema.codeRegistry.codeHash, schema.boxItems.codeHash),
      ),
    )
    .leftJoin(
      schema.codes,
      and(
        eq(schema.codes.tenantId, schema.boxItems.tenantId),
        eq(schema.codes.codeHash, schema.boxItems.codeHash),
        eq(schema.codes.scannedAt, schema.codeRegistry.scannedAt),
      ),
    )
    .where(
      and(eq(schema.boxItems.tenantId, tenantId), inArray(schema.boxItems.boxId, boundedBoxIds)),
    )
    .orderBy(asc(schema.boxItems.boxId), asc(schema.boxItems.codeHash));

  for (const row of rows) {
    result.get(row.boxId)!.push({
      ...row,
      totalMembershipCount: countByBox.get(row.boxId) ?? 0,
    });
  }
  // Preserve the oversized signal without reading any member payloads.
  for (const boxId of boxIds) {
    const total = countByBox.get(boxId) ?? 0;
    if (total > MAX_BOX_REGISTRY_MEMBERS) {
      result.set(boxId, [
        {
          boxId,
          codeHash: "",
          addedAt: new Date(0),
          displacedAt: null,
          removedAt: null,
          registryScannedAt: null,
          registryUpdatedAt: null,
          canonicalRaw: null,
          canonicalGtin14: null,
          totalMembershipCount: total,
        },
      ]);
    }
  }
  return result;
}

function ineligibleChange(
  candidate: BoxRegistryCandidate,
  delta: boolean,
): KioskBoxRegistryChange | null {
  if (!delta || candidate.sscc === null || !isValidSscc(candidate.sscc)) return null;
  return {
    kind: "remove",
    sscc: candidate.sscc,
    updatedAt: candidate.updatedAt.toISOString(),
  };
}

export function evaluateBoxRegistryCandidate(
  candidate: BoxRegistryCandidate,
  facts: readonly BoxRegistryMemberFact[],
  delta: boolean,
): KioskBoxRegistryChange | null {
  if (
    candidate.sscc === null ||
    !isValidSscc(candidate.sscc) ||
    candidate.closedAt === null ||
    candidate.closureReceivedAt === null ||
    candidate.disassembledAt !== null
  ) {
    return ineligibleChange(candidate, delta);
  }
  const totalMembershipCount = facts[0]?.totalMembershipCount ?? 0;
  if (
    totalMembershipCount === 0 ||
    totalMembershipCount > MAX_BOX_REGISTRY_MEMBERS ||
    facts.length !== totalMembershipCount
  ) {
    return ineligibleChange(candidate, delta);
  }

  const activeFacts: BoxRegistryMemberFact[] = [];
  for (const fact of facts) {
    if (
      (fact.removedAt !== null && fact.removedAt > candidate.closureReceivedAt) ||
      (fact.displacedAt !== null && fact.displacedAt > candidate.closureReceivedAt)
    ) {
      return ineligibleChange(candidate, delta);
    }
    if (fact.removedAt !== null || fact.displacedAt !== null) continue;
    activeFacts.push(fact);
  }
  if (activeFacts.length === 0) return ineligibleChange(candidate, delta);

  const keys: string[] = [];
  const seenHashes = new Set<string>();
  const seenKeys = new Set<string>();
  for (const fact of activeFacts) {
    if (
      seenHashes.has(fact.codeHash) ||
      fact.registryScannedAt === null ||
      fact.registryUpdatedAt === null ||
      fact.registryScannedAt.getTime() !== fact.addedAt.getTime() ||
      fact.registryUpdatedAt > candidate.closureReceivedAt ||
      fact.canonicalRaw === null ||
      fact.canonicalGtin14 !== candidate.productGtin14
    ) {
      return ineligibleChange(candidate, delta);
    }
    seenHashes.add(fact.codeHash);
    try {
      const parsed = canonicalizeKm(fact.canonicalRaw);
      const key = kmKey(parsed);
      if (parsed.gtin14 !== candidate.productGtin14 || seenKeys.has(key)) {
        return ineligibleChange(candidate, delta);
      }
      seenKeys.add(key);
      keys.push(key);
    } catch {
      return ineligibleChange(candidate, delta);
    }
  }

  keys.sort();
  return {
    kind: "upsert",
    boxId: candidate.id,
    sscc: candidate.sscc,
    productId: candidate.productId,
    bottleCount: activeFacts.length,
    contentKeys: keys,
    updatedAt: candidate.updatedAt.toISOString(),
  };
}

export function shapeBoxRegistryPage(
  candidates: readonly BoxRegistryCandidate[],
  factsByBox: ReadonlyMap<string, readonly BoxRegistryMemberFact[]>,
  window: ResolvedBoxRegistryWindow,
  hasMoreCandidates: boolean,
): KioskBoxRegistryPage {
  const delta = window.since !== null;
  const items = candidates
    .map((candidate) =>
      evaluateBoxRegistryCandidate(candidate, factsByBox.get(candidate.id) ?? [], delta),
    )
    .filter((change): change is KioskBoxRegistryChange => change !== null);
  const last = candidates.at(-1);
  const nextCursor =
    hasMoreCandidates && last
      ? encodeBoxRegistryCursor({
          v: 1,
          since: window.since,
          until: window.until,
          updatedAt: last.updatedAt.toISOString(),
          id: last.id,
        })
      : undefined;
  return { until: window.until, items, ...(nextCursor ? { nextCursor } : {}) };
}

@Injectable()
export class BoxRegistryService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(tenantId: string, query: BoxRegistryQueryDto): Promise<KioskBoxRegistryPage> {
    const nowResult = await this.db.execute<{ serverNow: Date }>(
      sql`select clock_timestamp() as "serverNow"`,
    );
    const serverNow = nowResult.rows[0]?.serverNow;
    if (!(serverNow instanceof Date)) throw new BadRequestException("Server clock unavailable");
    const window = resolveBoxRegistryWindow(query, serverNow.toISOString());
    const since = window.since === null ? null : new Date(window.since);
    const until = new Date(window.until);
    const afterUpdatedAt = window.afterUpdatedAt === null ? null : new Date(window.afterUpdatedAt);
    const lowerBound =
      afterUpdatedAt !== null && window.afterId !== null
        ? or(
            gt(schema.boxes.updatedAt, afterUpdatedAt),
            and(eq(schema.boxes.updatedAt, afterUpdatedAt), gt(schema.boxes.id, window.afterId)),
          )
        : since === null
          ? undefined
          : gt(schema.boxes.updatedAt, since);

    const rows = await this.db
      .select({
        id: schema.boxes.id,
        sscc: schema.boxes.sscc,
        productId: schema.shifts.productId,
        productGtin14: schema.products.gtin14,
        closedAt: schema.boxes.closedAt,
        closureReceivedAt: schema.boxes.closureReceivedAt,
        disassembledAt: schema.boxes.disassembledAt,
        updatedAt: schema.boxes.updatedAt,
      })
      .from(schema.boxes)
      .innerJoin(
        schema.shifts,
        and(
          eq(schema.shifts.tenantId, schema.boxes.tenantId),
          eq(schema.shifts.id, schema.boxes.shiftId),
        ),
      )
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.shifts.tenantId),
          eq(schema.products.id, schema.shifts.productId),
        ),
      )
      .where(
        and(
          eq(schema.boxes.tenantId, tenantId),
          isNotNull(schema.boxes.sscc),
          lte(schema.boxes.updatedAt, until),
          lowerBound,
        ),
      )
      .orderBy(asc(schema.boxes.updatedAt), asc(schema.boxes.id))
      .limit(window.limit + 1);
    const hasMoreCandidates = rows.length > window.limit;
    const candidates = rows.slice(0, window.limit);
    const facts = await resolveBoxRegistryFacts(this.db, tenantId, candidates);
    return shapeBoxRegistryPage(candidates, facts, window, hasMoreCandidates);
  }
}
