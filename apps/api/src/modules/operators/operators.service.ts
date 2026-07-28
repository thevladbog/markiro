import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { parsePhc } from "@markiro/domain";
import { schema, type Db, type OperatorMirrorRecord } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { getOrCreateBadgeSalt, hashBadgeWithSalt } from "../../lib/badge-salt";
import { hashSecret } from "../../lib/pin-hash";
import type {
  GrantStationAccessDto,
  ListOperatorsResponseDto,
  StationAccessDto,
  UpdateStationAccessDto,
} from "./dto";

/** Fallback for the station record's required `role` when the employee has none. */
const DEFAULT_ROLE = "operator";

@Injectable()
export class OperatorsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listOperators(tenantId: string): Promise<ListOperatorsResponseDto> {
    const rows = await this.db
      .select({
        employeeId: schema.operatorCredentials.employeeId,
        login: schema.operatorCredentials.login,
        active: schema.operatorCredentials.active,
        fullName: schema.employees.fullName,
        role: schema.employees.role,
      })
      .from(schema.operatorCredentials)
      .innerJoin(
        schema.employees,
        and(
          eq(schema.employees.tenantId, schema.operatorCredentials.tenantId),
          eq(schema.employees.id, schema.operatorCredentials.employeeId),
        ),
      )
      .where(eq(schema.operatorCredentials.tenantId, tenantId))
      .orderBy(schema.employees.fullName);

