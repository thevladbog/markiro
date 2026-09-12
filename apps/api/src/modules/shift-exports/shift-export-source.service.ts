import { Inject, Injectable } from "@nestjs/common";
import type {
  ShiftExportFormatDescriptor,
  ShiftExportPalletGroup,
  ShiftExportSource,
} from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { DB } from "../../auth/auth.module";

export type ShiftExportSourceErrorCode =
  | "SHIFT_NOT_CLOSED"
  | "SHIFT_HAS_NO_CODES"
  | "SHIFT_DATE_MISSING"
  | "BOX_COVERAGE_INCOMPLETE"
  | "SHIFT_HAS_NO_PALLETS"
  | "ORG_INN_MISSING";

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
  /** Tenant's ИНН; loaded only for formats that embed it (GISMT XML). */
  organizationInn: string | null;
  source: ShiftExportSource;
}

type ShiftExportSourceFormat = Pick<ShiftExportFormatDescriptor, "boxMode" | "extension">;

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
  /** The pallet this box stood on when it closed, or null for a loose box. */
  palletId: string | null;
  codeHash: string;
  displacedAt: Date | null;
  removedAt: Date | null;
}

/** One eligible (closed, non-disassembled, fully covered) box, still with its pallet reference. */
interface EligibleBox {
  boxId: string;
  sscc: string;
  palletId: string | null;
  codes: string[];
}

interface PalletRow {
  tenantId: string;
  shiftId: string;
  id: string;
  sscc: string | null;
  closedAt: Date | null;
}

type ShiftExportTransaction = Pick<Db, "select" | "execute">;

