import { Inject, Injectable } from "@nestjs/common";
import type { ShiftExportBoxMode, ShiftExportSource } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { DB } from "../../auth/auth.module";

export type ShiftExportSourceErrorCode =
  "SHIFT_NOT_CLOSED" | "SHIFT_HAS_NO_CODES" | "SHIFT_DATE_MISSING" | "BOX_COVERAGE_INCOMPLETE";

export class ShiftExportSourceError extends Error {
  constructor(readonly code: ShiftExportSourceErrorCode) {
    super(code);
    this.name = "ShiftExportSourceError";
  }
}

export interface ShiftExportSnapshot {
  sourceSnapshotStartedAt: Date;
  productName: string;
  shiftDate: string;
  source: ShiftExportSource;
}

interface AuthoritativeCodeRow {
  tenantId: string;
  shiftId: string;
  codeHash: string;
  scannedAt: Date;
  canonicalRaw: string;
}

interface BoxMembershipRow {
  tenantId: string;
  shiftId: string;
  boxId: string;
  sscc: string | null;
  closedAt: Date | null;
  disassembledAt: Date | null;
  codeHash: string;
  displacedAt: Date | null;
  removedAt: Date | null;
}

type ShiftExportTransaction = Pick<Db, "select" | "execute">;

@Injectable()
export class ShiftExportSourceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  load(
    tenantId: string,
    shiftId: string,
    boxMode: ShiftExportBoxMode,
  ): Promise<ShiftExportSnapshot> {
    return this.db.transaction(
      async (tx) => this.loadFromTransaction(tx, tenantId, shiftId, boxMode),
      {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      },
    );
  }

  private async loadFromTransaction(
    tx: ShiftExportTransaction,
    tenantId: string,
    shiftId: string,
    boxMode: ShiftExportBoxMode,
  ): Promise<ShiftExportSnapshot> {
    const snapshotResult = await tx.execute(
      sql<{
        sourceSnapshotStartedAt: Date | string;
      }>`select transaction_timestamp() as "sourceSnapshotStartedAt"`,
    );
    const rawSnapshotStartedAt = snapshotResult.rows[0]?.sourceSnapshotStartedAt;
    const sourceSnapshotStartedAt =
      rawSnapshotStartedAt instanceof Date
        ? rawSnapshotStartedAt
        : typeof rawSnapshotStartedAt === "string"
          ? new Date(rawSnapshotStartedAt)
          : undefined;
    if (!sourceSnapshotStartedAt || Number.isNaN(sourceSnapshotStartedAt.getTime())) {
      throw new Error("Shift export snapshot timestamp is unavailable");
    }

    const [shift] = await tx
      .select({
        tenantId: schema.shifts.tenantId,
        shiftId: schema.shifts.id,
        status: schema.shifts.status,
        plannedDate: schema.shifts.plannedDate,
        productName: schema.products.name,
      })
      .from(schema.shifts)
      .leftJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.shifts.tenantId),
          eq(schema.products.id, schema.shifts.productId),
        ),
      )
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)))
      .limit(1);

    if (
      !shift ||
      shift.tenantId !== tenantId ||
      shift.shiftId !== shiftId ||
      shift.status !== "closed"
    ) {
      throw new ShiftExportSourceError("SHIFT_NOT_CLOSED");
    }
    if (shift.plannedDate === null) {
      throw new ShiftExportSourceError("SHIFT_DATE_MISSING");
    }

    const authoritativeRows: AuthoritativeCodeRow[] = await tx
      .select({
        tenantId: schema.codeRegistry.tenantId,
        shiftId: schema.codeRegistry.shiftId,
        codeHash: schema.codeRegistry.codeHash,
        scannedAt: schema.codeRegistry.scannedAt,
        canonicalRaw: schema.codes.canonicalRaw,
      })
      .from(schema.codeRegistry)
      .innerJoin(
        schema.codes,
        and(
          eq(schema.codeRegistry.tenantId, schema.codes.tenantId),
          eq(schema.codeRegistry.codeHash, schema.codes.codeHash),
          eq(schema.codeRegistry.shiftId, schema.codes.shiftId),
          eq(schema.codeRegistry.scannedAt, schema.codes.scannedAt),
        ),
      )
      .where(
        and(eq(schema.codeRegistry.tenantId, tenantId), eq(schema.codeRegistry.shiftId, shiftId)),
      );

    const authoritative = authoritativeRows
      .filter((row) => row.tenantId === tenantId && row.shiftId === shiftId)
      .sort(compareAuthoritativeCodes);
    if (authoritative.length === 0) {
      throw new ShiftExportSourceError("SHIFT_HAS_NO_CODES");
    }

    const source =
      boxMode === "flat"
        ? ({ mode: "flat", codes: authoritative.map((row) => row.canonicalRaw) } as const)
        : await this.loadBoxes(tx, tenantId, shiftId, authoritative);

    return {
      sourceSnapshotStartedAt,
      productName: shift.productName ?? "Продукция",
      shiftDate: shift.plannedDate,
      source,
    };
  }

  private async loadBoxes(
    tx: ShiftExportTransaction,
    tenantId: string,
    shiftId: string,
    authoritative: readonly AuthoritativeCodeRow[],
  ): Promise<ShiftExportSource> {
    const membershipRows: BoxMembershipRow[] = await tx
      .select({
        tenantId: schema.boxItems.tenantId,
        shiftId: schema.boxes.shiftId,
        boxId: schema.boxItems.boxId,
        sscc: schema.boxes.sscc,
        closedAt: schema.boxes.closedAt,
        disassembledAt: schema.boxes.disassembledAt,
        codeHash: schema.boxItems.codeHash,
        displacedAt: schema.boxItems.displacedAt,
        removedAt: schema.boxItems.removedAt,
      })
      .from(schema.boxItems)
      .innerJoin(
        schema.boxes,
        and(
          eq(schema.boxes.tenantId, schema.boxItems.tenantId),
          eq(schema.boxes.id, schema.boxItems.boxId),
        ),
      )
      .where(and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxes.shiftId, shiftId)));

    const relevant = membershipRows.filter(
      (row) => row.tenantId === tenantId && row.shiftId === shiftId,
    );
    const eligible = relevant.filter(
      (row): row is BoxMembershipRow & { sscc: string } =>
        row.closedAt !== null &&
        row.sscc !== null &&
        row.disassembledAt === null &&
        row.displacedAt === null &&
        row.removedAt === null,
    );
    const authoritativeByHash = new Map(authoritative.map((row) => [row.codeHash, row]));
    const membershipCounts = new Map<string, number>();
    for (const row of eligible) {
      membershipCounts.set(row.codeHash, (membershipCounts.get(row.codeHash) ?? 0) + 1);
    }

    const coverageIsExact =
      eligible.length === authoritative.length &&
      eligible.every((row) => authoritativeByHash.has(row.codeHash)) &&
      authoritative.every((row) => membershipCounts.get(row.codeHash) === 1);
    if (!coverageIsExact) {
      throw new ShiftExportSourceError("BOX_COVERAGE_INCOMPLETE");
    }

    const rowsByBox = new Map<string, { sscc: string; rows: BoxMembershipRow[] }>();
    for (const row of eligible) {
      const existing = rowsByBox.get(row.boxId);
      if (existing) {
        if (existing.sscc !== row.sscc) {
          throw new ShiftExportSourceError("BOX_COVERAGE_INCOMPLETE");
        }
        existing.rows.push(row);
      } else {
        rowsByBox.set(row.boxId, { sscc: row.sscc, rows: [row] });
      }
    }

    const boxes = [...rowsByBox.values()]
      .sort((left, right) => compareCodeUnits(left.sscc, right.sscc))
      .map((box) => ({
        sscc: box.sscc,
        codes: box.rows
          .flatMap((row) => {
            const authoritativeRow = authoritativeByHash.get(row.codeHash);
            return authoritativeRow ? [authoritativeRow] : [];
          })
          .sort(compareAuthoritativeCodes)
          .map((row) => row.canonicalRaw),
      }));

    return { mode: "boxes", boxes };
  }
}

function compareAuthoritativeCodes(
  left: AuthoritativeCodeRow,
  right: AuthoritativeCodeRow,
): number {
  return (
    left.scannedAt.getTime() - right.scannedAt.getTime() ||
    compareCodeUnits(left.codeHash, right.codeHash)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
