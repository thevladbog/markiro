import { BadRequestException, ConflictException } from "@nestjs/common";
import { COMMERCIAL_VERSION, COMMERCIAL_VERSION_HEADER } from "@markiro/platform-contracts";
import type { ZodType } from "zod";

export function isCommercialV2(request: { headers?: Record<string, unknown> }): boolean {
  const version = request.headers?.[COMMERCIAL_VERSION_HEADER.toLowerCase()];
  if (version === undefined) return false;
  if (version !== COMMERCIAL_VERSION)
    throw new BadRequestException({ code: "commercial_version_unsupported" });
  return true;
}

const metadata = new Set([
  "documentNameRu",
  "documentNameEn",
  "subject",
  "sellerPolicyRevision",
  "commercialPeriod",
  "commercialTerms",
  "taxPolicy",
]);
const opaque = new Set(["before", "after", "sellerSnapshot", "buyerSnapshot", "documentSnapshot"]);
const quotas = new Set(["maxLines", "maxStations", "maxKiosks", "maxCabinetUsers"]);
export function assertLegacyCommercialRepresentation(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertLegacyCommercialRepresentation(item);
    return;
  }
  if (!value || typeof value !== "object" || value instanceof Date) return;
  for (const [key, item] of Object.entries(value)) {
    if (quotas.has(key) && item === 0)
      throw new ConflictException({ code: "client_update_required" });
    if (!metadata.has(key) && !opaque.has(key)) assertLegacyCommercialRepresentation(item);
  }
}
export function legacyCommercialProjection(value: unknown): unknown {
  assertLegacyCommercialRepresentation(value);
  if (Array.isArray(value)) return value.map(legacyCommercialProjection);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !metadata.has(key))
      .map(([key, item]) => [key, opaque.has(key) ? item : legacyCommercialProjection(item)]),
  );
}
export function commercialResponse<T, V>(
  v2: boolean,
  legacy: ZodType<T>,
  current: ZodType<V>,
  value: unknown,
): T | V {
  return v2 ? current.parse(value) : legacy.parse(legacyCommercialProjection(value));
}
export function commercialBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException({ code: "validation_error" });
  return result.data;
}
