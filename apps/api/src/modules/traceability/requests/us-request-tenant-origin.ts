import { ServiceUnavailableException } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { UsDevelopmentOwnerStore } from "../../../deployment/us-development-owner";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";

const SEED_VERSION = "us-development-owner-v1";
const SEED_SLUG = "us-development-demo";
const OWNER_EMAIL = "owner@us-development.example.test";
const PROVISION_ACTION = "us.development.owner.provisioned";
const seedMetadataSchema = z
  .object({ synthetic: z.literal(true), seedVersion: z.literal(SEED_VERSION) })
  .strict();

export const usRequestTenantOriginSchema = z.discriminatedUnion("result", [
  z
    .object({
      schemaVersion: z.literal(1),
      verificationPolicy: z.literal("us-request-tenant-origin-v1"),
      result: z.literal("trusted_synthetic"),
      trustedSeed: z.object({ seedId: z.uuid(), verifiedBy: z.literal(SEED_VERSION) }).strict(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      verificationPolicy: z.literal("us-request-tenant-origin-v1"),
      result: z.literal("not_attested"),
      trustedSeed: z.null(),
    })
    .strict(),
]);
export type UsRequestTenantOrigin = z.infer<typeof usRequestTenantOriginSchema>;

function invalid(): never {
  throw new ServiceUnavailableException({ code: "us_request_tenant_origin_invalid" });
}

function parseMetadata(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Captures origin only in the caller's established snapshot; never provisions or repairs. */
export async function captureUsRequestTenantOrigin(
  db: Db,
  tx: UsMasterDataTransaction,
  tenantId: string,
): Promise<UsRequestTenantOrigin> {
  try {
    const [tenant] = await tx
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantId))
      .limit(1);
    if (!tenant) return invalid();
    const parsedMetadata = parseMetadata(tenant.metadata);
    const audits = await tx
      .select({ id: schema.tenantAuditEvents.id })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, PROVISION_ACTION),
        ),
      )
      .limit(2);
    // The raw identifier also detects damaged JSON retaining the reserved marker.
    const hasMetadataMarker =
      (parsedMetadata !== null &&
        typeof parsedMetadata === "object" &&
        "seedVersion" in parsedMetadata &&
        parsedMetadata.seedVersion === SEED_VERSION) ||
      (tenant.metadata?.includes(SEED_VERSION) ?? false);
    if (tenant.slug !== SEED_SLUG && !hasMetadataMarker && audits.length === 0) {
      return usRequestTenantOriginSchema.parse({
        schemaVersion: 1,
        verificationPolicy: "us-request-tenant-origin-v1",
        result: "not_attested",
        trustedSeed: null,
      });
    }
    if (
      tenant.slug !== SEED_SLUG ||
      !seedMetadataSchema.safeParse(parsedMetadata).success ||
      audits.length !== 1
    )
      return invalid();

    // Reserved user identity is unique; it does not attest any other tenant.
    const [owner] = await tx
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, OWNER_EMAIL))
      .limit(1);
    if (!owner) return invalid();
    // Bound corrupt duplicate sets before the existing verifier can enumerate them.
    const memberships = await tx
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.userId, owner.id)))
      .limit(2);
    if (memberships.length !== 1) return invalid();
    const credentials = await tx
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(and(eq(schema.account.userId, owner.id), eq(schema.account.providerId, "credential")))
      .limit(2);
    if (credentials.length !== 1) return invalid();

    const seed = await new UsDevelopmentOwnerStore(db).verifyTrustedSeed(tenantId, new Date(), tx);
    if (!seed || seed.seedId !== tenantId) return invalid();
    return usRequestTenantOriginSchema.parse({
      schemaVersion: 1,
      verificationPolicy: "us-request-tenant-origin-v1",
      result: "trusted_synthetic",
      trustedSeed: { seedId: seed.seedId, verifiedBy: seed.verifiedBy },
    });
  } catch {
    // Technical and inconsistent evidence failures share a finite, private-safe code.
    return invalid();
  }
}
