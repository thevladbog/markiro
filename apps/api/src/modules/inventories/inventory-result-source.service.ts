import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";
import { canonicalizeKm, type InventoryChzStatus } from "@markiro/domain";

import { DB } from "../../auth/auth.module";

export type InventoryResultSourceErrorCode = "INVENTORY_RESULT_NOT_CLOSED";

export class InventoryResultSourceError extends Error {
  constructor(readonly code: InventoryResultSourceErrorCode) {
    super(code);
    this.name = "InventoryResultSourceError";
  }
}

export interface InventoryResultWinner {
  terminalId: string;
  scannedAt: string;
}

export interface InventoryResultCode {
  codeHash: string;
  canonicalRaw: string;
  gtin14: string;
  serial: string;
  sourceStatus: InventoryChzStatus | null;
  sourceState: string | null;
  sourceProductionDate: string | null;
  parentSscc: string | null;
  observedProductionDate: string | null;
  classification: "expected" | "protected" | "ineligible" | "unknown" | "voided";
  found: boolean;
  winner: InventoryResultWinner | null;
}

export interface InventoryResultOldBox {
  sscc: string;
  winner: InventoryResultWinner;
}

export interface InventoryResultNewBox {
  sscc: string;
  oldSsccContext: string | null;
  productionDate: string;
  state: "open" | "closed" | "invalidated";
  printState: "not_ready" | "pending" | "printing" | "printed" | "failed";
  codeHashes: string[];
}

export interface InventoryObservedDateGroup {
  observedProductionDate: string;
  codeHashes: string[];
}

export interface InventoryResultOperation {
  gtin14: string;
  productName: string;
  lineName: string;
  mode: "check" | "repack";
  productionDateFrom: string;
  productionDateTo: string;
  startedAt: string;
  closedAt: string;
  emergencyCloseReason: string | null;
  snapshotRevision: number;
  snapshotFixedAt: string;
  statusCounts: Record<InventoryChzStatus, number>;
}

export interface InventoryResultSource {
  inventoryId: string;
  snapshotId: string;
  resultRevision: number;
  sourceSnapshotStartedAt: string;
  operation: InventoryResultOperation;
  expected: InventoryResultCode[];
  verified: InventoryResultCode[];
  writeOffCandidates: InventoryResultCode[];
  protected: InventoryResultCode[];
  ineligible: InventoryResultCode[];
  unknown: InventoryResultCode[];
  oldBoxes: InventoryResultOldBox[];
  newBoxes: InventoryResultNewBox[];
  observedDateGroups: InventoryObservedDateGroup[];
}

type ResultSourceTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface SnapshotCodeRow {
  codeHash: string;
  canonicalRaw: string;
  gtin14: string;
  serial: string;
  sourceStatus: InventoryChzStatus;
  sourceState: string | null;
  sourceProductionDate: string | null;
  parentSscc: string | null;
  expected: boolean;
  protected: boolean;
  resultId: string | null;
  observedProductionDate: string | null;
  classification: "expected" | "protected" | "ineligible" | "unknown" | "voided" | null;
  terminalId: string | null;
  winningScannedAt: Date | null;
}

@Injectable()
export class InventoryResultSourceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  load(tenantId: string, inventoryId: string): Promise<InventoryResultSource> {
    return this.db.transaction(async (tx) => this.loadFromTransaction(tx, tenantId, inventoryId), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  }

