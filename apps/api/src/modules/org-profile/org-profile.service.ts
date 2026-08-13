import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, inArray, isNull, lt, lte, notExists, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { isMissingObjectError, ObjectStorageService } from "../storage/object-storage.service";
import {
  atomicSeedSscc,
  BOX_EXTENSION_DIGIT,
  deriveIssuerPrefix,
  seedFloor,
} from "../sscc/sscc.service";
import { processLogo } from "./logo-processor";
import type {
  KioskBrandingDto,
  OrganizationLogoDto,
  OrgProfileDto,
  PutOrgProfileDto,
  SsccCounterDto,
} from "./dto";

@Injectable()
export class OrgProfileService {
  private readonly logger = new Logger(OrgProfileService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  /** Returns the tenant's profile, or the empty defaults if no row exists yet. */
  async getProfile(tenantId: string): Promise<OrgProfileDto> {
    const [[row], [pickupPolicy]] = await Promise.all([
      this.db.select().from(schema.orgProfiles).where(eq(schema.orgProfiles.tenantId, tenantId)),
      this.db
        .select({ limitsEnabled: schema.pickupTenantPolicies.limitsEnabled })
        .from(schema.pickupTenantPolicies)
        .where(eq(schema.pickupTenantPolicies.tenantId, tenantId)),
    ]);
    if (!pickupPolicy) {
      throw new InternalServerErrorException("Tenant pickup policy is not configured");
    }
    return {
      gln: row?.gln ?? null,
      gs1Prefixes: row?.gs1Prefixes ?? [],
      inn: row?.inn ?? null,
      pickupLimitsEnabled: pickupPolicy.limitsEnabled,
    };
  }

  /**
   * Upserts only the fields present in `patch` (undefined = leave untouched,
   * explicit null = clear); fields omitted entirely keep their current
   * value (or the empty default if the row doesn't exist yet).
   * Atomic: no read-then-write race — merge happens in SQL via onConflictDoUpdate.
   */
  async upsertProfile(
    tenantId: string,
    actorUserId: string,
    patch: PutOrgProfileDto,
  ): Promise<OrgProfileDto> {
    const setClause: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.gln !== undefined) setClause.gln = patch.gln;
    if (patch.gs1Prefixes !== undefined) setClause.gs1Prefixes = patch.gs1Prefixes;
    if (patch.inn !== undefined) setClause.inn = patch.inn;

    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.orgProfiles)
        .values({
          tenantId,
          gln: patch.gln ?? null,
          gs1Prefixes: patch.gs1Prefixes ?? [],
          inn: patch.inn ?? null,
        })
        .onConflictDoUpdate({
          target: schema.orgProfiles.tenantId,
          set: setClause,
        });

