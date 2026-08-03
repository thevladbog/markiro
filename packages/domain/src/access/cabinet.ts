export const CABINET_CAPABILITY = {
  OPERATIONS_READ: "operations.read",
  OPERATIONS_WRITE: "operations.write",
  INTEGRATIONS_READ: "integrations.read",
  INTEGRATIONS_WRITE: "integrations.write",
  TENANT_SETTINGS_MANAGE: "tenant.settings.manage",
  CREDENTIALS_MANAGE: "credentials.manage",
  MEMBERS_MANAGE: "members.manage",
} as const;

export type CabinetCapability = (typeof CABINET_CAPABILITY)[keyof typeof CABINET_CAPABILITY];
export type CabinetRole = "owner" | "admin" | "manager" | "member";

export interface ResolvedCabinetAccess {
  roles: CabinetRole[];
  capabilities: CabinetCapability[];
}

const C = CABINET_CAPABILITY;
const CAPABILITY_ORDER: CabinetCapability[] = [
  C.OPERATIONS_READ,
  C.OPERATIONS_WRITE,
  C.INTEGRATIONS_READ,
  C.INTEGRATIONS_WRITE,
  C.TENANT_SETTINGS_MANAGE,
  C.CREDENTIALS_MANAGE,
  C.MEMBERS_MANAGE,
];

const ROLE_CAPABILITIES: Record<CabinetRole, readonly CabinetCapability[]> = {
  member: [],
  manager: [C.OPERATIONS_READ, C.OPERATIONS_WRITE],
  admin: [
    C.OPERATIONS_READ,
    C.OPERATIONS_WRITE,
    C.INTEGRATIONS_READ,
    C.INTEGRATIONS_WRITE,
    C.TENANT_SETTINGS_MANAGE,
    C.CREDENTIALS_MANAGE,
  ],
  owner: CAPABILITY_ORDER,
};

function isCabinetRole(value: string): value is CabinetRole {
  return value === "owner" || value === "admin" || value === "manager" || value === "member";
}

export function resolveCabinetAccess(rawRole: string): ResolvedCabinetAccess {
  const roles = Array.from(
    new Set(
      rawRole
        .split(",")
        .map((role) => role.trim())
        .filter(isCabinetRole),
    ),
  );
  const granted = new Set(roles.flatMap((role) => ROLE_CAPABILITIES[role]));
  return {
    roles,
    capabilities: CAPABILITY_ORDER.filter((capability) => granted.has(capability)),
  };
}

export function hasCabinetCapabilities(
  actual: readonly CabinetCapability[],
  required: readonly CabinetCapability[],
): boolean {
  const granted = new Set(actual);
  return required.every((capability) => granted.has(capability));
}
