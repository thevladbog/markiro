import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { ConflictDto, ListConflictsQueryDto, ListConflictsResponseDto } from "./dto";

@Injectable()
export class ConflictsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * The tenant's `code_conflicts` rows, newest detection first. The
   * displaced-scan case (the losing terminal is never told) is the reason
   * this list exists at all -- see the module's report -- so every filter is
   * applied in the query itself, never as a post-fetch narrowing.
   */
  async listConflicts(
    tenantId: string,
    query: ListConflictsQueryDto,
  ): Promise<ListConflictsResponseDto> {
    const conditions = [eq(schema.codeConflicts.tenantId, tenantId)];
    if (query.shiftId) conditions.push(eq(schema.codeConflicts.losingShiftId, query.shiftId));
    if (query.reviewed !== undefined) {
      conditions.push(
        query.reviewed
          ? isNotNull(schema.codeConflicts.reviewedAt)
          : isNull(schema.codeConflicts.reviewedAt),
      );
    }

    const rows = await this.db
      .select()
      .from(schema.codeConflicts)
      .where(and(...conditions))
      .orderBy(desc(schema.codeConflicts.detectedAt));

    return { items: rows.map((row) => this.toDto(row)) };
  }

  /**
   * Marks a conflict reviewed, tenant-scoped in the `UPDATE ... WHERE`
   * itself. Throws `NotFoundException` when nothing came back -- a wrong id
   * and someone else's tenant's id are indistinguishable to the caller, so
   * one tenant cannot use this to probe whether another tenant's conflict id
   * exists.
   */
  async reviewConflict(tenantId: string, id: string): Promise<ConflictDto> {
    const [row] = await this.db
      .update(schema.codeConflicts)
      .set({ reviewedAt: new Date() })
      .where(and(eq(schema.codeConflicts.tenantId, tenantId), eq(schema.codeConflicts.id, id)))
      .returning();
    if (!row) throw new NotFoundException();
    return this.toDto(row);
  }

  private toDto(row: typeof schema.codeConflicts.$inferSelect): ConflictDto {
    return {
      id: row.id,
      codeHash: row.codeHash,
      losingShiftId: row.losingShiftId,
      losingTerminalId: row.losingTerminalId,
      losingScannedAt: row.losingScannedAt,
      winningShiftId: row.winningShiftId,
      winningTerminalId: row.winningTerminalId,
      winningScannedAt: row.winningScannedAt,
      detectedAt: row.detectedAt,
      reviewedAt: row.reviewedAt,
    };
  }
}
