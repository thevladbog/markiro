import { BadRequestException, ConflictException } from "@nestjs/common";
import { COMMERCIAL_VERSION_HEADER } from "@markiro/platform-contracts";
import type { ZodType } from "zod";

export type CommercialVersion = 1 | 2 | 3;
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
export function assertLegacyCommercialRepresentation(value: unknown): void {
  projectCommercialResponse(1, value);
}
export function legacyCommercialProjection(value: unknown): unknown {
  return projectCommercialResponse(1, value);
}
export function commercialResponse<T, V, W = V>(
  version: CommercialVersion,
  legacy: ZodType<T>,
  current: ZodType<V>,
  value: unknown,
  v3?: ZodType<W>,
): T | V | W {
  const projected = projectCommercialResponse(version, value);
  return version === 3
    ? (v3 ?? current).parse(projected)
    : version === 2
      ? current.parse(projected)
      : legacy.parse(projected);
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