  private async loadFromTransaction(
    tx: ResultSourceTransaction,
    tenantId: string,
    inventoryId: string,
  ): Promise<InventoryResultSource> {
    const timestamp = await tx.execute(
      sql<{ sourceSnapshotStartedAt: Date | string }>`
        select transaction_timestamp() as "sourceSnapshotStartedAt"
      `,
    );
    const timestampRow = timestamp.rows[0];
    const rawTimestamp =
      typeof timestampRow === "object" && timestampRow !== null
        ? Reflect.get(timestampRow, "sourceSnapshotStartedAt")
        : undefined;
    const sourceSnapshotStartedAt = asIsoTimestamp(
      rawTimestamp,
      "Inventory result source timestamp is unavailable",
    );
    const [inventory] = await tx
      .select({
        id: schema.inventories.id,
        status: schema.inventories.status,
        snapshotId: schema.inventories.activeSnapshotId,
        resultRevision: schema.inventories.resultRevision,
        gtin14: schema.inventories.gtin14Snapshot,
        mode: schema.inventories.mode,
        productionDateFrom: schema.inventories.productionDateFrom,
        productionDateTo: schema.inventories.productionDateTo,
        startedAt: schema.inventories.startedAt,
        closedAt: schema.inventories.closedAt,
        emergencyCloseReason: schema.inventories.emergencyCloseReason,
      })
      .from(schema.inventories)
      .where(and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)))
      .limit(1);
    if (inventory?.status !== "closed" || inventory.snapshotId === null) {
      throw new InventoryResultSourceError("INVENTORY_RESULT_NOT_CLOSED");
    }
    const [snapshot] = await tx
      .select({
        revision: schema.inventorySnapshots.revision,
        productName: schema.inventorySnapshots.productName,
        lineName: schema.inventorySnapshots.lineName,
        fixedAt: schema.inventorySnapshots.fixedAt,
        emittedCount: schema.inventorySnapshots.emittedCount,
        introducedCount: schema.inventorySnapshots.introducedCount,
        appliedCount: schema.inventorySnapshots.appliedCount,
        retiredCount: schema.inventorySnapshots.retiredCount,
        writtenOffCount: schema.inventorySnapshots.writtenOffCount,
        disaggregationCount: schema.inventorySnapshots.disaggregationCount,
      })
      .from(schema.inventorySnapshots)
      .where(
        and(
          eq(schema.inventorySnapshots.tenantId, tenantId),
          eq(schema.inventorySnapshots.id, inventory.snapshotId),
          eq(schema.inventorySnapshots.inventoryId, inventoryId),
        ),
      )
      .limit(1);
    if (!snapshot) throw new Error("Inventory result snapshot metadata is unavailable");

    const snapshotRows: SnapshotCodeRow[] = await tx
      .select({
        codeHash: schema.inventorySnapshotCodes.codeHash,
        canonicalRaw: schema.inventorySnapshotCodes.canonicalRaw,
        gtin14: schema.inventorySnapshotCodes.gtin14,
        serial: schema.inventorySnapshotCodes.serial,
        sourceStatus: schema.inventorySnapshotCodes.sourceStatus,
        sourceState: schema.inventorySnapshotCodes.sourceState,
        sourceProductionDate: schema.inventorySnapshotCodes.sourceProductionDate,
        parentSscc: schema.inventorySnapshotCodes.parentSscc,
        expected: schema.inventorySnapshotCodes.expected,
        protected: schema.inventorySnapshotCodes.protected,
        resultId: schema.inventoryCodeResults.id,
        observedProductionDate: schema.inventoryCodeResults.observedProductionDate,
        classification: schema.inventoryCodeResults.classification,
        terminalId: schema.inventoryCodeResults.winningDeviceId,
        winningScannedAt: schema.inventoryCodeResults.winningScannedAt,
      })
      .from(schema.inventorySnapshotCodes)
      .leftJoin(
        schema.inventoryCodeResults,
        and(
          eq(schema.inventoryCodeResults.tenantId, schema.inventorySnapshotCodes.tenantId),
          eq(schema.inventoryCodeResults.inventoryId, inventoryId),
          eq(schema.inventoryCodeResults.snapshotId, schema.inventorySnapshotCodes.snapshotId),
          eq(schema.inventoryCodeResults.codeHash, schema.inventorySnapshotCodes.codeHash),
        ),
      )
      .where(
        and(
          eq(schema.inventorySnapshotCodes.tenantId, tenantId),
          eq(schema.inventorySnapshotCodes.snapshotId, inventory.snapshotId),
        ),
      )
      .orderBy(
        asc(schema.inventorySnapshotCodes.parentSscc),
        asc(schema.inventorySnapshotCodes.codeHash),
      );

    const expected = snapshotRows
      .filter((row) => row.expected)
      .map((row) => resultCode(row, "expected"));
    const verified = expected.filter((row) => row.found && row.classification === "expected");
    const writeOffCandidates = snapshotRows
      .filter((row) => row.expected && row.resultId === null)
      .map((row) => resultCode(row, "expected"));
    const protectedCodes = snapshotRows
      .filter((row) => row.protected)
      .map((row) => resultCode(row, "protected"));
    const ineligible = snapshotRows
      .filter((row) => !row.expected && !row.protected && row.resultId !== null)
      .map((row) => resultCode(row, "ineligible"));

    const unknownRows = await tx
      .select({
        codeHash: schema.inventoryCodeResults.codeHash,
        canonicalRaw: schema.inventoryScanEvents.rawPayload,
        observedProductionDate: schema.inventoryCodeResults.observedProductionDate,
        classification: schema.inventoryCodeResults.classification,
        terminalId: schema.inventoryCodeResults.winningDeviceId,
        winningScannedAt: schema.inventoryCodeResults.winningScannedAt,
      })
      .from(schema.inventoryCodeResults)
      .innerJoin(
        schema.inventoryScanEvents,
        and(
          eq(schema.inventoryScanEvents.tenantId, schema.inventoryCodeResults.tenantId),
          eq(schema.inventoryScanEvents.inventoryId, schema.inventoryCodeResults.inventoryId),
          eq(schema.inventoryScanEvents.eventId, schema.inventoryCodeResults.firstAcceptedEventId),
        ),
      )
      .where(
        and(
          eq(schema.inventoryCodeResults.tenantId, tenantId),
          eq(schema.inventoryCodeResults.inventoryId, inventoryId),
          isNull(schema.inventoryCodeResults.snapshotId),
        ),
      )
      .orderBy(asc(schema.inventoryCodeResults.codeHash));
    const unknown: InventoryResultCode[] = unknownRows.map(unknownResultCode);

    const oldBoxes = await this.loadOldBoxes(tx, tenantId, inventoryId);
    const newBoxes = await this.loadNewBoxes(tx, tenantId, inventoryId);
    const observedDateGroups = groupByObservedDate([
      ...verified,
      ...protectedCodes.filter((row) => row.found),
      ...ineligible.filter((row) => row.found),
      ...unknown.filter((row) => row.found),
    ]);

    return {
      inventoryId,
      snapshotId: inventory.snapshotId,
      resultRevision: inventory.resultRevision,
      sourceSnapshotStartedAt,
      operation: {
        gtin14: inventory.gtin14,
        productName: snapshot.productName,
        lineName: snapshot.lineName,
        mode: inventory.mode,
        productionDateFrom: inventory.productionDateFrom,
        productionDateTo: inventory.productionDateTo,
        startedAt: asIsoTimestamp(
          inventory.startedAt,
          "Inventory result start timestamp is unavailable",
        ),
        closedAt: asIsoTimestamp(
          inventory.closedAt,
          "Inventory result close timestamp is unavailable",
        ),
        emergencyCloseReason: inventory.emergencyCloseReason,
        snapshotRevision: snapshot.revision,
        snapshotFixedAt: snapshot.fixedAt.toISOString(),
        statusCounts: {
          EMITTED: snapshot.emittedCount,
          INTRODUCED: snapshot.introducedCount,
          APPLIED: snapshot.appliedCount,
          RETIRED: snapshot.retiredCount,
          WRITTEN_OFF: snapshot.writtenOffCount,
          DISAGGREGATION: snapshot.disaggregationCount,
        },
      },
      expected,
      verified,
      writeOffCandidates,
      protected: protectedCodes,
      ineligible,
      unknown,
      oldBoxes,
      newBoxes,
      observedDateGroups,
    };
  }

  private async loadOldBoxes(
    tx: ResultSourceTransaction,
    tenantId: string,
    inventoryId: string,
  ): Promise<InventoryResultOldBox[]> {
    const rows = await tx
      .select({
        normalizedIdentity: schema.inventoryScanEvents.normalizedIdentity,
        terminalId: schema.inventoryScanEvents.deviceId,
        winningScannedAt: schema.inventoryScanEvents.scannedAt,
        eventId: schema.inventoryScanEvents.eventId,
      })
      .from(schema.inventoryScanEvents)
      .where(
        and(
          eq(schema.inventoryScanEvents.tenantId, tenantId),
          eq(schema.inventoryScanEvents.inventoryId, inventoryId),
          eq(schema.inventoryScanEvents.kind, "old_box"),
          eq(schema.inventoryScanEvents.authoritativeVerdict, "applied"),
        ),
      )
      .orderBy(
        asc(schema.inventoryScanEvents.normalizedIdentity),
        asc(schema.inventoryScanEvents.scannedAt),
        asc(schema.inventoryScanEvents.deviceId),
        asc(schema.inventoryScanEvents.eventId),
      );
    const bySscc = new Map<string, InventoryResultOldBox>();
    for (const row of rows) {
      const prefix = "old_box:";
      if (!row.normalizedIdentity.startsWith(prefix)) continue;
      const sscc = row.normalizedIdentity.slice(prefix.length);
      if (!bySscc.has(sscc)) {
        bySscc.set(sscc, {
          sscc,
          winner: {
            terminalId: row.terminalId,
            scannedAt: row.winningScannedAt.toISOString(),
          },
        });
      }
    }
    return [...bySscc.values()];
  }

  private async loadNewBoxes(
    tx: ResultSourceTransaction,
    tenantId: string,
    inventoryId: string,
  ): Promise<InventoryResultNewBox[]> {
    const rows = await tx
      .select({
        boxId: schema.inventoryRepackBoxes.id,
        sscc: schema.inventoryRepackBoxes.newSscc,
        oldSsccContext: schema.inventoryRepackBoxes.oldSsccContext,
        productionDate: schema.inventoryRepackBoxes.productionDate,
        state: schema.inventoryRepackBoxes.state,
        printState: schema.inventoryRepackBoxes.printState,
        codeHash: schema.inventoryCodeResults.codeHash,
      })
      .from(schema.inventoryRepackBoxes)
      .leftJoin(
        schema.inventoryRepackItems,
        and(
          eq(schema.inventoryRepackItems.tenantId, schema.inventoryRepackBoxes.tenantId),
          eq(schema.inventoryRepackItems.inventoryId, schema.inventoryRepackBoxes.inventoryId),
          eq(schema.inventoryRepackItems.boxId, schema.inventoryRepackBoxes.id),
          isNull(schema.inventoryRepackItems.removedAt),
        ),
      )
      .leftJoin(
        schema.inventoryCodeResults,
        and(
          eq(schema.inventoryCodeResults.tenantId, schema.inventoryRepackItems.tenantId),
          eq(schema.inventoryCodeResults.inventoryId, schema.inventoryRepackItems.inventoryId),
          eq(schema.inventoryCodeResults.id, schema.inventoryRepackItems.resultId),
        ),
      )
      .where(
        and(
          eq(schema.inventoryRepackBoxes.tenantId, tenantId),
          eq(schema.inventoryRepackBoxes.inventoryId, inventoryId),
        ),
      )
      .orderBy(asc(schema.inventoryRepackBoxes.newSscc), asc(schema.inventoryCodeResults.codeHash));
    const boxes = new Map<string, InventoryResultNewBox>();
    for (const row of rows) {
      const current = boxes.get(row.boxId);
      if (current) {
        if (row.codeHash !== null) current.codeHashes.push(row.codeHash);
      } else {
        boxes.set(row.boxId, {
          sscc: row.sscc,
          oldSsccContext: row.oldSsccContext,
          productionDate: row.productionDate,
          state: row.state,
          printState: row.printState,
          codeHashes: row.codeHash === null ? [] : [row.codeHash],
        });
      }
    }
    return [...boxes.values()];
  }
}