@Injectable()
export class ShiftExportSourceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  load(
    tenantId: string,
    shiftId: string,
    format: ShiftExportSourceFormat,
  ): Promise<ShiftExportSnapshot> {
    return this.db.transaction(
      async (tx) => this.loadFromTransaction(tx, tenantId, shiftId, format),
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
    format: ShiftExportSourceFormat,
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
        productionDate: schema.shifts.productionDate,
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
    const shiftDate = shift.productionDate ?? shift.plannedDate;
    if (shiftDate === null) {
      throw new ShiftExportSourceError("SHIFT_DATE_MISSING");
    }

    let organizationInn: string | null = null;
    if (format.extension === "xml") {
      const [profile] = await tx
        .select({ inn: schema.orgProfiles.inn })
        .from(schema.orgProfiles)
        .where(eq(schema.orgProfiles.tenantId, tenantId))
        .limit(1);
      organizationInn = profile?.inn?.trim() || null;
      if (organizationInn === null) {
        throw new ShiftExportSourceError("ORG_INN_MISSING");
      }
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

    let source: ShiftExportSource;
    if (format.boxMode === "flat") {
      source = { mode: "flat", codes: authoritative.map((row) => row.canonicalRaw) };
    } else {
      const eligibleBoxes = await this.loadEligibleBoxes(tx, tenantId, shiftId, authoritative);
      source =
        format.boxMode === "boxes"
          ? this.toBoxesSource(eligibleBoxes)
          : await this.toPalletsSource(tx, tenantId, shiftId, eligibleBoxes);
    }

    return {
      sourceSnapshotStartedAt,
      productName: shift.productName ?? "Продукция",
      shiftDate,
      organizationInn,
      source,
    };
  }

  /**
   * Every closed, non-disassembled box that fully (and exactly) covers the
   * shift's authoritative codes -- shared by both the `boxes` and `pallets`
   * box modes, which differ only in how they GROUP these same boxes.
   */
  private async loadEligibleBoxes(
    tx: ShiftExportTransaction,
    tenantId: string,
    shiftId: string,
    authoritative: readonly AuthoritativeCodeRow[],
  ): Promise<EligibleBox[]> {
    const membershipRows: BoxMembershipRow[] = await tx
      .select({
        tenantId: schema.boxItems.tenantId,
        shiftId: schema.boxes.shiftId,
        boxId: schema.boxItems.boxId,
        sscc: schema.boxes.sscc,
        closedAt: schema.boxes.closedAt,
        disassembledAt: schema.boxes.disassembledAt,
        palletId: schema.boxes.palletId,
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

    const rowsByBox = new Map<
      string,
      { sscc: string; palletId: string | null; rows: BoxMembershipRow[] }
    >();
    for (const row of eligible) {
      const existing = rowsByBox.get(row.boxId);
      if (existing) {
        if (existing.sscc !== row.sscc) {
          throw new ShiftExportSourceError("BOX_COVERAGE_INCOMPLETE");
        }
        existing.rows.push(row);
      } else {
        rowsByBox.set(row.boxId, { sscc: row.sscc, palletId: row.palletId, rows: [row] });
      }
    }

    return [...rowsByBox.entries()].map(([boxId, box]) => ({
      boxId,
      sscc: box.sscc,
      palletId: box.palletId,
      codes: box.rows
        .flatMap((row) => {
          const authoritativeRow = authoritativeByHash.get(row.codeHash);
          return authoritativeRow ? [authoritativeRow] : [];
        })
        .sort(compareAuthoritativeCodes)
        .map((row) => row.canonicalRaw),
    }));
  }

  private toBoxesSource(eligibleBoxes: readonly EligibleBox[]): ShiftExportSource {
    const boxes = [...eligibleBoxes]
      .sort((left, right) => compareCodeUnits(left.sscc, right.sscc))
      .map((box) => ({ sscc: box.sscc, codes: box.codes }));

    return { mode: "boxes", boxes };
  }

  /**
   * Groups the same eligible boxes by `pallet_id`: a box on a pallet joins
   * that pallet's group (ordered by the PALLET's own `closed_at`); a box with
   * no pallet, or whose pallet has not itself closed (no `sscc` to name yet),
   * is rendered loose, after every pallet. A shift can close before every
   * pallet does (`closeShift` does not gate on it), so a still-open pallet is
   * treated the same as no pallet at all rather than surfacing a document
   * that names a pallet with nothing to call it.
   */
  private async toPalletsSource(
    tx: ShiftExportTransaction,
    tenantId: string,
    shiftId: string,
    eligibleBoxes: readonly EligibleBox[],
  ): Promise<ShiftExportSource> {
    const palletRows: PalletRow[] = await tx
      .select({
        tenantId: schema.pallets.tenantId,
        shiftId: schema.pallets.shiftId,
        id: schema.pallets.id,
        sscc: schema.pallets.sscc,
        closedAt: schema.pallets.closedAt,
      })
      .from(schema.pallets)
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.shiftId, shiftId)));
    const closedPalletById = new Map(
      palletRows
        .filter(
          (row): row is PalletRow & { sscc: string } =>
            row.tenantId === tenantId && row.shiftId === shiftId && row.sscc !== null,
        )
        .map((row) => [row.id, { sscc: row.sscc, closedAt: row.closedAt }]),
    );

    const groups = new Map<
      string,
      { sscc: string; closedAt: Date | null; boxes: { sscc: string; codes: string[] }[] }
    >();
    const looseBoxes: { sscc: string; codes: string[] }[] = [];

    for (const box of eligibleBoxes) {
      if (box.palletId === null) {
        looseBoxes.push({ sscc: box.sscc, codes: box.codes });
        continue;
      }
      const pallet = closedPalletById.get(box.palletId);
      if (pallet === undefined) {
        looseBoxes.push({ sscc: box.sscc, codes: box.codes });
        continue;
      }
      const existing = groups.get(box.palletId);
      if (existing) {
        existing.boxes.push({ sscc: box.sscc, codes: box.codes });
      } else {
        groups.set(box.palletId, {
          sscc: pallet.sscc,
          closedAt: pallet.closedAt,
          boxes: [{ sscc: box.sscc, codes: box.codes }],
        });
      }
    }

    if (groups.size === 0) {
      throw new ShiftExportSourceError("SHIFT_HAS_NO_PALLETS");
    }

    const pallets: ShiftExportPalletGroup[] = [...groups.values()]
      .sort((left, right) => compareNullableDates(left.closedAt, right.closedAt))
      .map((group) => ({
        sscc: group.sscc,
        boxes: [...group.boxes].sort((left, right) => compareCodeUnits(left.sscc, right.sscc)),
      }));

    return {
      mode: "pallets",
      pallets,
      looseBoxes: looseBoxes.sort((left, right) => compareCodeUnits(left.sscc, right.sscc)),
    };
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

/** Ascending by `closed_at`; a null (should not occur once a group exists) sorts first. */
function compareNullableDates(left: Date | null, right: Date | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left.getTime() - right.getTime();
}
