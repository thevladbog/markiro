import { classifyScan } from "../scan/classify.js";
import { canonicalizeKm, kmHash } from "../gs1/km.js";
import type { InventoryChzStatus } from "./status.js";

export type InventoryOriginClassification = "expected" | "protected" | "known-ineligible";

export interface InventoryScanSnapshotRow {
  codeHash: string;
  canonicalRaw: string;
  gtin14: string;
  serial: string;
  sourceStatus: InventoryChzStatus;
  sourceState: string | null;
  expected: boolean;
  protected: boolean;
  parentSscc: string | null;
}

export interface InventoryLocalClaim {
  codeHash: string;
  eventId: string;
  deviceId: string;
  scannedAt: string;
}

export interface InventoryScanClassifierContext {
  taskGtin14: string;
  findSnapshotCode(codeHash: string): InventoryScanSnapshotRow | null;
  findSnapshotChildren(parentSscc: string): InventoryScanSnapshotRow[];
  findLocalClaim(codeHash: string): InventoryLocalClaim | null;
}

export interface InventoryBoxChildClassification {
  codeHash: string;
  originClassification: InventoryOriginClassification;
  firstWinning: InventoryLocalClaim | null;
}

interface InventoryItemIdentity {
  scanKind: "item";
  codeHash: string;
  canonicalRaw: string;
  gtin14: string;
  serial: string;
}

interface InventoryKnownBoxIdentity {
  scanKind: "known_box";
  sscc: string;
  children: InventoryBoxChildClassification[];
}

export type InventoryScanClassification =
  | ({ kind: "expected"; originClassification: "expected" } & (
      InventoryItemIdentity | InventoryKnownBoxIdentity
    ))
  | ({
      kind: "protected";
      originClassification: "protected";
    } & (
      InventoryKnownBoxIdentity | (InventoryItemIdentity & { sourceStatus: InventoryChzStatus })
    ))
  | ({
      kind: "known-ineligible";
      originClassification: "known-ineligible";
    } & (
      InventoryKnownBoxIdentity | (InventoryItemIdentity & { sourceStatus: InventoryChzStatus })
    ))
  | ({ kind: "unknown" } & (InventoryItemIdentity | { scanKind: "old_box"; sscc: string }))
  | ({
      kind: "duplicate";
      firstWinning: InventoryLocalClaim;
    } & (InventoryItemIdentity | InventoryKnownBoxIdentity))
  | { kind: "invalid"; reason: "malformed" | "wrong_gtin" | "unsupported" };

function origin(row: InventoryScanSnapshotRow): InventoryOriginClassification {
  if (row.sourceState === "MOVING_BY_UD" || row.protected) return "protected";
  if (row.expected) return "expected";
  return "known-ineligible";
}

function firstClaim(claims: InventoryLocalClaim[]): InventoryLocalClaim {
  const first = [...claims].sort(
    (left, right) =>
      left.scannedAt.localeCompare(right.scannedAt) ||
      left.deviceId.localeCompare(right.deviceId) ||
      left.eventId.localeCompare(right.eventId),
  )[0];
  if (!first) throw new Error("duplicate inventory box has no winning claim");
  return first;
}

function classifyItem(
  raw: string,
  context: InventoryScanClassifierContext,
): InventoryScanClassification {
  let km: ReturnType<typeof canonicalizeKm>;
  try {
    km = canonicalizeKm(raw);
  } catch {
    return { kind: "invalid", reason: "malformed" };
  }
  if (km.gtin14 !== context.taskGtin14) return { kind: "invalid", reason: "wrong_gtin" };

  const codeHash = kmHash(km);
  const identity: InventoryItemIdentity = {
    scanKind: "item",
    codeHash,
    canonicalRaw: km.raw,
    gtin14: km.gtin14,
    serial: km.serial,
  };
  const existing = context.findLocalClaim(codeHash);
  if (existing) return { kind: "duplicate", ...identity, firstWinning: existing };

  const snapshot = context.findSnapshotCode(codeHash);
  if (!snapshot) return { kind: "unknown", ...identity };
  const disposition = origin(snapshot);
  if (disposition === "protected") {
    return {
      kind: "protected",
      ...identity,
      originClassification: "protected",
      sourceStatus: snapshot.sourceStatus,
    };
  }
  if (disposition === "known-ineligible") {
    return {
      kind: "known-ineligible",
      ...identity,
      originClassification: "known-ineligible",
      sourceStatus: snapshot.sourceStatus,
    };
  }
  return { kind: "expected", ...identity, originClassification: "expected" };
}

/**
 * Pure inventory scanner policy. Callers supply immutable active-snapshot and
 * local-claim lookups; this function performs no persistence and never returns
 * arbitrary malformed acquisition text.
 */
export function classifyInventoryScan(
  raw: string,
  context: InventoryScanClassifierContext,
): InventoryScanClassification {
  const scannerInput = classifyScan(raw);
  if (scannerInput.kind === "km") return classifyItem(raw, context);
  if (scannerInput.kind === "sscc") {
    const snapshotChildren = context.findSnapshotChildren(scannerInput.sscc);
    if (snapshotChildren.length === 0) {
      return { kind: "unknown", scanKind: "old_box", sscc: scannerInput.sscc };
    }
    const children = snapshotChildren.map((row) => ({
      codeHash: row.codeHash,
      originClassification: origin(row),
      firstWinning: context.findLocalClaim(row.codeHash),
    }));
    const unclaimed = children.filter((child) => child.firstWinning === null);
    const identity: InventoryKnownBoxIdentity = {
      scanKind: "known_box",
      sscc: scannerInput.sscc,
      children,
    };
    if (unclaimed.length === 0) {
      const claims = children.flatMap((child) =>
        child.firstWinning === null ? [] : [child.firstWinning],
      );
      return {
        kind: "duplicate",
        ...identity,
        firstWinning: firstClaim(claims),
      };
    }
    if (unclaimed.some((child) => child.originClassification === "expected")) {
      return { kind: "expected", ...identity, originClassification: "expected" };
    }
    if (unclaimed.some((child) => child.originClassification === "protected")) {
      return { kind: "protected", ...identity, originClassification: "protected" };
    }
    return { kind: "known-ineligible", ...identity, originClassification: "known-ineligible" };
  }
  return {
    kind: "invalid",
    reason: scannerInput.kind === "gtin" ? "unsupported" : "malformed",
  };
}
