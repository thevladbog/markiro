import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { standaloneActivationRequestSchema } from "@markiro/domain";
import { platformCapabilitiesForRole, type PlatformPrincipal } from "@markiro/platform-contracts";
import type { z } from "zod";

export const STANDALONE_TEST_ISSUER = "https://api.example.invalid";
export type ActivationRequest = z.output<typeof standaloneActivationRequestSchema>;

const ACTIVATION_FIXTURE = join(
  __dirname,
  "../../../../packages/domain/fixtures/standalone-license/activation-request.json",
);

/** The ЛЦ-1 activation request fixture with a fresh host id and the INN and usage a test needs. */
export function activationRequest(
  overrides: {
    hostId?: string;
    inn?: string;
    trialInn?: string | null;
    usage?: { stations: number; cabinetUsers: number; lines: number };
  } = {},
): ActivationRequest {
  const base = standaloneActivationRequestSchema.parse(
    JSON.parse(readFileSync(ACTIVATION_FIXTURE, "utf8")),
  );
  return standaloneActivationRequestSchema.parse({
    ...base,
    hostId: overrides.hostId ?? randomUUID(),
    organization: { ...base.organization, inn: overrides.inn ?? base.organization.inn },
    // The trial INN follows the request INN unless a test sets it: no trial_inn_differs by accident.
    trial:
      overrides.trialInn === null || base.trial === null
        ? null
        : { ...base.trial, inn: overrides.trialInn ?? overrides.inn ?? base.organization.inn },
    usage: overrides.usage ?? { stations: 1, cabinetUsers: 1, lines: 1 },
  });
}

/** A complete, valid license signing environment with a fresh P-256 key. */
export function signingEnv(kid = "test-lic-api") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    STANDALONE_LICENSE_ISSUER: STANDALONE_TEST_ISSUER,
    STANDALONE_LICENSE_KID: kid,
    STANDALONE_LICENSE_PRIVATE_KEY_PEM: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    STANDALONE_LICENSE_KEYSET_JSON: JSON.stringify({
      protocol: "standalone-license-v1",
      origin: STANDALONE_TEST_ISSUER,
      revision: "test-v1",
      keys: [{ kid, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }],
      retiredKids: [],
    }),
  };
}

export async function platformActor(
  db: Db,
  role: "platform_admin" | "support" | "accountant" = "platform_admin",
  options: { verified?: boolean } = {},
): Promise<PlatformPrincipal> {
  const userId = randomUUID();
  await db.insert(schema.platformUsers).values({
    id: userId,
    email: `${userId}@example.invalid`,
    name: "Standalone license tester",
    role,
    status: "active",
    twoFactorEnabled: true,
  });
  await db.insert(schema.platformTwoFactors).values({
    id: randomUUID(),
    userId,
    secret: "test-only",
    backupCodes: "test-only",
    verified: options.verified ?? true,
  });
  return { userId, role, capabilities: platformCapabilitiesForRole[role], twoFactorReady: true };
}

/** INNs of the tenant's organization profile and current billing profile; `undefined` leaves one out. */
export async function setTenantInns(
  db: Db,
  tenantId: string,
  inns: { org?: string | null; billing?: string },
): Promise<void> {
  if (inns.org !== undefined)
    await db
      .insert(schema.orgProfiles)
      .values({ tenantId, inn: inns.org })
      .onConflictDoUpdate({ target: schema.orgProfiles.tenantId, set: { inn: inns.org } });
  if (inns.billing !== undefined)
    await db.insert(schema.tenantBillingProfiles).values({
      tenantId,
      revision: 1,
      isCurrent: true,
      kind: "legal_entity",
      fullName: "ООО «Завод Тест»",
      displayName: "Завод Тест",
      inn: inns.billing,
      addressRaw: "Москва",
      legalAddressRaw: "Москва",
    });
}

/**
 * The tenant's platform audit rows. Landing leads are platform-wide: a lead another
 * test file left with the fixture INN may be linked by a site registration (spec
 * 2026-10-20 §15.6), so its rows are left out unless asked for — the lead link
 * tests use INNs of their own and read them with `{ leads: true }`.
 */
export async function auditRows(db: Db, tenantId: string, options: { leads?: boolean } = {}) {
  const rows = await db
    .select({
      actorPlatformUserId: schema.platformAuditEvents.actorPlatformUserId,
      actorRole: schema.platformAuditEvents.actorRole,
      tenantId: schema.platformAuditEvents.tenantId,
      action: schema.platformAuditEvents.action,
      outcome: schema.platformAuditEvents.outcome,
      targetType: schema.platformAuditEvents.targetType,
      targetId: schema.platformAuditEvents.targetId,
      reason: schema.platformAuditEvents.reason,
      requestId: schema.platformAuditEvents.requestId,
      before: schema.platformAuditEvents.before,
      after: schema.platformAuditEvents.after,
    })
    .from(schema.platformAuditEvents)
    .where(eq(schema.platformAuditEvents.tenantId, tenantId))
    .orderBy(asc(schema.platformAuditEvents.createdAt), asc(schema.platformAuditEvents.id));
  return options.leads ? rows : rows.filter((row) => !row.action.startsWith("landing_lead."));
}

/** A tenant the platform created without a cabinet (owner decision 2026-10-13: offline licenses only). */
export async function createTenantWithoutCabinet(db: Db, tenantId: string = randomUUID()) {
  await db.insert(schema.organization).values({
    id: tenantId,
    name: `Offline tenant ${tenantId}`,
    slug: `offline-${tenantId}`,
    cabinetAccess: "none",
    createdAt: new Date(),
  });
  return tenantId;
}