    const badged = await this.activeBadgeCodes(tenantId);
    return {
      items: rows.map((r) => ({
        employeeId: r.employeeId,
        fullName: r.fullName,
        role: r.role,
        login: r.login,
        active: r.active,
        hasBadge: badged.has(r.employeeId),
      })),
    };
  }

  async grantAccess(
    tenantId: string,
    employeeId: string,
    dto: GrantStationAccessDto,
  ): Promise<StationAccessDto> {
    await this.requireEmployee(tenantId, employeeId);
    const pinHash = await hashSecret(dto.pin);
    try {
      const [row] = await this.db
        .insert(schema.operatorCredentials)
        .values({ tenantId, employeeId, login: dto.login, pinHash, active: true })
        .onConflictDoUpdate({
          target: [schema.operatorCredentials.tenantId, schema.operatorCredentials.employeeId],
          set: { login: dto.login, pinHash, active: true, updatedAt: new Date() },
        })
        .returning();
      return this.toDto(row!);
    } catch (error) {
      throw this.mapWriteError(error);
    }
  }

  async updateAccess(
    tenantId: string,
    employeeId: string,
    dto: UpdateStationAccessDto,
  ): Promise<StationAccessDto> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.login !== undefined) set.login = dto.login;
    if (dto.active !== undefined) set.active = dto.active;
    if (dto.pin !== undefined) set.pinHash = await hashSecret(dto.pin);
    try {
      const [row] = await this.db
        .update(schema.operatorCredentials)
        .set(set)
        .where(
          and(
            eq(schema.operatorCredentials.tenantId, tenantId),
            eq(schema.operatorCredentials.employeeId, employeeId),
          ),
        )
        .returning();
      if (!row) throw new NotFoundException();
      return this.toDto(row);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw this.mapWriteError(error);
    }
  }

  async revokeAccess(tenantId: string, employeeId: string): Promise<void> {
    const [row] = await this.db
      .delete(schema.operatorCredentials)
      .where(
        and(
          eq(schema.operatorCredentials.tenantId, tenantId),
          eq(schema.operatorCredentials.employeeId, employeeId),
        ),
      )
      .returning();
    if (!row) throw new NotFoundException();
  }

  /**
   * The station roster: every ACTIVE operator of the tenant with the PBKDF2
   * verifiers the device stores in `operators_mirror`. Shared by
   * `GET /station/operators` and `GET /shifts/:id/bundle` — one query, two
   * consumers, so the two can never drift.
   */
  async buildRoster(tenantId: string): Promise<OperatorMirrorRecord[]> {
    const rows = await this.db
      .select({
        employeeId: schema.operatorCredentials.employeeId,
        login: schema.operatorCredentials.login,
        pinHash: schema.operatorCredentials.pinHash,
        fullName: schema.employees.fullName,
        role: schema.employees.role,
      })
      .from(schema.operatorCredentials)
      .innerJoin(
        schema.employees,
        and(
          eq(schema.employees.tenantId, schema.operatorCredentials.tenantId),
          eq(schema.employees.id, schema.operatorCredentials.employeeId),
        ),
      )
      .where(
        and(
          eq(schema.operatorCredentials.tenantId, tenantId),
          eq(schema.operatorCredentials.active, true),
          eq(schema.employees.status, "active"),
        ),
      )
      .orderBy(schema.employees.fullName);

    const badgeHashes = await this.activeBadgeHashes(
      tenantId,
      rows.map((r) => r.employeeId),
    );
    return rows.map((r) => ({
      operatorId: r.employeeId,
      name: r.fullName,
      role: r.role ?? DEFAULT_ROLE,
      login: r.login,
      pinHash: r.pinHash,
      badgeHash: badgeHashes.get(r.employeeId) ?? null,
      active: true,
    }));
  }

  /** Badge verifiers for the given employees, hashed under the tenant salt. */
  async badgeHashesFor(tenantId: string, employeeIds: string[]): Promise<Map<string, string>> {
    return this.activeBadgeHashes(tenantId, employeeIds);
  }

  /**
   * Badge hashes for the given roster employees only (never the whole
   * tenant's badge table — legacy tenants can carry thousands of unrelated
   * badges). The plaintext code stays server-side (it is a shared identifier
   * used by the pickup kiosk and external systems); the device only ever
   * receives the hash. Rows issued before the `badge_hash` column existed are
   * hashed and backfilled on first read, concurrently rather than one at a
   * time, since PBKDF2 is deliberately slow.
   *
   * Determinism: an employee can hold more than one active badge (nothing in
   * the schema forbids it). The rule, enforced here, is "the most recently
   * issued active badge wins" — rows are fetched ordered by `issuedAt`
   * ascending (tie-broken by `id` for full determinism), and later rows
   * overwrite earlier ones in the returned map.
   */
  private async activeBadgeHashes(
    tenantId: string,
    employeeIds: string[],
  ): Promise<Map<string, string>> {
    if (employeeIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(schema.employeeBadges)
      .where(
        and(
          eq(schema.employeeBadges.tenantId, tenantId),
          isNull(schema.employeeBadges.revokedAt),
          inArray(schema.employeeBadges.employeeId, employeeIds),
        ),
      )
      .orderBy(asc(schema.employeeBadges.issuedAt), asc(schema.employeeBadges.id));

    // A badge needs (re)hashing when it has no verifier yet, or when its
    // verifier still carries a legacy per-row salt. Both cases converge on
    // the tenant salt so the kiosk's one-derivation lookup works.
    const tenantSalt = await getOrCreateBadgeSalt(this.db, tenantId);
    const needsHash = rows.filter((b) => {
      if (!b.badgeHash) return true;
      return parsePhc(b.badgeHash)?.saltB64 !== tenantSalt;
    });
    const backfilled = new Map<string, string>();
    // Bounded concurrency, on purpose: WebCrypto's PBKDF2 (`deriveBits`) runs
    // on libuv's threadpool (default size 4), so an unbounded `Promise.all`
    // over `needsHash` would saturate that pool and stall the whole
    // process's async crypto/fs/DNS for roughly N * ~50ms / 4 -- every
    // pre-existing badge in the tenant matches this filter on the first read
    // after a migration to the tenant salt (not just the handful with no
    // hash yet), so N can be the tenant's entire active roster. Chunking to
    // 8 keeps only a handful of derivations in flight regardless of how many
    // rows need a rehash. Do not "optimise" this back to one `Promise.all`.
    const REHASH_CHUNK_SIZE = 8;
    for (let i = 0; i < needsHash.length; i += REHASH_CHUNK_SIZE) {
      const chunk = needsHash.slice(i, i + REHASH_CHUNK_SIZE);
      await Promise.all(
        chunk.map(async (b) => {
          const hash = await hashBadgeWithSalt(b.badgeCode, tenantSalt);
          backfilled.set(b.id, hash);
          await this.db
            .update(schema.employeeBadges)
            .set({ badgeHash: hash })
            .where(
              and(eq(schema.employeeBadges.tenantId, tenantId), eq(schema.employeeBadges.id, b.id)),
            );
        }),
      );
    }

    const map = new Map<string, string>();
    for (const b of rows) {
      map.set(b.employeeId, backfilled.get(b.id) ?? b.badgeHash!);
    }
    return map;
  }

  private async activeBadgeCodes(tenantId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ employeeId: schema.employeeBadges.employeeId })
      .from(schema.employeeBadges)
      .where(
        and(eq(schema.employeeBadges.tenantId, tenantId), isNull(schema.employeeBadges.revokedAt)),
      );
    return new Set(rows.map((r) => r.employeeId));
  }

  private async requireEmployee(tenantId: string, employeeId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: schema.employees.id })
      .from(schema.employees)
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, employeeId)));
    if (!row) throw new NotFoundException();
  }

  /** 23505 = unique violation (the per-tenant login). Drizzle wraps pg errors. */
  private mapWriteError(error: unknown): Error {
    const code =
      (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") return new ConflictException("Login already in use");
    return error as Error;
  }

  private toDto(row: typeof schema.operatorCredentials.$inferSelect): StationAccessDto {
    return {
      employeeId: row.employeeId,
      login: row.login,
      active: row.active,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