function resultCode(
  row: SnapshotCodeRow,
  fallback: "expected" | "protected" | "ineligible",
): InventoryResultCode {
  return {
    codeHash: row.codeHash,
    canonicalRaw: row.canonicalRaw,
    gtin14: row.gtin14,
    serial: row.serial,
    sourceStatus: row.sourceStatus,
    sourceState: row.sourceState,
    sourceProductionDate: row.sourceProductionDate,
    parentSscc: row.parentSscc,
    observedProductionDate: row.observedProductionDate,
    classification: row.classification ?? fallback,
    found: row.resultId !== null && row.classification !== "voided",
    winner: winner(row),
  };
}

function unknownResultCode(row: {
  codeHash: string;
  canonicalRaw: string | null;
  observedProductionDate: string | null;
  classification: "expected" | "protected" | "ineligible" | "unknown" | "voided";
  terminalId: string;
  winningScannedAt: Date;
}): InventoryResultCode {
  if (row.canonicalRaw === null) {
    throw new Error("Inventory unknown result canonical identity is unavailable");
  }
  let canonical;
  try {
    canonical = canonicalizeKm(row.canonicalRaw);
  } catch {
    throw new Error("Inventory unknown result canonical identity is invalid");
  }
  return {
    codeHash: row.codeHash,
    canonicalRaw: canonical.raw,
    gtin14: canonical.gtin14,
    serial: canonical.serial,
    sourceStatus: null,
    sourceState: null,
    sourceProductionDate: null,
    parentSscc: null,
    observedProductionDate: row.observedProductionDate,
    classification: row.classification,
    found: row.classification !== "voided",
    winner: winner(row),
  };
}

