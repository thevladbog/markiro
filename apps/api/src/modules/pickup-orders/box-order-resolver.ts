import { PayloadTooLargeException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { canonicalizeKm, kmKey } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import {
  evaluateBoxRegistryCandidate,
  loadBoxRegistryMembershipCounts,
  MAX_BOX_REGISTRY_MEMBERS,
  MAX_REGISTRY_PAGE_MEMBER_KEYS,
  resolveBoxRegistryFacts,
  type BoxRegistryCandidate,
  type BoxRegistryMemberFact,
} from "../kiosk/box-registry.service";
import type { BoxConflict, CreateOrderBoxInput, OrderConflict } from "./dto";

interface OrderBoxCandidate extends BoxRegistryCandidate {
  unitPrice: string | null;
}

export interface ResolvedOrderBoxMember {
  rawKm: string;
  kmKey: string;
  gtin14: string;
  serial: string;
}

export interface ResolvedOrderBox {
  boxId: string;
  sscc: string;
  productId: string;
  bottleCount: number;
  unitPrice: string | null;
  members: ResolvedOrderBoxMember[];
}

export interface ResolvedBoxSet {
  boxes: ResolvedOrderBox[];
  conflicts: BoxConflict[];
}

export function assertOrderBoxMemberBudget(memberCount: number): void {
  if (memberCount > MAX_REGISTRY_PAGE_MEMBER_KEYS) {
    throw new PayloadTooLargeException({ code: "box_request_too_large" });
  }
}

export type BoxOrderSelectExecutor = Pick<Db, "select">;

function ineligibleReason(
  candidate: OrderBoxCandidate,
  facts: readonly BoxRegistryMemberFact[],
): BoxConflict["reason"] {
  if (candidate.closedAt === null || candidate.closureReceivedAt === null) return "box_not_closed";
  if (candidate.disassembledAt !== null) return "box_disassembled";
  const active = facts.filter((fact) => fact.removedAt === null && fact.displacedAt === null);
  const gtins = new Set(active.map((fact) => fact.canonicalGtin14).filter(Boolean));
  if (gtins.size > 1 || (gtins.size === 1 && !gtins.has(candidate.productGtin14))) {
    return "mixed_product_box";
  }
  return "box_contents_changed";
}

export async function resolveOrderBoxes(
  tx: BoxOrderSelectExecutor,
  tenantId: string,
  inputs: readonly CreateOrderBoxInput[],
): Promise<ResolvedBoxSet> {
  if (inputs.length === 0) return { boxes: [], conflicts: [] };
  const ssccs = inputs.map((input) => input.sscc);
  const candidates = (await tx
    .select({
      id: schema.boxes.id,
      shiftId: schema.boxes.shiftId,
      terminalId: schema.boxes.terminalId,
      sscc: schema.boxes.sscc,
      productId: schema.shifts.productId,
      productGtin14: schema.products.gtin14,
      unitPrice: schema.products.unitPrice,
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
    .where(and(eq(schema.boxes.tenantId, tenantId), inArray(schema.boxes.sscc, ssccs)))
    .orderBy(asc(schema.boxes.id))
    .for("update")) as OrderBoxCandidate[];

  const counts = await loadBoxRegistryMembershipCounts(tx, tenantId, candidates);
  const aggregateMembers = [...counts.values()].reduce((total, count) => total + count, 0);
  assertOrderBoxMemberBudget(aggregateMembers);
  const factsByBox = await resolveBoxRegistryFacts(tx, tenantId, candidates, counts);
  const candidatesBySscc = new Map(candidates.map((candidate) => [candidate.sscc, candidate]));
  const boxes: ResolvedOrderBox[] = [];
  const conflicts: BoxConflict[] = [];

  for (const input of inputs) {
    const candidate = candidatesBySscc.get(input.sscc);
    if (!candidate) {
      conflicts.push({ sscc: input.sscc, bottleCount: null, reason: "unknown_box" });
      continue;
    }
    const facts = factsByBox.get(candidate.id) ?? [];
    const evaluated = evaluateBoxRegistryCandidate(candidate, facts, false);
    if (!evaluated || evaluated.kind !== "upsert") {
      const count = counts.get(candidate.id) ?? 0;
      conflicts.push({
        sscc: input.sscc,
        bottleCount: count > 0 && count <= MAX_BOX_REGISTRY_MEMBERS ? count : null,
        reason: ineligibleReason(candidate, facts),
      });
      continue;
    }
    const members = facts
      .filter((fact) => fact.removedAt === null && fact.displacedAt === null)
      .map((fact) => {
        const parsed = canonicalizeKm(fact.canonicalRaw!);
        return {
          rawKm: fact.canonicalRaw!,
          kmKey: kmKey(parsed),
          gtin14: parsed.gtin14,
          serial: parsed.serial,
        };
      });
    boxes.push({
      boxId: candidate.id,
      sscc: input.sscc,
      productId: candidate.productId,
      bottleCount: members.length,
      unitPrice: candidate.unitPrice,
      members,
    });
  }
  return { boxes, conflicts };
}

export function classifyResolvedBoxConflicts(input: {
  boxes: readonly ResolvedOrderBox[];
  looseKeys: ReadonlySet<string>;
  usedKeys?: ReadonlySet<string>;
}): { accepted: ResolvedOrderBox[]; conflicts: BoxConflict[] } {
  // Loose lines are processed first. Each accepted box then claims all of its
  // members atomically, so only a later overlapping box is rejected.
  const claimedKeys = new Set(input.looseKeys);
  for (const key of input.usedKeys ?? []) claimedKeys.add(key);
  const accepted: ResolvedOrderBox[] = [];
  const conflicts: BoxConflict[] = [];
  for (const box of input.boxes) {
    const duplicate = box.members.some((member) => claimedKeys.has(member.kmKey));
    if (duplicate)
      conflicts.push({ sscc: box.sscc, bottleCount: box.bottleCount, reason: "duplicate" });
    else {
      accepted.push(box);
      for (const member of box.members) claimedKeys.add(member.kmKey);
    }
  }
  return { accepted, conflicts };
}

export function applyOrderLineLimit<TLoose>(input: {
  existingCount: number;
  dayLimit: number;
  limited: boolean;
  loose: readonly TLoose[];
  boxes: readonly ResolvedOrderBox[];
  looseConflict: (item: TLoose) => OrderConflict;
}): {
  acceptedLoose: TLoose[];
  looseConflicts: OrderConflict[];
  acceptedBoxes: ResolvedOrderBox[];
  boxConflicts: BoxConflict[];
} {
  let count = input.existingCount;
  const acceptedLoose: TLoose[] = [];
  const looseConflicts: OrderConflict[] = [];
  for (const item of input.loose) {
    if (!input.limited || count < input.dayLimit) {
      acceptedLoose.push(item);
      count += 1;
    } else looseConflicts.push(input.looseConflict(item));
  }
  const acceptedBoxes: ResolvedOrderBox[] = [];
  const boxConflicts: BoxConflict[] = [];
  for (const box of input.boxes) {
    if (!input.limited || count + box.bottleCount <= input.dayLimit) {
      acceptedBoxes.push(box);
      count += box.bottleCount;
    } else
      boxConflicts.push({ sscc: box.sscc, bottleCount: box.bottleCount, reason: "over_limit" });
  }
  return { acceptedLoose, looseConflicts, acceptedBoxes, boxConflicts };
}

export function reclassifyOrderKmKeyRace<TLoose extends { kmKey: string; rawKm: string }>(input: {
  loose: readonly TLoose[];
  requestedBoxes: readonly CreateOrderBoxInput[];
  attemptedBoxes: readonly ResolvedOrderBox[];
  conflictingKeys: ReadonlySet<string>;
}): {
  loose: TLoose[];
  looseConflicts: OrderConflict[];
  requestedBoxes: CreateOrderBoxInput[];
  boxConflicts: BoxConflict[];
} {
  const loose: TLoose[] = [];
  const looseConflicts: OrderConflict[] = [];
  for (const item of input.loose) {
    if (input.conflictingKeys.has(item.kmKey)) {
      looseConflicts.push({ rawKm: item.rawKm, reason: "duplicate" });
    } else loose.push(item);
  }
  const attemptedBySscc = new Map(input.attemptedBoxes.map((box) => [box.sscc, box]));
  const requestedBoxes: CreateOrderBoxInput[] = [];
  const boxConflicts: BoxConflict[] = [];
  for (const requested of input.requestedBoxes) {
    const box = attemptedBySscc.get(requested.sscc);
    if (box?.members.some((member) => input.conflictingKeys.has(member.kmKey))) {
      boxConflicts.push({
        sscc: box.sscc,
        bottleCount: box.bottleCount,
        reason: "duplicate",
      });
    } else requestedBoxes.push(requested);
  }
  return { loose, looseConflicts, requestedBoxes, boxConflicts };
}
