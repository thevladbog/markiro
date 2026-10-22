import { US_CAPABILITY } from "@markiro/domain";

export const usSyntheticDemoCopy = {
  "en-US": {
    syntheticDemo: "Synthetic demo data — not real customer activity.",
    readOnlyAccess: "Read-only access",
  },
  "es-US": {
    syntheticDemo: "Datos de demostración sintéticos — no son actividad real de clientes.",
    readOnlyAccess: "Acceso de solo lectura",
  },
} as const;

export function isBoundedUsOrganizationMetadata(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    new TextEncoder().encode(value).byteLength <= 512
  );
}

/** Presentation only: this marker never grants or restricts a capability. */
export function isUsSyntheticDemoOrganization(value: unknown): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    value.name !== "Synthetic US development" ||
    !("slug" in value) ||
    value.slug !== "us-development-demo" ||
    !("metadata" in value) ||
    !isBoundedUsOrganizationMetadata(value.metadata)
  )
    return false;
  try {
    const stamp: unknown = JSON.parse(value.metadata);
    return (
      typeof stamp === "object" &&
      stamp !== null &&
      Object.keys(stamp).length === 2 &&
      "synthetic" in stamp &&
      stamp.synthetic === true &&
      "seedVersion" in stamp &&
      stamp.seedVersion === "us-development-owner-v1"
    );
  } catch {
    return false;
  }
}

export function isUsReadOnlyAccess(capabilities: readonly string[] | null): boolean {
  return (
    capabilities?.length === 2 &&
    capabilities.includes(US_CAPABILITY.READ) &&
    capabilities.includes(US_CAPABILITY.EXPORT_READ)
  );
}
