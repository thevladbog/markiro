import { createHash, randomBytes } from "node:crypto";
import type { CreateOrderAdmissionDto, CreateOrderDto } from "./dto";

export function admissionSequenceWithinWindow(input: {
  maxDurableSeq: number;
  outstandingCount: number;
  candidate: number;
}): boolean {
  const maxSeen = Math.max(0, input.maxDurableSeq);
  return input.candidate <= maxSeen + input.outstandingCount + 1;
}

type CanonicalOrderContent = Pick<CreateOrderAdmissionDto, "deviceSeq" | "reason" | "items"> & {
  badgeDigest: string | null;
  badgeCode: string | null;
  writeoffReasonId: string | null;
};

/**
 * Canonical post-validation business content. Caller timestamps and opaque
 * proofs are deliberately absent: the reservation supplies its own server
 * timestamp and binds the fields that can change the resulting order.
 */
export function canonicalKioskOrderContent(
  dto: CreateOrderAdmissionDto | CreateOrderDto,
): CanonicalOrderContent {
  return {
    deviceSeq: dto.deviceSeq,
    badgeDigest: dto.badgeDigest ?? null,
    badgeCode: dto.badgeCode ?? null,
    reason: dto.reason,
    writeoffReasonId: dto.writeoffReasonId ?? null,
    items: dto.items.map((item) => ({ rawKm: item.rawKm })),
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
