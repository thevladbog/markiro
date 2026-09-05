/** US-only cabinet policy. Never use this resolver in the RU deployment. */
export const US_CAPABILITY = {
  READ: "traceability.read",
  MASTER_DATA_WRITE: "traceability.master_data.write",
  RECEIVING_WRITE: "traceability.receiving.write",
  TRANSFORMATION_WRITE: "traceability.transformation.write",
  SHIPPING_WRITE: "traceability.shipping.write",
  QA_MANAGE: "traceability.qa.manage",
  EXPORT_READ: "traceability.export.read",
  SETTINGS_MANAGE: "tenant.settings.manage",
  MEMBERS_MANAGE: "members.manage",
} as const;

export type UsCapability = (typeof US_CAPABILITY)[keyof typeof US_CAPABILITY];
export type UsRole =
  | "owner"
  | "admin"
  | "manager"
  | "member"
  | "traceability_receiving"
  | "traceability_production"
  | "traceability_shipping"
  | "traceability_qa"
  | "traceability_auditor";

export interface UsAccess {
  roles: UsRole[];
  capabilities: UsCapability[];
}

const C = US_CAPABILITY;
const order: readonly UsCapability[] = Object.values(C);
const operational: readonly UsCapability[] = [
  C.READ,
  C.MASTER_DATA_WRITE,
  C.RECEIVING_WRITE,
  C.TRANSFORMATION_WRITE,
  C.SHIPPING_WRITE,
];
const roleCapabilities: Readonly<Record<UsRole, readonly UsCapability[]>> = {
  owner: order,
  admin: order,
  manager: operational,
  member: [],
  traceability_receiving: [C.READ, C.RECEIVING_WRITE],
  traceability_production: [C.READ, C.TRANSFORMATION_WRITE],
  traceability_shipping: [C.READ, C.SHIPPING_WRITE],
  traceability_qa: [...operational, C.QA_MANAGE, C.EXPORT_READ],
  traceability_auditor: [C.READ, C.EXPORT_READ],
};

function isUsRole(role: string): role is UsRole {
  return Object.hasOwn(roleCapabilities, role);
}

/** Input must come from server-reloaded membership, not request/session metadata. */
export function resolveUsAccess(rawRole: string): UsAccess {
  const roles = [
    ...new Set(
      rawRole
        .split(",")
        .map((role) => role.trim())
        .filter(isUsRole),
    ),
  ];
  const granted = new Set(roles.flatMap((role) => roleCapabilities[role]));
  return { roles, capabilities: order.filter((capability) => granted.has(capability)) };
}

export function hasUsCapabilities(
  actual: readonly UsCapability[],
  required: readonly UsCapability[],
): boolean {
  const granted = new Set(actual);
  return required.every((capability) => granted.has(capability));
}
