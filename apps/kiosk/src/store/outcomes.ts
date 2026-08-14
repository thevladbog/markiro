import type { BoxConflictReason, OrderConflict } from "../api/types.js";
import { isValidSscc } from "@markiro/domain";
import { STORE_OUTCOMES, updateEach, withStore, withTransaction } from "./db.js";
import { credentialGenerationOf } from "./installation-binding.js";

export interface OutcomeOwner {
  serverUrl: string;
  kioskId: string;
  credentialGeneration: string;
}

export type StoredRejectedLine =
  | { kind: "loose"; codeTail: string; reason: OrderConflict["reason"] }
  | { kind: "box"; sscc: string; bottleCount: number; reason: BoxConflictReason };

export interface StoredKioskOutcome {
  id?: string;
  owner: OutcomeOwner;
  deviceSeq: number;
  employeeId: string;
  at: string;
  viewedAt: string | null;
  kind: "accepted" | "partial" | "rejected";
  orderNo: string | null;
  acceptedCount: number;
  acceptedBoxes: Array<{ sscc: string; bottleCount: number }>;
  rejected: StoredRejectedLine[];
}

const MAX_LINES = 200;
export const MAX_OUTCOMES_PER_OWNER = 100;
const MAX_OWNER_PART = 2_048;
const MAX_SHORT_TEXT = 256;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOSE_REASONS = new Set<OrderConflict["reason"]>([
  "not_km",
  "incomplete",
  "unknown_product",
  "not_allowed",
  "duplicate",
  "over_limit",
]);
const BOX_REASONS = new Set<BoxConflictReason>([
  "unknown_box",
  "box_not_closed",
  "box_disassembled",
  "box_contents_changed",
  "mixed_product_box",
  "duplicate",
  "over_limit",
]);

