import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
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
export const MAX_REGISTRY_PAGE_MEMBER_KEYS = 1000;

export function assertBoxRegistrySnapshotCurrent(current: string, until: string): void {
  if (current !== until) {
    throw new ConflictException({ code: "registry_snapshot_changed" });
  }
}

export interface BoxRegistryCandidate {
  id: string;
  shiftId: string;
  terminalId: string | null;
  sscc: string | null;
  productId: string;
  productGtin14: string;
  closedAt: Date | null;
  closureReceivedAt: Date | null;
  disassembledAt: Date | null;
  registryVersion: bigint;
  updatedAt: Date;
}

export interface BoxRegistryMemberFact {
  boxId: string;
  codeHash: string;
  addedAt: Date;
  displacedAt: Date | null;
  removedAt: Date | null;
  registryShiftId: string | null;
  registryTerminalId: string | null;
  registryScannedAt: Date | null;
  registryUpdatedAt: Date | null;
  canonicalRaw: string | null;
  canonicalGtin14: string | null;
  totalMembershipCount: number;
}

export type BoxRegistrySelectExecutor = Pick<Db, "select">;

export async function loadBoxRegistryMembershipCounts(
  executor: BoxRegistrySelectExecutor,
  tenantId: string,
  candidates: readonly BoxRegistryCandidate[],
): Promise<Map<string, number>> {
  if (candidates.length === 0) return new Map();
  const rows = await executor
    .select({
      boxId: schema.boxItems.boxId,
      total: sql<number>`least(count(*), ${MAX_BOX_REGISTRY_MEMBERS + 1})::int`,
    })
    .from(schema.boxItems)
    .where(
      and(
        eq(schema.boxItems.tenantId, tenantId),
        inArray(
          schema.boxItems.boxId,
          candidates.map((candidate) => candidate.id),
        ),
      ),
    )
    .groupBy(schema.boxItems.boxId);
  return new Map(rows.map((row) => [row.boxId, row.total]));
}

export interface BoxRegistryCandidatePrefix {
  candidates: BoxRegistryCandidate[];
  memberKeyBudget: number;
  hasMoreCandidates: boolean;
}

export function selectBoxRegistryCandidatePrefix(
  candidates: readonly BoxRegistryCandidate[],
  membershipCounts: ReadonlyMap<string, number>,
  databaseHasMore: boolean,
): BoxRegistryCandidatePrefix {
  const selected: BoxRegistryCandidate[] = [];
  let memberKeyBudget = 0;
  for (const candidate of candidates) {
    const count = membershipCounts.get(candidate.id) ?? 0;
    const cost = count > MAX_BOX_REGISTRY_MEMBERS ? 0 : count;
    if (selected.length > 0 && memberKeyBudget + cost > MAX_REGISTRY_PAGE_MEMBER_KEYS) break;
    selected.push(candidate);
    memberKeyBudget += cost;
  }
  // The first legal box costs at most 500, and oversized boxes cost zero, so
  // every non-empty candidate page must make progress. Keep this assertion
  // explicit: changing either bound later must not create a cursor stall.
  if (candidates.length > 0 && selected.length === 0) selected.push(candidates[0]!);
  return {
    candidates: selected,
    memberKeyBudget,
    hasMoreCandidates: databaseHasMore || selected.length < candidates.length,
  };
}

/**
 * Resolves bounded membership/current-owner/canonical-code facts in one
 * set-based detail query. Callers that already loaded counts for pagination
 * pass them in, while Task 5 may omit them and pay one bounded count query.
 */
