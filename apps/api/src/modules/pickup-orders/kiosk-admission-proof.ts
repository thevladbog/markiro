import { createHash, randomBytes } from "node:crypto";
import type { CreateOrderAdmissionDto, CreateOrderDto } from "./dto";

export const MAX_OUTSTANDING_KIOSK_ADMISSIONS = 128;

export function admissionSequenceWithinWindow(input: {
  maxDurableSeq: number;
  outstandingCount: number;
  candidate: number;
}): boolean {
  // Sequence values are monotonic but intentionally may contain gaps: the
  // only bounded resource here is the number of unconsumed proofs.
  return input.outstandingCount < MAX_OUTSTANDING_KIOSK_ADMISSIONS;
}

type CanonicalOrderContent = Pick<CreateOrderAdmissionDto, "deviceSeq" | "reason" | "items"> & {
  badgeDigest: string | null;
  badgeCode: string | null;
  writeoffReasonId: string | null;
  boxes?: { sscc: string }[];
};

export type KioskRejectionTerminalReason =
  | "order_rejected"
  | "unknown_badge"
  | "writeoff_forbidden"
  | "writeoff_reason_required"
  | "unknown_reason";

export interface KioskOrderRequestMarker {
  source: "request";
  version: 2;
  terminalReason: KioskRejectionTerminalReason;
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * vNext attestation deliberately makes request order irrelevant, so admission
 * processing must consume the exact same locale-independent order as the
 * proof. Legacy requests keep their historical item order byte-for-byte.
 */
export function kioskOrderProcessingLines(
  dto: Pick<CreateOrderAdmissionDto | CreateOrderDto, "items" | "boxes">,
): {
  items: { rawKm: string }[];
  boxes: { sscc: string }[];
  vNext: boolean;
} {
  const items = dto.items.map((item) => ({ rawKm: item.rawKm }));
  if (!Object.prototype.hasOwnProperty.call(dto, "boxes")) {
    return { items, boxes: [], vNext: false };
  }
  return {
    items: items.toSorted((left, right) => compareCanonicalStrings(left.rawKm, right.rawKm)),
    boxes: (dto.boxes ?? [])
      .map((box) => ({ sscc: box.sscc }))
      .toSorted((left, right) => compareCanonicalStrings(left.sscc, right.sscc)),
    vNext: true,
  };
}

export function kioskOrderRequestMarker(
  dto: Pick<CreateOrderAdmissionDto | CreateOrderDto, "boxes">,
  terminalReason: KioskRejectionTerminalReason,
): KioskOrderRequestMarker | null {
  return Object.prototype.hasOwnProperty.call(dto, "boxes")
    ? { source: "request", version: 2, terminalReason }
    : null;
}

export async function findSerializedKioskWinner<T>(input: {
  findOrder: () => Promise<T | null>;
  findRejection?: () => Promise<T | null>;
}): Promise<T | null> {
  return (await input.findOrder()) ?? (input.findRejection ? await input.findRejection() : null);
}

/**
 * Canonical post-validation business content. Caller timestamps and opaque
 * proofs are deliberately absent: the reservation supplies its own server
 * timestamp and binds the fields that can change the resulting order.
 */
export function canonicalKioskOrderContent(
  dto: CreateOrderAdmissionDto | CreateOrderDto,
): CanonicalOrderContent {
  const processing = kioskOrderProcessingLines(dto);
  const legacy = {
    deviceSeq: dto.deviceSeq,
    badgeDigest: dto.badgeDigest ?? null,
    badgeCode: dto.badgeCode ?? null,
    reason: dto.reason,
    writeoffReasonId: dto.writeoffReasonId ?? null,
    items: dto.items.map((item) => ({ rawKm: item.rawKm })),
  };
  if (!processing.vNext) return legacy;
  return {
    ...legacy,
    items: processing.items,
    boxes: processing.boxes,
  };
}

export function kioskOrderPayloadDigest(dto: CreateOrderAdmissionDto | CreateOrderDto): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalKioskOrderContent(dto)), "utf8")
    .digest("hex");
}

export function issueOpaqueKioskAdmissionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function kioskAdmissionTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
