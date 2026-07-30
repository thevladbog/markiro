import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { BOX_EXTENSION_DIGIT, deriveIssuerPrefix, seedFloor } from "../sscc/sscc.service";
import type { OrgProfileDto, PutOrgProfileDto, SsccCounterDto } from "./dto";

const EMPTY_PROFILE: OrgProfileDto = { gln: null, gs1Prefixes: [], inn: null };

@Injectable()
export class OrgProfileService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Returns the tenant's profile, or the empty defaults if no row exists yet. */
  async getProfile(tenantId: string): Promise<OrgProfileDto> {
    const [row] = await this.db
      .select()
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, tenantId));

    return row ? { gln: row.gln, gs1Prefixes: row.gs1Prefixes, inn: row.inn } : EMPTY_PROFILE;
  }

  /**
   * Upserts only the fields present in `patch` (undefined = leave untouched,
   * explicit null = clear); fields omitted entirely keep their current
   * value (or the empty default if the row doesn't exist yet).
   * Atomic: no read-then-write race — merge happens in SQL via onConflictDoUpdate.
   */
  async upsertProfile(tenantId: string, patch: PutOrgProfileDto): Promise<OrgProfileDto> {
    const setClause: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.gln !== undefined) setClause.gln = patch.gln;
    if (patch.gs1Prefixes !== undefined) setClause.gs1Prefixes = patch.gs1Prefixes;
    if (patch.inn !== undefined) setClause.inn = patch.inn;

    await this.db
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

    return this.getProfile(tenantId);
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
   */
  async putSscc(tenantId: string, dto: SsccCounterDto): Promise<SsccCounterDto> {
    const issuerPrefix = await this.ownIssuerPrefix(tenantId);
    const floor = await seedFloor(this.db, tenantId, issuerPrefix, dto.extensionDigit);
    if (dto.nextSerial < floor) {
      throw new BadRequestException(
        `nextSerial must be at least ${floor}: serials below it were already issued to a device under this prefix`,
      );
    }
    await this.db
      .insert(schema.ssccCounters)
      .values({
        tenantId,
        issuerPrefix,
        extensionDigit: dto.extensionDigit,
        nextSerial: dto.nextSerial,
      })
      .onConflictDoUpdate({
        target: [
          schema.ssccCounters.tenantId,
          schema.ssccCounters.issuerPrefix,
          schema.ssccCounters.extensionDigit,
        ],
        set: { nextSerial: dto.nextSerial, updatedAt: sql`now()` },
      });
    return { extensionDigit: dto.extensionDigit, nextSerial: dto.nextSerial };
  }

  /** The 9-digit prefix derived from the tenant's own GLN; 400s if none is set yet. */
  private async ownIssuerPrefix(tenantId: string): Promise<string> {
    const profile = await this.getProfile(tenantId);
    if (!profile.gln) throw new BadRequestException("organisation profile has no GLN");
    return deriveIssuerPrefix(profile.gln, "organisation profile");
  }
}
