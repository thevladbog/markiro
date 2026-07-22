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
   */
  async upsertProfile(tenantId: string, patch: PutOrgProfileDto): Promise<OrgProfileDto> {
    const current = await this.getProfile(tenantId);
    const next: OrgProfileDto = {
      gln: patch.gln !== undefined ? patch.gln : current.gln,
      gs1Prefixes: patch.gs1Prefixes !== undefined ? patch.gs1Prefixes : current.gs1Prefixes,
      inn: patch.inn !== undefined ? patch.inn : current.inn,
    };

    await this.db
      .insert(schema.orgProfiles)
      .values({ tenantId, ...next })
      .onConflictDoUpdate({
        target: schema.orgProfiles.tenantId,
        set: { ...next, updatedAt: new Date() },
      });

    return next;
  }

  /** Produces the tenant's registered GS1 company prefixes (for Task 6's GTIN-ownership check). */
  async getPrefixes(tenantId: string): Promise<string[]> {
    const profile = await this.getProfile(tenantId);
    return profile.gs1Prefixes;
  }
}
