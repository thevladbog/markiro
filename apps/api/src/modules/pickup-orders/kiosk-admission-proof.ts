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

/**
 * Canonical post-validation business content. Caller timestamps and opaque
 * proofs are deliberately absent: the reservation supplies its own server
 * timestamp and binds the fields that can change the resulting order.
 */
export function canonicalKioskOrderContent(
  dto: CreateOrderAdmissionDto | CreateOrderDto,
): CanonicalOrderContent {
  const legacy = {
    deviceSeq: dto.deviceSeq,
    badgeDigest: dto.badgeDigest ?? null,
    badgeCode: dto.badgeCode ?? null,
    reason: dto.reason,
    writeoffReasonId: dto.writeoffReasonId ?? null,
    items: dto.items.map((item) => ({ rawKm: item.rawKm })),
  };
  if (!Object.prototype.hasOwnProperty.call(dto, "boxes")) return legacy;
  return {
    ...legacy,
    items: legacy.items.toSorted((left, right) => left.rawKm.localeCompare(right.rawKm)),
    boxes: (dto.boxes ?? [])
      .map((box) => ({ sscc: box.sscc }))
      .toSorted((left, right) => left.sscc.localeCompare(right.sscc)),
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
