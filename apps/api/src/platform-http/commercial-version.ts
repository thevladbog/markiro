import { BadRequestException, ConflictException } from "@nestjs/common";
import { COMMERCIAL_VERSION_HEADER } from "@markiro/platform-contracts";
import type { ZodType } from "zod";

export type CommercialVersion = 1 | 2 | 3 | 4;
export function commercialVersion(request: {
  headers?: Record<string, unknown>;
  rawHeaders?: string[];
}): CommercialVersion {
  const name = COMMERCIAL_VERSION_HEADER.toLowerCase();
  const count =
    request.rawHeaders?.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name)
      .length ?? 0;
  const version = request.headers?.[name];
  if (count > 1) throw new BadRequestException({ code: "commercial_version_unsupported" });
  if (version === undefined) return 1;
  if (version === "2") return 2;
  if (version === "3") return 3;
  if (version === "4") return 4;
  throw new BadRequestException({ code: "commercial_version_unsupported" });
}
const p1Fields = new Set([
  "chzIntegrationEnabled",
  "inventoryEnabled",
  "commerceMlEnabled",
  "handheldEnabled",
  "lifecyclePolicyId",
]);
const p1Effects = new Set(["chzIntegration", "inventory", "commerceMl", "handheld"]);
export function projectCommercialResponse(version: CommercialVersion, value: unknown): unknown {
  if (version === 4) return value;
  assertNoV4CommercialRepresentation(value);
  if (version === 3) return value;
  if (Array.isArray(value)) return value.map((item) => projectCommercialResponse(version, item));
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (p1Fields.has(key)) {
      if (item !== null) throw new ConflictException({ code: "client_update_required" });
      continue;
    }
    if (
      (key === "key" || key === "entitlementKey") &&
      typeof item === "string" &&
      p1Effects.has(item)
    )
      throw new ConflictException({ code: "client_update_required" });
    if (version === 1 && quotas.has(key) && item === 0)
      throw new ConflictException({ code: "client_update_required" });
    if (version === 1 && metadata.has(key)) continue;
    projected[key] = opaque.has(key) ? item : projectCommercialResponse(version, item);
  }
  return projected;
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
function assertNoV4CommercialRepresentation(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoV4CommercialRepresentation(item);
    return;
  }
  if (!value || typeof value !== "object" || value instanceof Date) return;
  if (
    ("kind" in value &&
      "billingMode" in value &&
      value.kind === "service" &&
      value.billingMode === "recurring") ||
    ("serviceTerms" in value && value.serviceTerms != null)
  )
    throw new ConflictException({ code: "client_update_required" });
  for (const [key, item] of Object.entries(value)) {
    if (!opaque.has(key)) assertNoV4CommercialRepresentation(item);
  }
}
export function assertLegacyCommercialRepresentation(value: unknown): void {
  projectCommercialResponse(1, value);
}
export function legacyCommercialProjection(value: unknown): unknown {
  return projectCommercialResponse(1, value);
}
export function commercialResponse<T, V, W = V, X = W>(
  version: CommercialVersion,
  legacy: ZodType<T>,
  current: ZodType<V>,
  value: unknown,
  v3?: ZodType<W>,
  v4?: ZodType<X>,
): T | V | W | X {
  const projected = projectCommercialResponse(version, value);
  if (version === 4) return (v4 ?? v3 ?? current).parse(projected);
  if (version === 3) return (v3 ?? current).parse(projected);
  return version === 2 ? current.parse(projected) : legacy.parse(projected);
}
export function commercialBody<T>(
  schema: ZodType<T>,
  value: unknown,
  version?: CommercialVersion,
): T {
  if (version !== undefined) projectCommercialResponse(version, value);
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException({ code: "validation_error" });
  return result.data;
}
