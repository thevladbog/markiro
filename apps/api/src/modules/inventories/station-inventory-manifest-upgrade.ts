import { and, asc, eq } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";
import { inventorySnapshotContentDigest } from "@markiro/domain";

import {
  parseLegacyStationInventoryManifest,
  parseStationInventoryManifest,
  type LegacyStationInventoryManifest,
  type StationInventoryManifest,
} from "./station-inventory.dto";

export interface StoredStationManifestFacts {
  id: string;
  number: string;
  mode: "check" | "repack";
  productId: string;
  gtin14Snapshot: string;
  lineId: string;
  productionDateFrom: string;
  productionDateTo: string;
  boxLabelTemplateId: string | null;
  activeSnapshotId: string | null;
  stationManifest: unknown;
  authoritativeProductName: string | null;
  authoritativeProductPrintName: string | null;
  authoritativeEgaisCode: string | null;
  authoritativeShelfLifeDays: number | null;
  snapshotId: string | null;
  snapshotRevision: number | null;
  snapshotFixedAt: Date | null;
  snapshotCombinedDigest: string | null;
  emitted: number | null;
  introduced: number | null;
  applied: number | null;
  retired: number | null;
  writtenOff: number | null;
  disaggregation: number | null;
}

type ManifestExecutor = Pick<Db, "select" | "update">;

function tryParseCurrentManifest(value: unknown): StationInventoryManifest | null {
  try {
    return parseStationInventoryManifest(value);
  } catch {
    return null;
  }
}

function tryUpgradeFrozenPrintFacts(
  value: unknown,
  facts: StoredStationManifestFacts,
): StationInventoryManifest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    "productPrintName" in record ||
    "egaisCode" in record ||
    "shelfLifeDays" in record ||
    !("snapshotFixedAt" in record) ||
    !("contentDigest" in record)
  ) {
    return null;
  }
  return tryParseCurrentManifest({
    ...record,
    productPrintName: facts.authoritativeProductPrintName,
    egaisCode: facts.authoritativeEgaisCode,
    shelfLifeDays: facts.authoritativeShelfLifeDays,
  });
}

function declaredCodeCount(facts: StoredStationManifestFacts): number | null {
  const counts = [
    facts.emitted,
    facts.introduced,
    facts.applied,
    facts.retired,
    facts.writtenOff,
    facts.disaggregation,
  ];
  if (counts.some((count) => count === null)) return null;
  return counts.reduce<number>((total, count) => total + (count ?? 0), 0);
}

function anchorsMatch(
  manifest: LegacyStationInventoryManifest,
  facts: StoredStationManifestFacts,
  codeCount: number,
): boolean {
  return (
    facts.activeSnapshotId !== null &&
    facts.snapshotId !== null &&
    facts.snapshotRevision === 1 &&
    facts.snapshotFixedAt !== null &&
    manifest.inventoryId === facts.id &&
    manifest.inventoryNumber === facts.number &&
    manifest.snapshotId === facts.snapshotId &&
    manifest.snapshotId === facts.activeSnapshotId &&
    manifest.snapshotRevision === facts.snapshotRevision &&
    manifest.combinedDigest === facts.snapshotCombinedDigest &&
    manifest.codeCount === codeCount &&
    manifest.mode === facts.mode &&
    manifest.productId === facts.productId &&
    manifest.gtin14 === facts.gtin14Snapshot &&
    manifest.lineId === facts.lineId &&
    manifest.productionDateFrom === facts.productionDateFrom &&
    manifest.productionDateTo === facts.productionDateTo &&
    (manifest.boxLabelTemplate?.id ?? null) === facts.boxLabelTemplateId
  );
}

/**
 * Validates a running manifest against authoritative snapshot anchors. Exact
 * pre-proof manifests are upgraded once from immutable rows, then persisted
 * with a guarded update so concurrent readers cannot overwrite replacement
 * state.
 */
