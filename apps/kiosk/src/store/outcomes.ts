import type { BoxConflictReason, OrderConflict } from "../api/types.js";
import { STORE_OUTCOMES, updateEach, withStore } from "./db.js";

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

function normalizedOwner(owner: OutcomeOwner): OutcomeOwner {
  const serverUrl = owner.serverUrl.replace(/\/+$/, "");
  if (!serverUrl || !owner.kioskId || !owner.credentialGeneration) throw new Error("invalid owner");
  return { ...owner, serverUrl };
}

function idOf(owner: OutcomeOwner, deviceSeq: number): string {
  const safe = normalizedOwner(owner);
  if (!Number.isSafeInteger(deviceSeq) || deviceSeq < 0) throw new Error("invalid deviceSeq");
  return `${safe.serverUrl}\u001f${safe.kioskId}\u001f${safe.credentialGeneration}\u001f${deviceSeq}`;
}

function isStored(value: unknown): value is Required<StoredKioskOutcome> {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<StoredKioskOutcome>;
  return (
    typeof row.id === "string" &&
    !!row.owner &&
    typeof row.owner.serverUrl === "string" &&
    typeof row.owner.kioskId === "string" &&
    typeof row.owner.credentialGeneration === "string" &&
    Number.isSafeInteger(row.deviceSeq) &&
    (row.deviceSeq ?? -1) >= 0 &&
    typeof row.employeeId === "string" &&
    typeof row.at === "string" &&
    !Number.isNaN(Date.parse(row.at)) &&
    (row.viewedAt === null || typeof row.viewedAt === "string") &&
    (row.kind === "accepted" || row.kind === "partial" || row.kind === "rejected") &&
    (row.orderNo === null || typeof row.orderNo === "string") &&
    Number.isInteger(row.acceptedCount) &&
    (row.acceptedCount ?? -1) >= 0 &&
    (row.acceptedCount ?? 1_501) <= 1_500 &&
    Array.isArray(row.acceptedBoxes) &&
    row.acceptedBoxes.length <= MAX_LINES &&
    row.acceptedBoxes.every(
      (box) =>
        !!box &&
        typeof box.sscc === "string" &&
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
          typeof line.codeTail === "string" &&
          line.codeTail.length <= 32 &&
          typeof line.reason === "string") ||
          (line.kind === "box" &&
            typeof line.sscc === "string" &&
            Number.isInteger(line.bottleCount) &&
            line.bottleCount > 0 &&
            line.bottleCount <= 500 &&
            typeof line.reason === "string")),
    )
  );
}

export async function putOutcome(outcome: StoredKioskOutcome): Promise<void> {
  const owner = normalizedOwner(outcome.owner);
  const stored = { ...outcome, owner, id: idOf(owner, outcome.deviceSeq) };
  if (!isStored(stored)) throw new Error("invalid outcome");
  await withStore(STORE_OUTCOMES, "readwrite", (store) => store.put(stored));
  const rows =
    (await withStore<unknown[]>(STORE_OUTCOMES, "readonly", (store) => store.getAll())) ?? [];
  const owned = rows
    .filter(isStored)
    .filter(
      (row) =>
        row.owner.serverUrl === owner.serverUrl &&
        row.owner.kioskId === owner.kioskId &&
        row.owner.credentialGeneration === owner.credentialGeneration,
    )
    .sort((left, right) => right.at.localeCompare(left.at));
  for (const expired of owned.slice(MAX_OUTCOMES_PER_OWNER)) {
    await withStore(STORE_OUTCOMES, "readwrite", (store) => store.delete(expired.id));
  }
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
  return isStored(row) ? row : null;
}

export async function acknowledgeOutcome(
  owner: OutcomeOwner,
  deviceSeq: number,
  viewedAt: string,
): Promise<void> {
  if (Number.isNaN(Date.parse(viewedAt))) throw new Error("invalid viewedAt");
  const id = idOf(owner, deviceSeq);
  await updateEach(STORE_OUTCOMES, (value) => {
    if (!isStored(value) || value.id !== id || value.viewedAt !== null) return null;
    return { ...value, viewedAt };
  });
}
