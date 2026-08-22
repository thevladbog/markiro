import { SetMetadata } from "@nestjs/common";
import {
  platformCapabilitiesForRole as PLATFORM_ROLE_CAPABILITIES,
  type PlatformCapability,
  type PlatformRole,
} from "@markiro/platform-contracts";

export type { PlatformCapability, PlatformPrincipal } from "@markiro/platform-contracts";

export const PLATFORM_ACCESS_POLICY = Symbol("PLATFORM_ACCESS_POLICY");

export interface PlatformCapabilityPolicy {
  mode: "capabilities";
  capabilities: readonly PlatformCapability[];
}

export interface PlatformPublicTokenPolicy {
  mode: "public-token";
}

export type PlatformAccessPolicy = PlatformCapabilityPolicy | PlatformPublicTokenPolicy;

export const RequirePlatformCapabilities = (...capabilities: PlatformCapability[]) =>
  SetMetadata(PLATFORM_ACCESS_POLICY, {
    mode: "capabilities",
    capabilities,
  } satisfies PlatformCapabilityPolicy);

export const AllowPublicPlatformToken = () =>
  SetMetadata(PLATFORM_ACCESS_POLICY, { mode: "public-token" } satisfies PlatformPublicTokenPolicy);

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
