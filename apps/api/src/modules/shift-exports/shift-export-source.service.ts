import { Inject, Injectable } from "@nestjs/common";
import { formatShiftNumber } from "@markiro/domain";
import type {
  ShiftExportFormatDescriptor,
  ShiftExportPalletGroup,
  ShiftExportSource,
} from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DB } from "../../auth/auth.module";

export type ShiftExportSourceErrorCode =
  | "SHIFT_NOT_CLOSED"
  | "SHIFT_HAS_NO_CODES"
  | "SHIFT_DATE_MISSING"
  | "BOX_COVERAGE_INCOMPLETE"
  | "SHIFT_HAS_NO_PALLETS"
  | "PALLET_NOT_CLOSED"
  | "PALLET_DISASSEMBLED"
  | "ORG_INN_MISSING"
  | "ORG_NAME_MISSING";

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
  /** The shift's human number (`SEP26-003`), used as the GISMT `document_number`. */
  shiftNumber: string;
  /**
   * When the shift closed -- the instant the GISMT document reports as
   * `operation_date_time`. Falls back to the snapshot instant for the
   * anomalous closed shift whose `closed_at` was never written, so a factory
   * export is never blocked by a missing audit timestamp.
   */
  shiftClosedAt: Date;
  /** Tenant's ИНН; loaded only for formats that embed it (GISMT XML). */
  organizationInn: string | null;
  /** Tenant's full name (`org_name`); loaded only for the GISMT XML formats. */
  organizationName: string | null;
  /**
   * Eligible boxes rendered LOOSE only because the pallet they closed onto has
   * not itself closed yet (no SSCC to name it with) -- always 0 outside
   * pallets mode. This is a real, silent gap in the rendered document (see
   * `toPalletsSource`): the box's pallet-aggregation obligation is not yet
   * discharged, and the factory must re-export once that pallet closes. Never
   * counts a box that stands on no pallet at all, nor one whose `palletId`
   * fails to resolve for any other reason (wrong tenant/shift, vanished row) --
   * both stay ordinary, unremarkable loose boxes.
   */
  openPalletSuppressedBoxCount: number;
  source: ShiftExportSource;
}

/** One closed, non-disassembled pallet and the box SSCCs it carries. */
export interface PalletExportSnapshot {
  sourceSnapshotStartedAt: Date;
  productName: string;
  /** Civil date the pallet closed (UTC), YYYY-MM-DD. */
  closedDate: string;
  /** The instant the pallet closed -- the GISMT `operation_date_time`. */
  closedAt: Date;
  organizationInn: string | null;
  /** Tenant's full name (`org_name`). */
  organizationName: string | null;
  pallet: { sscc: string; boxSsccs: readonly string[] };
}

type ShiftExportSourceFormat = Pick<ShiftExportFormatDescriptor, "boxMode" | "extension">;

