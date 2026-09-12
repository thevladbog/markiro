import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, getTableColumns, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
    // Deliberately matches only the *losing* shift, via the
    // (tenantId, losingShiftId) index from 06b Task 1 -- the cheap, indexed
    // path. `code_conflicts` is tenant-wide, not shift-scoped, and
    // cross-shift conflicts are expected: a shift that *won* a code taken
    // from another shift will never show up when filtered by its own id.
    // Accepted, because this list exists for the manager closing the
    // *losing* shift (the one the station is never told about), not as a
    // general "everything involving shift X" view -- see the admin
    // conflicts page's shift filter, whose copy says exactly this.
    if (query.shiftId) conditions.push(eq(schema.codeConflicts.losingShiftId, query.shiftId));
    if (query.reviewed !== undefined) {
      conditions.push(
        query.reviewed
          ? isNotNull(schema.codeConflicts.reviewedAt)
          : isNull(schema.codeConflicts.reviewedAt),
      );
    }

    const rows = await this.selectConflicts()
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
    const [enriched] = await this.selectConflicts().where(
      and(eq(schema.codeConflicts.tenantId, tenantId), eq(schema.codeConflicts.id, id)),
    );
    if (!enriched) throw new NotFoundException();
    return this.toDto(enriched);
  }

  private selectConflicts() {
    const losingTerminal = alias(schema.stationDevices, "losing_terminal");
    const winningTerminal = alias(schema.stationDevices, "winning_terminal");
    return (
      this.db
        .select({
          ...getTableColumns(schema.codeConflicts),
          rawKm: schema.codes.canonicalRaw,
          losingTerminalName: losingTerminal.name,
          winningTerminalName: winningTerminal.name,
        })
        .from(schema.codeConflicts)
        // Use the historical losing scan, not the registry's current owner.
        // The codes primary key guarantees that this join cannot multiply rows.
        .leftJoin(
          schema.codes,
          and(
            eq(schema.codes.tenantId, schema.codeConflicts.tenantId),
            eq(schema.codes.codeHash, schema.codeConflicts.codeHash),
            eq(schema.codes.scannedAt, schema.codeConflicts.losingScannedAt),
          ),
        )
        // Legacy terminal IDs can be arbitrary text. Cast the device UUID to
        // text instead of casting untrusted historical IDs to UUID.
        .leftJoin(
          losingTerminal,
          and(
            eq(losingTerminal.tenantId, schema.codeConflicts.tenantId),
            eq(sql<string>`${losingTerminal.id}::text`, schema.codeConflicts.losingTerminalId),
          ),
        )
        .leftJoin(
          winningTerminal,
          and(
            eq(winningTerminal.tenantId, schema.codeConflicts.tenantId),
            eq(sql<string>`${winningTerminal.id}::text`, schema.codeConflicts.winningTerminalId),
          ),
        )
    );
  }

  private toDto(
    row: typeof schema.codeConflicts.$inferSelect & {
      rawKm: string | null;
      losingTerminalName: string | null;
      winningTerminalName: string | null;
    },
  ): ConflictDto {
    return {
      id: row.id,
      codeHash: row.codeHash,
      rawKm: row.rawKm,
      losingTerminalName: row.losingTerminalName,
      winningTerminalName: row.winningTerminalName,
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