export async function resolveStoredStationInventoryManifest(
  executor: ManifestExecutor,
  tenantId: string,
  facts: StoredStationManifestFacts,
): Promise<StationInventoryManifest> {
  const codeCount = declaredCodeCount(facts);
  if (codeCount === null) throw new Error("Invalid stored station inventory manifest anchors");

  const storedCurrent = tryParseCurrentManifest(facts.stationManifest);
  const upgradedPrintFacts =
    storedCurrent === null ? tryUpgradeFrozenPrintFacts(facts.stationManifest, facts) : null;
  const current = storedCurrent ?? upgradedPrintFacts;
  let manifest: LegacyStationInventoryManifest;
  if (current !== null) {
    if (
      !anchorsMatch(current, facts, codeCount) ||
      current.snapshotFixedAt !== facts.snapshotFixedAt?.toISOString()
    ) {
      throw new Error("Invalid stored station inventory manifest anchors");
    }
    manifest = current;
  } else {
    const legacy = parseLegacyStationInventoryManifest(facts.stationManifest);
    if (!anchorsMatch(legacy, facts, codeCount) || facts.snapshotFixedAt === null) {
      throw new Error("Invalid legacy stored station inventory manifest anchors");
    }
    manifest = legacy;
  }
  const rows = await executor
    .select({
      codeHash: schema.inventorySnapshotCodes.codeHash,
      canonicalRaw: schema.inventorySnapshotCodes.canonicalRaw,
      gtin14: schema.inventorySnapshotCodes.gtin14,
      serial: schema.inventorySnapshotCodes.serial,
      sourceStatus: schema.inventorySnapshotCodes.sourceStatus,
      sourceState: schema.inventorySnapshotCodes.sourceState,
      sourceProductionDate: schema.inventorySnapshotCodes.sourceProductionDate,
      parentSscc: schema.inventorySnapshotCodes.parentSscc,
      expected: schema.inventorySnapshotCodes.expected,
      protected: schema.inventorySnapshotCodes.protected,
    })
    .from(schema.inventorySnapshotCodes)
    .where(
      and(
        eq(schema.inventorySnapshotCodes.tenantId, tenantId),
        eq(schema.inventorySnapshotCodes.snapshotId, manifest.snapshotId),
      ),
    )
    .orderBy(asc(schema.inventorySnapshotCodes.codeHash));
  if (rows.length !== codeCount) {
    throw new Error("Invalid stored station inventory manifest row count");
  }
  const contentDigest = inventorySnapshotContentDigest(rows);
  if (current !== null) {
    if (current.contentDigest !== contentDigest) {
      throw new Error("Invalid stored station inventory manifest content digest");
    }
    if (upgradedPrintFacts !== null) {
      await executor
        .update(schema.inventories)
        .set({ stationManifest: upgradedPrintFacts, updatedAt: new Date() })
        .where(
          and(
            eq(schema.inventories.tenantId, tenantId),
            eq(schema.inventories.id, facts.id),
            eq(schema.inventories.status, "running"),
            eq(schema.inventories.activeSnapshotId, upgradedPrintFacts.snapshotId),
            eq(schema.inventories.stationManifest, facts.stationManifest),
          ),
        );
    }
    return current;
  }

  const upgraded = parseStationInventoryManifest({
    ...manifest,
    productName: facts.authoritativeProductName,
    productPrintName: facts.authoritativeProductPrintName,
    egaisCode: facts.authoritativeEgaisCode,
    shelfLifeDays: facts.authoritativeShelfLifeDays,
    snapshotFixedAt: facts.snapshotFixedAt.toISOString(),
    contentDigest,
  });
  const now = new Date();
  await executor
    .update(schema.inventories)
    .set({ stationManifest: upgraded, updatedAt: now })
    .where(
      and(
        eq(schema.inventories.tenantId, tenantId),
        eq(schema.inventories.id, facts.id),
        eq(schema.inventories.status, "running"),
        eq(schema.inventories.activeSnapshotId, upgraded.snapshotId),
        eq(schema.inventories.stationManifest, facts.stationManifest),
      ),
    );
  return upgraded;
}
