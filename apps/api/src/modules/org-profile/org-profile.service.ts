import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { OrgProfileDto, PutOrgProfileDto } from "./dto";

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
}