function winner(row: {
  terminalId: string | null;
  winningScannedAt: Date | null;
}): InventoryResultWinner | null {
  return row.terminalId !== null && row.winningScannedAt !== null
    ? {
        terminalId: row.terminalId,
        scannedAt: row.winningScannedAt.toISOString(),
      }
    : null;
}

function groupByObservedDate(codes: readonly InventoryResultCode[]): InventoryObservedDateGroup[] {
  const groups = new Map<string, InventoryResultCode[]>();
  for (const code of codes) {
    if (code.observedProductionDate === null) continue;
    const rows = groups.get(code.observedProductionDate);
    if (rows) rows.push(code);
    else groups.set(code.observedProductionDate, [code]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareUnits(left, right))
    .map(([observedProductionDate, rows]) => ({
      observedProductionDate,
      codeHashes: [...rows].sort(compareResultCodes).map((row) => row.codeHash),
    }));
}

function compareResultCodes(left: InventoryResultCode, right: InventoryResultCode): number {
  return (
    compareUnits(left.parentSscc ?? "", right.parentSscc ?? "") ||
    compareUnits(left.codeHash, right.codeHash)
  );
}

function compareUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asIsoTimestamp(value: unknown, message: string): string {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) throw new Error(message);
  return parsed.toISOString();
}
