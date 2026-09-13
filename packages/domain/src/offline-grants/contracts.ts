import { z } from "zod";

export const deviceKindSchema = z.enum(["station", "handheld", "kiosk"]);
export const grantCapabilitySchema = z.enum([
  "shift.start.v1",
  "inventory.start.v1",
  "pickup.start.v1",
]);
export const grantEventTypeSchema = z.enum([
  "shift.scan.v1",
  "shift.box.close.v1",
  "shift.pallet.close.v1",
  "shift.label.prepare.v1",
  "shift.close.v1",
  "inventory.scan.v1",
  "inventory.repack.v1",
  "inventory.box.close.v1",
  "inventory.close.v1",
  "pickup.complete.v1",
]);
const identifier = z.string().min(1);
const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const grantOwnerSchema = z
  .object({
    tenantId: identifier,
    deviceId: identifier,
    kind: deviceKindSchema,
    credentialEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const grantProtectedHeaderSchema = z
  .object({
    typ: z.literal("markiro-offline-grant+jws"),
    alg: z.literal("ES256"),
    kid: identifier,
  })
  .strict();
const base = {
  ...grantOwnerSchema.shape,
  version: z.literal(1),
  issuer: identifier,
  grantId: identifier,
  entitlementRevision: identifier,
  policyRevision: identifier,
  issuedAt: milliseconds,
  notBefore: milliseconds,
};
export const budgetLineSchema = z
  .object({
    id: identifier,
    unit: z.enum(["event", "unit", "container"]),
    maximum: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const deviceGrantSchema = z
  .object({
    ...base,
    kindOfGrant: z.literal("device"),
    startNotAfter: milliseconds,
    capabilities: z.array(grantCapabilitySchema).min(1),
  })
  .strict()
  .refine(
    (grant) => grant.issuedAt <= grant.notBefore && grant.notBefore < grant.startNotAfter,
    "Invalid grant time ordering",
  )
  .refine(
    (grant) => new Set(grant.capabilities).size === grant.capabilities.length,
    "Duplicate capability",
  )
  .refine(
    (grant) =>
      grant.capabilities.every((capability) =>
        grant.kind === "kiosk"
          ? capability === "pickup.start.v1"
          : capability !== "pickup.start.v1",
      ),
    "Incompatible device capability",
  );
export const taskGrantSchema = z
  .object({
    ...base,
    kindOfGrant: z.literal("task"),
    taskKind: z.enum(["shift", "inventory", "pickup"]),
    taskId: identifier,
    snapshotDigest: identifier,
    completeNotAfter: milliseconds,
    eventTypes: z.array(grantEventTypeSchema).min(1),
    budget: z.array(budgetLineSchema).min(1),
  })
  .strict()
  .refine(
    (grant) => grant.issuedAt <= grant.notBefore && grant.notBefore < grant.completeNotAfter,
    "Invalid grant time ordering",
  )
  .refine(
    (grant) => new Set(grant.budget.map((line) => line.id)).size === grant.budget.length,
    "Duplicate budget ID",
  )
  .refine(
    (grant) => new Set(grant.eventTypes).size === grant.eventTypes.length,
    "Duplicate event type",
  )
  .refine(
    (grant) => (grant.kind === "kiosk" ? grant.taskKind === "pickup" : grant.taskKind !== "pickup"),
    "Incompatible device task",
  )
  .refine(
    (grant) => grant.eventTypes.every((event) => event.startsWith(`${grant.taskKind}.`)),
    "Incompatible task event",
  );
export const offlineGrantSchema = z.discriminatedUnion("kindOfGrant", [
  deviceGrantSchema,
  taskGrantSchema,
]);