function boundedText(value: unknown, max: number, allowEmpty = false): value is string {
  if (typeof value !== "string") return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return (
    (allowEmpty || value.length > 0) &&
    value.length <= max &&
    new TextEncoder().encode(value).byteLength <= max
  );
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function normalizedOwner(owner: OutcomeOwner): OutcomeOwner {
  const serverUrl = owner.serverUrl.trim().replace(/\/+$/, "");
  const kioskId = owner.kioskId.trim();
  const credentialGeneration = credentialGenerationOf(owner);
  if (!boundedText(serverUrl, MAX_OWNER_PART) || !isUuid(kioskId) || credentialGeneration === null)
    throw new Error("invalid owner");
  return { serverUrl, kioskId, credentialGeneration };
}

function idOf(owner: OutcomeOwner, deviceSeq: number): string {
  const safe = normalizedOwner(owner);
  if (!Number.isSafeInteger(deviceSeq) || deviceSeq < 0) throw new Error("invalid deviceSeq");
  return `${safe.serverUrl}\u001f${safe.kioskId}\u001f${safe.credentialGeneration}\u001f${deviceSeq}`;
}

function isStored(value: unknown): value is Required<StoredKioskOutcome> {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<StoredKioskOutcome>;
  if (
    !row.owner ||
    typeof row.deviceSeq !== "number" ||
    !Number.isSafeInteger(row.deviceSeq) ||
    row.deviceSeq < 0
  )
    return false;
  let owner: OutcomeOwner;
  try {
    owner = normalizedOwner(row.owner);
  } catch {
    return false;
  }
  let canonicalId: string;
  try {
    canonicalId = idOf(owner, row.deviceSeq);
  } catch {
    return false;
  }
  return (
    typeof row.id === "string" &&
    row.id === canonicalId &&
    row.owner.serverUrl === owner.serverUrl &&
    row.owner.kioskId === owner.kioskId &&
    row.owner.credentialGeneration === owner.credentialGeneration &&
    isUuid(row.employeeId) &&
    isIsoDate(row.at) &&
    (row.viewedAt === null || isIsoDate(row.viewedAt)) &&
    (row.kind === "accepted" || row.kind === "partial" || row.kind === "rejected") &&
    (row.orderNo === null || boundedText(row.orderNo, MAX_SHORT_TEXT)) &&
    Number.isInteger(row.acceptedCount) &&
    (row.acceptedCount ?? -1) >= 0 &&
    (row.acceptedCount ?? 1_501) <= 1_500 &&
    Array.isArray(row.acceptedBoxes) &&
    row.acceptedBoxes.length <= MAX_LINES &&
    row.acceptedBoxes.every(
      (box) =>
        !!box &&
        isValidSscc(box.sscc) &&
        Number.isInteger(box.bottleCount) &&
        box.bottleCount > 0 &&
        box.bottleCount <= 500,
    ) &&
    Array.isArray(row.rejected) &&
    row.rejected.length <= MAX_LINES &&
    row.rejected.every(
      (line) =>
        !!line &&
        ((line.kind === "loose" &&
          boundedText(line.codeTail, 32, true) &&
          line.codeTail.length <= 32 &&
          LOOSE_REASONS.has(line.reason)) ||
          (line.kind === "box" &&
            isValidSscc(line.sscc) &&
            Number.isInteger(line.bottleCount) &&
            line.bottleCount > 0 &&
            line.bottleCount <= 500 &&
            BOX_REASONS.has(line.reason))),
    )
  );
}

export async function putOutcome(outcome: StoredKioskOutcome): Promise<void> {
  const owner = normalizedOwner(outcome.owner);
  const stored = { ...outcome, owner, id: idOf(owner, outcome.deviceSeq) };
  if (!isStored(stored)) throw new Error("invalid outcome");
  await withTransaction([STORE_OUTCOMES], "readwrite", (tx) => {
    const store = tx.objectStore(STORE_OUTCOMES);
    const existingRequest = store.get(stored.id);
    existingRequest.onsuccess = () => {
      const existing = isStored(existingRequest.result) ? existingRequest.result : null;
      const replacement = existing
        ? { ...stored, at: existing.at, viewedAt: existing.viewedAt }
        : stored;
      const putRequest = store.put(replacement);
      putRequest.onsuccess = () => {
        const allRequest = store.getAll();
        allRequest.onsuccess = () => {
          const owned = (allRequest.result as unknown[])
            .filter(isStored)
            .filter(
              (row) =>
                row.owner.serverUrl === owner.serverUrl &&
                row.owner.kioskId === owner.kioskId &&
                row.owner.credentialGeneration === owner.credentialGeneration,
            )
            .sort((left, right) => right.at.localeCompare(left.at));
          for (const expired of owned.slice(MAX_OUTCOMES_PER_OWNER)) store.delete(expired.id);
        };
      };
    };
  });
}

export async function findOldestUnviewedOutcome(
  owner: OutcomeOwner,
  employeeId: string,
): Promise<StoredKioskOutcome | null> {
  const expected = normalizedOwner(owner);
  const values =
    (await withStore<unknown[]>(STORE_OUTCOMES, "readonly", (store) => store.getAll())) ?? [];
  const found = values
    .filter(isStored)
    .filter(
      (row) =>
        row.employeeId === employeeId &&
        row.viewedAt === null &&
        row.owner.serverUrl === expected.serverUrl &&
        row.owner.kioskId === expected.kioskId &&
        row.owner.credentialGeneration === expected.credentialGeneration,
    )
    .sort((left, right) => left.at.localeCompare(right.at))[0];
  return found ?? null;
}

export async function readOutcome(
  owner: OutcomeOwner,
  deviceSeq: number,
): Promise<StoredKioskOutcome | null> {
  const row = await withStore<unknown>(STORE_OUTCOMES, "readonly", (store) =>
    store.get(idOf(owner, deviceSeq)),
  );
  if (!isStored(row)) return null;
  const expected = normalizedOwner(owner);
  return row.owner.serverUrl === expected.serverUrl &&
    row.owner.kioskId === expected.kioskId &&
    row.owner.credentialGeneration === expected.credentialGeneration
    ? row
    : null;
}

export async function acknowledgeOutcome(
  owner: OutcomeOwner,
  deviceSeq: number,
  viewedAt: string,
): Promise<void> {
  if (!isIsoDate(viewedAt)) throw new Error("invalid viewedAt");
  const id = idOf(owner, deviceSeq);
  const updated = await updateEach(STORE_OUTCOMES, (value) => {
    if (!isStored(value) || value.id !== id) return null;
    return value.viewedAt === null ? { ...value, viewedAt } : value;
  });
  if (updated !== 1) throw new Error("outcome not found");
}
