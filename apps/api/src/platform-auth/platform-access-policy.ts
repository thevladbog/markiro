import { SetMetadata } from "@nestjs/common";
import type { PlatformRole } from "@markiro/db";

export const PLATFORM_ACCESS_POLICY = Symbol("PLATFORM_ACCESS_POLICY");

export type PlatformCapability =
  | "tenants.read"
  | "tenants.write"
  | "catalog.read"
  | "catalog.write"
  | "billing.read"
  | "billing.write"
  | "platformTeam.write"
  | "audit.read";

export interface PlatformPrincipal {
  userId: string;
  role: PlatformRole;
  capabilities: readonly PlatformCapability[];
  twoFactorReady: boolean;
}

const PLATFORM_ROLE_CAPABILITIES = {
  platform_admin: [
    "tenants.read",
    "tenants.write",
    "catalog.read",
    "catalog.write",
    "billing.read",
    "billing.write",
    "platformTeam.write",
    "audit.read",
  ],
  support: ["tenants.read", "tenants.write", "catalog.read", "audit.read"],
  accountant: [
    "tenants.read",
    "catalog.read",
    "catalog.write",
    "billing.read",
    "billing.write",
    "audit.read",
  ],
} as const satisfies Record<PlatformRole, readonly PlatformCapability[]>;

export interface PlatformAccessPolicy {
  capabilities: readonly PlatformCapability[];
}

export const RequirePlatformCapabilities = (...capabilities: PlatformCapability[]) =>
  SetMetadata(PLATFORM_ACCESS_POLICY, { capabilities } satisfies PlatformAccessPolicy);

export function platformCapabilitiesForRole(role: PlatformRole): readonly PlatformCapability[] {
  return PLATFORM_ROLE_CAPABILITIES[role];
}

export function hasPlatformCapabilities(
  granted: readonly PlatformCapability[],
  required: readonly PlatformCapability[],
): boolean {
  const capabilities = new Set(granted);
  return required.every((capability) => capabilities.has(capability));
}