/** The product of a PRODUCTION pallet, reached through its shift. */
const shiftProducts = alias(schema.products, "shift_products");

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

  /**
   * A per-pallet aggregation source. Both pallet kinds resolve here: a
   * warehouse pallet carries its own `product_id` and no shift, a production
   * pallet reaches its product through its shift, and both name their member
   * boxes through `boxes.pallet_id`.
   */
  loadPallet(tenantId: string, palletId: string): Promise<PalletExportSnapshot> {
    return this.db.transaction(
      async (tx) => {
        const [pallet] = await tx
          .select({
            sscc: schema.pallets.sscc,
            closedAt: schema.pallets.closedAt,
            disassembledAt: schema.pallets.disassembledAt,
            productName: sql<
              string | null
            >`coalesce(${schema.products.name}, ${shiftProducts.name})`,
          })
          .from(schema.pallets)
          .leftJoin(
            schema.products,
            and(
              eq(schema.products.tenantId, schema.pallets.tenantId),
              eq(schema.products.id, schema.pallets.productId),
            ),
          )
          .leftJoin(
            schema.shifts,
            and(
              eq(schema.shifts.tenantId, schema.pallets.tenantId),
              eq(schema.shifts.id, schema.pallets.shiftId),
            ),
          )
          .leftJoin(
            shiftProducts,
            and(
              eq(shiftProducts.tenantId, schema.shifts.tenantId),
              eq(shiftProducts.id, schema.shifts.productId),
            ),
          )
          .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.id, palletId)))
          .limit(1);
        // A pallet that vanished, never closed or has no SSCC to name itself
        // with is the same terminal answer for this export: there is no
        // aggregate to submit.
        if (!pallet || pallet.sscc === null || pallet.closedAt === null) {
          throw new ShiftExportSourceError("PALLET_NOT_CLOSED");
        }
        if (pallet.disassembledAt !== null) {
          throw new ShiftExportSourceError("PALLET_DISASSEMBLED");
        }

        const boxes = await tx
          .select({ sscc: schema.boxes.sscc })
          .from(schema.boxes)
          .where(
            and(
              eq(schema.boxes.tenantId, tenantId),
              eq(schema.boxes.palletId, palletId),
              isNotNull(schema.boxes.closedAt),
              isNull(schema.boxes.disassembledAt),
            ),
          )
          .orderBy(asc(schema.boxes.closedAt), asc(schema.boxes.id));

        const organization = await this.loadOrganization(tx, tenantId);

        return {
          sourceSnapshotStartedAt: new Date(),
          productName: pallet.productName ?? "Продукция",
          closedDate: pallet.closedAt.toISOString().slice(0, 10),
          closedAt: pallet.closedAt,
          organizationInn: organization.inn,
          organizationName: organization.name,
          pallet: {
            sscc: pallet.sscc,
            boxSsccs: boxes.flatMap((box) => (box.sscc === null ? [] : [box.sscc])),
          },
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * The participant's identity as the GISMT XML needs it: the trimmed ИНН for
   * `LP_TIN` and the organisation's full name for `org_name`. Both are
   * returned as null when blank so the domain renderer produces the precise
   * `ORG_INN_MISSING` / `ORG_NAME_MISSING` error instead of writing an empty
   * attribute the XSD rejects.
   */
  private async loadOrganization(
    tx: ShiftExportTransaction,
    tenantId: string,
  ): Promise<{ inn: string | null; name: string | null }> {
    const [row] = await tx
      .select({ name: schema.organization.name, inn: schema.orgProfiles.inn })
      .from(schema.organization)
      .leftJoin(schema.orgProfiles, eq(schema.orgProfiles.tenantId, schema.organization.id))
      .where(eq(schema.organization.id, tenantId))
      .limit(1);
    return { inn: row?.inn?.trim() || null, name: row?.name?.trim() || null };
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
        numberMonthKey: schema.shifts.numberMonthKey,
        numberSeq: schema.shifts.numberSeq,
        createdFrom: schema.shifts.createdFrom,
        closedAt: schema.shifts.closedAt,
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
    let organizationName: string | null = null;
    if (format.extension === "xml") {
      const organization = await this.loadOrganization(tx, tenantId);
      organizationInn = organization.inn;
      organizationName = organization.name;
      if (organizationInn === null) {
        throw new ShiftExportSourceError("ORG_INN_MISSING");
      }
      if (organizationName === null) {
        throw new ShiftExportSourceError("ORG_NAME_MISSING");
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

    if (format.boxMode === "flat") {
      const repeated = await tx
        .select({
          tenantId: schema.validationCodeReprocessings.tenantId,
          shiftId: schema.validationCodeReprocessings.shiftId,
          codeHash: schema.validationCodeReprocessings.codeHash,
          scannedAt: schema.validationCodeReprocessings.scannedAt,
          canonicalRaw: schema.validationCodeReprocessings.canonicalRaw,
        })
        .from(schema.validationCodeReprocessings)
        .where(
          and(
            eq(schema.validationCodeReprocessings.tenantId, tenantId),
            eq(schema.validationCodeReprocessings.shiftId, shiftId),
          ),
        );
      const hashes = new Set(authoritativeRows.map((row) => row.codeHash));
      authoritativeRows.push(...repeated.filter((row) => !hashes.has(row.codeHash)));
    }
    const authoritative = authoritativeRows
      .filter((row) => row.tenantId === tenantId && row.shiftId === shiftId)
      .sort(compareAuthoritativeCodes);
    if (authoritative.length === 0) {
      throw new ShiftExportSourceError("SHIFT_HAS_NO_CODES");
    }

    let source: ShiftExportSource;
    let openPalletSuppressedBoxCount = 0;
    if (format.boxMode === "flat") {
      source = { mode: "flat", codes: authoritative.map((row) => row.canonicalRaw) };
    } else {
      const eligibleBoxes = await this.loadEligibleBoxes(tx, tenantId, shiftId, authoritative);
      if (format.boxMode === "boxes") {
        source = this.toBoxesSource(eligibleBoxes);
      } else {
        const pallets = await this.toPalletsSource(tx, tenantId, shiftId, eligibleBoxes);
        source = pallets.source;
        openPalletSuppressedBoxCount = pallets.openPalletSuppressedBoxCount;
      }
    }

    return {
      sourceSnapshotStartedAt,
      productName: shift.productName ?? "Продукция",
      shiftDate,
      shiftNumber: formatShiftNumber({
        monthKey: shift.numberMonthKey,
        seq: shift.numberSeq,
        createdFrom: shift.createdFrom,
      }),
      shiftClosedAt: shift.closedAt ?? sourceSnapshotStartedAt,
      organizationInn,
      organizationName,
      openPalletSuppressedBoxCount,
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
   * that pallet's group (ordered by the PALLET's own `closed_at`, tiebroken by
   * the pallet's own SSCC so two pallets sharing one timestamp -- a legitimate
   * offline batch-close artifact -- still render in the SAME order on every
   * run, regardless of the arrival order of an unordered SQL join); a box with
   * no pallet, or whose pallet has not itself closed (no `sscc` to name yet),
   * is rendered loose, after every pallet. A shift can close before every
   * pallet does (`closeShift` does not gate on it), so a still-open pallet is
   * treated the same as no pallet at all rather than surfacing a document
   * that names a pallet with nothing to call it -- but that box is counted in
   * `openPalletSuppressedBoxCount` (see `ShiftExportSnapshot`) so the omission
   * is not silent.
   */
  private async toPalletsSource(
    tx: ShiftExportTransaction,
    tenantId: string,
    shiftId: string,
    eligibleBoxes: readonly EligibleBox[],
  ): Promise<{ source: ShiftExportSource; openPalletSuppressedBoxCount: number }> {
    const rawPalletRows = await tx
      .select({
        tenantId: schema.pallets.tenantId,
        shiftId: schema.pallets.shiftId,
        id: schema.pallets.id,
        sscc: schema.pallets.sscc,
        closedAt: schema.pallets.closedAt,
      })
      .from(schema.pallets)
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.shiftId, shiftId)));
    // `eq(schema.pallets.shiftId, shiftId)` above only matches rows whose
    // (non-null) shiftId equals the caller's own `shiftId` param, so a null
    // here is unreachable -- this source only ever renders production
    // pallets for one shift's export.
    const palletRows: PalletRow[] = rawPalletRows.map((row) => {
      if (row.shiftId === null) throw new Error("Pallet row for a shift export has no shift");
      return { ...row, shiftId: row.shiftId };
    });
    const tenantPalletRows = palletRows.filter(
      (row) => row.tenantId === tenantId && row.shiftId === shiftId,
    );
    /** Every pallet this shift knows about, closed or not -- used only to tell "still open" apart from "does not resolve at all". */
    const palletById = new Map(tenantPalletRows.map((row) => [row.id, row]));
    const closedPalletById = new Map(
      tenantPalletRows
        .filter((row): row is PalletRow & { sscc: string } => row.sscc !== null)
        .map((row) => [row.id, { sscc: row.sscc, closedAt: row.closedAt }]),
    );

    const groups = new Map<
      string,
      { sscc: string; closedAt: Date | null; boxes: { sscc: string; codes: string[] }[] }
    >();
    const looseBoxes: { sscc: string; codes: string[] }[] = [];
    let openPalletSuppressedBoxCount = 0;

    for (const box of eligibleBoxes) {
      if (box.palletId === null) {
        looseBoxes.push({ sscc: box.sscc, codes: box.codes });
        continue;
      }
      const pallet = closedPalletById.get(box.palletId);
      if (pallet === undefined) {
        if (palletById.get(box.palletId)?.sscc === null) {
          openPalletSuppressedBoxCount += 1;
        }
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
      // Fires whenever every eligible box ends up loose -- which covers TWO
      // distinct shift histories: no box in this shift ever stood on a
      // pallet, OR pallets were used but NONE of them has closed yet (so
      // there is no pallet SSCC available to aggregate onto). Both mean the
      // same thing for this export: no pallet-level aggregate exists yet to
      // submit. Do not read this code as "this shift never used pallets".
      throw new ShiftExportSourceError("SHIFT_HAS_NO_PALLETS");
    }

    const pallets: ShiftExportPalletGroup[] = [...groups.values()]
      .sort(
        (left, right) =>
          compareNullableDates(left.closedAt, right.closedAt) ||
          compareCodeUnits(left.sscc, right.sscc),
      )
      .map((group) => ({
        sscc: group.sscc,
        boxes: [...group.boxes].sort((left, right) => compareCodeUnits(left.sscc, right.sscc)),
      }));

    return {
      source: {
        mode: "pallets",
        pallets,
        looseBoxes: looseBoxes.sort((left, right) => compareCodeUnits(left.sscc, right.sscc)),
      },
      openPalletSuppressedBoxCount,
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