      if (patch.pickupLimitsEnabled !== undefined) {
        const [policy] = await tx
          .select({ limitsEnabled: schema.pickupTenantPolicies.limitsEnabled })
          .from(schema.pickupTenantPolicies)
          .where(eq(schema.pickupTenantPolicies.tenantId, tenantId))
          .for("update");
        if (!policy) {
          throw new InternalServerErrorException("Tenant pickup policy is not configured");
        }
        await tx
          .update(schema.pickupTenantPolicies)
          .set({ limitsEnabled: patch.pickupLimitsEnabled, updatedAt: new Date() })
          .where(eq(schema.pickupTenantPolicies.tenantId, tenantId));
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId,
          action: "tenant.pickup_policy.updated",
          outcome: "success",
          targetType: "tenant",
          targetId: tenantId,
          before: { limitsEnabled: policy.limitsEnabled },
          after: { limitsEnabled: patch.pickupLimitsEnabled },
        });
      }
    });

    return this.getProfile(tenantId);
  }

  async uploadLogo(
    tenantId: string,
    actorUserId: string,
    source: Buffer,
  ): Promise<OrganizationLogoDto> {
    let logo: Awaited<ReturnType<typeof processLogo>>;
    try {
      logo = await processLogo(source);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid logo");
    }

    const assetId = randomUUID();
    const objectKey = `tenants/${tenantId}/branding/${assetId}.webp`;
    await this.db.insert(schema.organizationLogoAssets).values({
      id: assetId,
      tenantId,
      objectKey,
      contentType: logo.contentType,
      byteSize: logo.byteSize,
      checksum: logo.checksum,
      width: logo.width,
      height: logo.height,
      status: "staging",
    });

    try {
      await this.storage.put(objectKey, logo.buffer, logo.contentType);
    } catch (error) {
      this.logger.error(
        `Could not store organization logo for tenant ${tenantId}, asset ${assetId}: ${errorMessage(error)}`,
      );
      throw new ServiceUnavailableException("Logo storage is unavailable");
    }

    let previousAssetId: string | null = null;
    try {
      await this.db.transaction(async (tx) => {
        await tx
          .insert(schema.orgProfiles)
          .values({ tenantId })
          .onConflictDoNothing({ target: schema.orgProfiles.tenantId });
        await tx.execute(
          sql`select ${schema.orgProfiles.tenantId} from ${schema.orgProfiles} where ${schema.orgProfiles.tenantId} = ${tenantId} for update`,
        );
        const [current] = await tx
          .select({ logoAssetId: schema.orgProfiles.logoAssetId })
          .from(schema.orgProfiles)
          .where(eq(schema.orgProfiles.tenantId, tenantId))
          .limit(1);
        if (!current) throw new ConflictException("Organization profile no longer exists");
        previousAssetId = current.logoAssetId;
        const activated = await tx
          .update(schema.organizationLogoAssets)
          .set({ status: "active", updatedAt: new Date() })
          .where(
            and(
              eq(schema.organizationLogoAssets.tenantId, tenantId),
              eq(schema.organizationLogoAssets.id, assetId),
              eq(schema.organizationLogoAssets.status, "staging"),
            ),
          )
          .returning({ id: schema.organizationLogoAssets.id });
        if (activated.length !== 1) throw new ConflictException("Logo staging state changed");
        await tx
          .update(schema.orgProfiles)
          .set({ logoAssetId: assetId, updatedAt: new Date() })
          .where(eq(schema.orgProfiles.tenantId, tenantId));
        if (previousAssetId) {
          await tx
            .update(schema.organizationLogoAssets)
            .set({ status: "deleting", updatedAt: new Date() })
            .where(
              and(
                eq(schema.organizationLogoAssets.tenantId, tenantId),
                eq(schema.organizationLogoAssets.id, previousAssetId),
              ),
            );
        }
        await this.writeLogoAudit(tx, tenantId, actorUserId, previousAssetId, assetId);
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      this.logger.error(
        `Could not activate organization logo for tenant ${tenantId}, asset ${assetId}: ${errorMessage(error)}`,
      );
      throw new ServiceUnavailableException("Could not activate logo");
    }

    if (previousAssetId) await this.tryDeleteLogoAsset(tenantId, previousAssetId);
    return { logoRevision: assetId };
  }

  async deleteLogo(tenantId: string, actorUserId: string): Promise<void> {
    let previousAssetId: string | null = null;
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${schema.orgProfiles.tenantId} from ${schema.orgProfiles} where ${schema.orgProfiles.tenantId} = ${tenantId} for update`,
      );
      const [current] = await tx
        .select({ logoAssetId: schema.orgProfiles.logoAssetId })
        .from(schema.orgProfiles)
        .where(eq(schema.orgProfiles.tenantId, tenantId))
        .limit(1);
      previousAssetId = current?.logoAssetId ?? null;
      if (!previousAssetId) return;
      await tx
        .update(schema.orgProfiles)
        .set({ logoAssetId: null, updatedAt: new Date() })
        .where(eq(schema.orgProfiles.tenantId, tenantId));
      await tx
        .update(schema.organizationLogoAssets)
        .set({ status: "deleting", updatedAt: new Date() })
        .where(
          and(
            eq(schema.organizationLogoAssets.tenantId, tenantId),
            eq(schema.organizationLogoAssets.id, previousAssetId),
          ),
        );
      await this.writeLogoAudit(tx, tenantId, actorUserId, previousAssetId, null);
    });
    if (previousAssetId) await this.tryDeleteLogoAsset(tenantId, previousAssetId);
  }

  async getKioskBranding(tenantId: string): Promise<KioskBrandingDto> {
    const [row] = await this.db
      .select({
        organizationName: schema.organization.name,
        logoRevision: schema.organizationLogoAssets.id,
      })
      .from(schema.organization)
      .leftJoin(schema.orgProfiles, eq(schema.orgProfiles.tenantId, schema.organization.id))
      .leftJoin(
        schema.organizationLogoAssets,
        and(
          eq(schema.organizationLogoAssets.tenantId, schema.organization.id),
          eq(schema.organizationLogoAssets.id, schema.orgProfiles.logoAssetId),
          eq(schema.organizationLogoAssets.status, "active"),
        ),
      )
      .where(eq(schema.organization.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundException("Organization not found");
    return {
      organizationName: row.organizationName,
      logoUrl: row.logoRevision ? `/kiosk/branding/logo/${row.logoRevision}` : null,
      logoRevision: row.logoRevision,
    };
  }

  async getKioskLogo(
    tenantId: string,
    revision: string,
  ): Promise<{ body: Buffer; contentType: "image/webp" }> {
    const [asset] = await this.db
      .select({
        objectKey: schema.organizationLogoAssets.objectKey,
        contentType: schema.organizationLogoAssets.contentType,
      })
      .from(schema.orgProfiles)
      .innerJoin(
        schema.organizationLogoAssets,
        and(
          eq(schema.organizationLogoAssets.tenantId, schema.orgProfiles.tenantId),
          eq(schema.organizationLogoAssets.id, schema.orgProfiles.logoAssetId),
          eq(schema.organizationLogoAssets.status, "active"),
        ),
      )
      .where(
        and(
          eq(schema.orgProfiles.tenantId, tenantId),
          eq(schema.organizationLogoAssets.id, revision),
        ),
      )
      .limit(1);
    if (!asset || asset.contentType !== "image/webp") throw new NotFoundException("Logo not found");
    try {
      const object = await this.storage.get(asset.objectKey);
      if (object.contentType !== "image/webp") throw new NotFoundException("Logo not found");
      return { body: object.body, contentType: "image/webp" };
    } catch (error) {
      if (error instanceof NotFoundException || isMissingObjectError(error)) {
        throw new NotFoundException("Logo not found");
      }
      this.logger.error(
        `Could not read organization logo for tenant ${tenantId}, revision ${revision}: ${errorMessage(error)}`,
      );
      throw new ServiceUnavailableException("Logo storage is unavailable");
    }
  }

  async reconcileLogoAssets(now = new Date(), limit = 50): Promise<number> {
    const staleBefore = new Date(now.getTime() - 15 * 60 * 1_000);
    const candidates = await this.db
      .select({
        id: schema.organizationLogoAssets.id,
        tenantId: schema.organizationLogoAssets.tenantId,
        objectKey: schema.organizationLogoAssets.objectKey,
        status: schema.organizationLogoAssets.status,
      })
      .from(schema.organizationLogoAssets)
      .leftJoin(
        schema.orgProfiles,
        and(
          eq(schema.orgProfiles.tenantId, schema.organizationLogoAssets.tenantId),
          eq(schema.orgProfiles.logoAssetId, schema.organizationLogoAssets.id),
        ),
      )
      .where(
        and(
          inArray(schema.organizationLogoAssets.status, ["staging", "deleting"]),
          lt(schema.organizationLogoAssets.updatedAt, staleBefore),
          isNull(schema.orgProfiles.tenantId),
        ),
      )
      .limit(limit);

    let reconciled = 0;
    for (const candidate of candidates) {
      const claimed = await this.db
        .update(schema.organizationLogoAssets)
        .set({ status: "deleting", updatedAt: now })
        .where(
          and(
            eq(schema.organizationLogoAssets.tenantId, candidate.tenantId),
            eq(schema.organizationLogoAssets.id, candidate.id),
            eq(schema.organizationLogoAssets.status, candidate.status),
            lte(schema.organizationLogoAssets.updatedAt, staleBefore),
          ),
        )
        .returning({ id: schema.organizationLogoAssets.id });
      if (claimed.length !== 1) continue;

      const [reference] = await this.db
        .select({ tenantId: schema.orgProfiles.tenantId })
        .from(schema.orgProfiles)
        .where(
          and(
            eq(schema.orgProfiles.tenantId, candidate.tenantId),
            eq(schema.orgProfiles.logoAssetId, candidate.id),
          ),
        )
        .limit(1);
      if (reference) continue;

      try {
        await this.storage.delete(candidate.objectKey);
      } catch {
        continue;
      }
      const result = await this.db.delete(schema.organizationLogoAssets).where(
        and(
          eq(schema.organizationLogoAssets.tenantId, candidate.tenantId),
          eq(schema.organizationLogoAssets.id, candidate.id),
          eq(schema.organizationLogoAssets.status, "deleting"),
          notExists(
            this.db
              .select({ tenantId: schema.orgProfiles.tenantId })
              .from(schema.orgProfiles)
              .where(
                and(
                  eq(schema.orgProfiles.tenantId, candidate.tenantId),
                  eq(schema.orgProfiles.logoAssetId, candidate.id),
                ),
              ),
          ),
        ),
      );
      reconciled += result.rowCount ?? 0;
    }
    return reconciled;
  }

  private async tryDeleteLogoAsset(tenantId: string, assetId: string): Promise<void> {
    const [asset] = await this.db
      .select({ objectKey: schema.organizationLogoAssets.objectKey })
      .from(schema.organizationLogoAssets)
      .where(
        and(
          eq(schema.organizationLogoAssets.tenantId, tenantId),
          eq(schema.organizationLogoAssets.id, assetId),
          eq(schema.organizationLogoAssets.status, "deleting"),
        ),
      )
      .limit(1);
    if (!asset) return;
    try {
      await this.storage.delete(asset.objectKey);
      await this.db
        .delete(schema.organizationLogoAssets)
        .where(
          and(
            eq(schema.organizationLogoAssets.tenantId, tenantId),
            eq(schema.organizationLogoAssets.id, assetId),
            eq(schema.organizationLogoAssets.status, "deleting"),
          ),
        );
    } catch (error) {
      this.logger.warn(
        `Deferred organization logo cleanup for tenant ${tenantId}, asset ${assetId}: ${errorMessage(error)}`,
      );
    }
  }

  private async writeLogoAudit(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    tenantId: string,
    actorUserId: string,
    beforeRevision: string | null,
    afterRevision: string | null,
  ): Promise<void> {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: "organization.logo.updated",
      outcome: "success",
      targetType: "organization",
      targetId: tenantId,
      before: { logoRevision: beforeRevision },
      after: { logoRevision: afterRevision },
    });
  }

  /** Produces the tenant's registered GS1 company prefixes (for Task 6's GTIN-ownership check). */
  async getPrefixes(tenantId: string): Promise<string[]> {
    const profile = await this.getProfile(tenantId);
    return profile.gs1Prefixes;
  }

  /**
   * The tenant's own box SSCC counter (Task 5). Always reads
   * `BOX_EXTENSION_DIGIT` -- 06c only has boxes; 06d's pallets (extension
   * digit 1) will need their own read path once that counter exists.
   * Returns `nextSerial: 0` if no row has been seeded yet, same convention
   * as `getProfile`'s `EMPTY_PROFILE` fallback.
   */
  async getSscc(tenantId: string): Promise<SsccCounterDto> {
    const issuerPrefix = await this.ownIssuerPrefix(tenantId);
    const [row] = await this.db
      .select({ nextSerial: schema.ssccCounters.nextSerial })
      .from(schema.ssccCounters)
      .where(
        and(
          eq(schema.ssccCounters.tenantId, tenantId),
          eq(schema.ssccCounters.issuerPrefix, issuerPrefix),
          eq(schema.ssccCounters.extensionDigit, BOX_EXTENSION_DIGIT),
        ),
      );
    return { extensionDigit: BOX_EXTENSION_DIGIT, nextSerial: row ? Number(row.nextSerial) : 0 };
  }

  /**
   * Seeds (or reseeds) the tenant's own box counter -- how a plant migrating
   * off another system continues issuing SSCCs under the same prefix
   * without re-handing-out serials that system already used. Keyed by the
   * prefix derived from the org's own GLN, not the GLN itself (see
   * `deriveIssuerPrefix`'s doc comment).
   *
   * Refuses to seed below `seedFloor` (final review, finding 2): once a
   * block has been handed to a device under this prefix, reseeding lower
   * would let the next `allocate` cut a range overlapping one already in a
   * device's hands -- an SSCC collision across devices. Not silently
   * clamped -- an admin correcting a typo before any block has ever been
   * issued must still be free to seed anywhere.
   *
   * CodeRabbit PR33 review, Finding 5: the `seedFloor` read above and the
   * write below used to be two SEPARATE statements. If a device's
   * `allocate()` call landed in between -- advancing the counter and
   * recording a new block -- this write would still land unconditionally,
   * silently overwriting the counter with a value now BEHIND that block,
   * reopening exactly the cross-device collision `seedFloor` exists to
   * prevent. `atomicSeedSscc` closes that gap by re-validating the SAME
   * condition live, inside the single statement that performs the write
   * (`ON CONFLICT DO UPDATE ... WHERE`) -- see its own doc comment. A `false`
   * return means the floor moved between this method's own `seedFloor` read
   * above and the write: reported as a 409 the admin can retry, not
   * silently landed on a stale value.
   */
  async putSscc(tenantId: string, dto: SsccCounterDto): Promise<SsccCounterDto> {
    const issuerPrefix = await this.ownIssuerPrefix(tenantId);
    const floor = await seedFloor(this.db, tenantId, issuerPrefix, dto.extensionDigit);
    if (dto.nextSerial < floor) {
      throw new BadRequestException(
        `nextSerial must be at least ${floor}: serials below it were already issued to a device under this prefix`,
      );
    }
    const applied = await atomicSeedSscc(
      this.db,
      tenantId,
      issuerPrefix,
      dto.extensionDigit,
      dto.nextSerial,
    );
    if (!applied) {
      throw new ConflictException(
        "nextSerial floor moved: a box serial block was issued under this prefix while this seed was in flight. Retry with the current floor.",
      );
    }
    return { extensionDigit: dto.extensionDigit, nextSerial: dto.nextSerial };
  }

  /** The 9-digit prefix derived from the tenant's own GLN; 400s if none is set yet. */
  private async ownIssuerPrefix(tenantId: string): Promise<string> {
    const profile = await this.getProfile(tenantId);
    if (!profile.gln) throw new BadRequestException("organisation profile has no GLN");
    return deriveIssuerPrefix(profile.gln, "organisation profile");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