export async function resolveBoxRegistryFacts(
  executor: BoxRegistrySelectExecutor,
  tenantId: string,
  candidates: readonly BoxRegistryCandidate[],
  suppliedCounts?: ReadonlyMap<string, number>,
): Promise<Map<string, BoxRegistryMemberFact[]>> {
  const result = new Map<string, BoxRegistryMemberFact[]>();
  if (candidates.length === 0) return result;
  const counts =
    suppliedCounts ?? (await loadBoxRegistryMembershipCounts(executor, tenantId, candidates));
  const boundedBoxIds = candidates
    .map((candidate) => candidate.id)
    .filter((boxId) => {
      const total = counts.get(boxId) ?? 0;
      return total > 0 && total <= MAX_BOX_REGISTRY_MEMBERS;
    });
  for (const candidate of candidates) result.set(candidate.id, []);

  if (boundedBoxIds.length > 0) {
    const rows = await executor
      .select({
        boxId: schema.boxItems.boxId,
        codeHash: schema.boxItems.codeHash,
        addedAt: schema.boxItems.addedAt,
        displacedAt: schema.boxItems.displacedAt,
        removedAt: schema.boxItems.removedAt,
        registryShiftId: schema.codeRegistry.shiftId,
        registryTerminalId: schema.codeRegistry.terminalId,
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
        totalMembershipCount: counts.get(row.boxId) ?? 0,
      });
    }
  }

  // Preserve the oversized signal without reading any member payloads.
  for (const candidate of candidates) {
    const total = counts.get(candidate.id) ?? 0;
    if (total > MAX_BOX_REGISTRY_MEMBERS) {
      result.set(candidate.id, [
        {
          boxId: candidate.id,
          codeHash: "",
          addedAt: new Date(0),
          displacedAt: null,
          removedAt: null,
          registryShiftId: null,
          registryTerminalId: null,
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
      fact.registryShiftId !== candidate.shiftId ||
      fact.registryTerminalId !== candidate.terminalId ||
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

export function isRegistryRevisionInWindow(
  registryVersion: string,
  since: string | null,
  until: string,
): boolean {
  const revision = BigInt(registryVersion);
  return revision <= BigInt(until) && (since === null || revision > BigInt(since));
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
          v: 2,
          since: window.since,
          until: window.until,
          registryVersion: last.registryVersion.toString(),
          id: last.id,
        })
      : undefined;
  return { until: window.until, items, ...(nextCursor ? { nextCursor } : {}) };
}

@Injectable()
export class BoxRegistryService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async currentVersion(tenantId: string): Promise<string> {
    const [versionRow] = await this.db
      .select({ currentVersion: schema.boxRegistryVersions.currentVersion })
      .from(schema.boxRegistryVersions)
      .where(eq(schema.boxRegistryVersions.tenantId, tenantId));
    return (versionRow?.currentVersion ?? 0n).toString();
  }

  async list(tenantId: string, query: BoxRegistryQueryDto): Promise<KioskBoxRegistryPage> {
    const initialVersion = await this.currentVersion(tenantId);
    const window = resolveBoxRegistryWindow(query, initialVersion);
    assertBoxRegistrySnapshotCurrent(initialVersion, window.until);
    const since = window.since === null ? null : BigInt(window.since);
    const until = BigInt(window.until);
    const afterRegistryVersion =
      window.afterRegistryVersion === null ? null : BigInt(window.afterRegistryVersion);
    const lowerBound =
      afterRegistryVersion !== null && window.afterId !== null
        ? or(
            gt(schema.boxes.registryVersion, afterRegistryVersion),
            and(
              eq(schema.boxes.registryVersion, afterRegistryVersion),
              gt(schema.boxes.id, window.afterId),
            ),
          )
        : since === null
          ? undefined
          : gt(schema.boxes.registryVersion, since);

    const rows = await this.db
      .select({
        id: schema.boxes.id,
        shiftId: schema.boxes.shiftId,
        terminalId: schema.boxes.terminalId,
        sscc: schema.boxes.sscc,
        productId: schema.shifts.productId,
        productGtin14: schema.products.gtin14,
        closedAt: schema.boxes.closedAt,
        closureReceivedAt: schema.boxes.closureReceivedAt,
        disassembledAt: schema.boxes.disassembledAt,
        registryVersion: schema.boxes.registryVersion,
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
          lte(schema.boxes.registryVersion, until),
          lowerBound,
        ),
      )
      .orderBy(asc(schema.boxes.registryVersion), asc(schema.boxes.id))
      .limit(window.limit + 1);

    const candidateWindow = rows.slice(0, window.limit);
    const counts = await loadBoxRegistryMembershipCounts(this.db, tenantId, candidateWindow);
    const prefix = selectBoxRegistryCandidatePrefix(
      candidateWindow,
      counts,
      rows.length > window.limit,
    );
    const facts = await resolveBoxRegistryFacts(this.db, tenantId, prefix.candidates, counts);
    // Reads above are separate READ COMMITTED statements. Fence the complete
    // page so a commit during candidate/fact resolution forces a restart
    // instead of returning facts from two tenant registry revisions.
    assertBoxRegistrySnapshotCurrent(await this.currentVersion(tenantId), window.until);
    return shapeBoxRegistryPage(prefix.candidates, facts, window, prefix.hasMoreCandidates);
  }
}
