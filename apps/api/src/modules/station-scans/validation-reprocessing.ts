import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { schema } from "@markiro/db";
import type { ValidationOccurrenceOutcome } from "@markiro/domain";
import type { StationScanTransaction } from "./product-label-events";
import { sameScan, type ConflictRow, type OwnerRow } from "./conflict-resolution";
import type { SyncBatchDto } from "./dto";

type CodedItem = Extract<SyncBatchDto["items"][number], { code: object }>;
type Shift = typeof schema.shifts.$inferSelect;
type Reprocessing = typeof schema.validationCodeReprocessings.$inferInsert;

/** Caller holds tenant registry, sorted shift and hash locks. Reads/writes are bounded by batch size. */
export async function admitValidationOccurrences(
  tx: StationScanTransaction,
  tenantId: string,
  deviceId: string,
  items: CodedItem[],
): Promise<{ outcomes: ValidationOccurrenceOutcome[]; conflicts: ConflictRow[] }> {
  const outcomes: ValidationOccurrenceOutcome[] = [];
  const conflicts: ConflictRow[] = [];
  if (items.length === 0) return { outcomes, conflicts };
  const shifts = await tx
    .select()
    .from(schema.shifts)
    .where(
      and(
        eq(schema.shifts.tenantId, tenantId),
        inArray(schema.shifts.id, [...new Set(items.map((item) => item.shiftId))]),
      ),
    );
  const targetById = new Map(
    shifts
      .filter(
        (shift) => shift.mode === "validation" && shift.validationPrintMode === "duplicate_dm",
      )
      .map((shift) => [shift.id, shift]),
  );
  const candidates = items
    .filter((item) => targetById.has(item.shiftId))
    // Stable sort keeps input-array order for equal instants, including different ISO precision.
    .sort((a, b) => Date.parse(a.scannedAt) - Date.parse(b.scannedAt));
  if (candidates.length === 0) return { outcomes, conflicts };
  const hashes = [...new Set(candidates.map((item) => item.code.codeHash))].sort();
  const originals = await tx
    .select()
    .from(schema.codeRegistry)
    .where(
      and(
        eq(schema.codeRegistry.tenantId, tenantId),
        inArray(schema.codeRegistry.codeHash, hashes),
      ),
    )
    .orderBy(schema.codeRegistry.codeHash)
    .for("update");
  const originalByHash = new Map<string, OwnerRow>(originals.map((row) => [row.codeHash, row]));
  const sources =
    originals.length === 0
      ? []
      : await tx
          .select()
          .from(schema.shifts)
          .where(
            and(
              eq(schema.shifts.tenantId, tenantId),
              inArray(schema.shifts.id, [...new Set(originals.map((row) => row.shiftId))]),
            ),
          )
          .orderBy(schema.shifts.id)
          .for("share");
  const sourceById = new Map<string, Shift>(
    [...shifts, ...sources].map((shift) => [shift.id, shift]),
  );
  const repeatRows = await tx
    .select({ occurrence: schema.validationCodeReprocessings, status: schema.shifts.status })
    .from(schema.validationCodeReprocessings)
    .innerJoin(
      schema.shifts,
      and(
        eq(schema.shifts.tenantId, schema.validationCodeReprocessings.tenantId),
        eq(schema.shifts.id, schema.validationCodeReprocessings.shiftId),
      ),
    )
    .where(
      and(
        eq(schema.validationCodeReprocessings.tenantId, tenantId),
        inArray(schema.validationCodeReprocessings.codeHash, hashes),
        or(
          inArray(schema.validationCodeReprocessings.shiftId, [...targetById.keys()]),
          ne(schema.shifts.status, "closed"),
        ),
      ),
    );
  const key = (shiftId: string, codeHash: string) => `${shiftId}|${codeHash}`;
  const repeatByKey = new Map<string, { occurrence: Reprocessing; status: Shift["status"] }>(
    repeatRows.map((row) => [
      key(row.occurrence.shiftId, row.occurrence.codeHash),
      { occurrence: row.occurrence, status: row.status },
    ]),
  );
  const retainedRows = await tx
    .select()
    .from(schema.validationCodeAcceptances)
    .where(
      and(
        eq(schema.validationCodeAcceptances.tenantId, tenantId),
        inArray(schema.validationCodeAcceptances.shiftId, [...targetById.keys()]),
        inArray(schema.validationCodeAcceptances.codeHash, hashes),
      ),
    );
  const ordinaryByKey = new Map<string, OwnerRow>(
    retainedRows.map((row) => [key(row.shiftId, row.codeHash), row]),
  );
  // A retained acceptance may have subsequently lost to an earlier non-duplicate claim.
  // Exact losing evidence outranks historical acceptance, including after the winning owner is released.
  const displacedRows = await tx
    .select({
      shiftId: schema.validationCodeAcceptances.shiftId,
      codeHash: schema.validationCodeAcceptances.codeHash,
      winningShiftId: schema.codeConflicts.winningShiftId,
      winningTerminalId: schema.codeConflicts.winningTerminalId,
      winningScannedAt: schema.codeConflicts.winningScannedAt,
    })
    .from(schema.validationCodeAcceptances)
    .innerJoin(
      schema.codeConflicts,
      and(
        eq(schema.codeConflicts.tenantId, schema.validationCodeAcceptances.tenantId),
        eq(schema.codeConflicts.codeHash, schema.validationCodeAcceptances.codeHash),
        eq(schema.codeConflicts.losingShiftId, schema.validationCodeAcceptances.shiftId),
        eq(schema.codeConflicts.losingScannedAt, schema.validationCodeAcceptances.scannedAt),
        sql`${schema.codeConflicts.losingTerminalId} IS NOT DISTINCT FROM ${schema.validationCodeAcceptances.terminalId}`,
      ),
    )
    .where(
      and(
        eq(schema.validationCodeAcceptances.tenantId, tenantId),
        inArray(schema.validationCodeAcceptances.shiftId, [...targetById.keys()]),
        inArray(schema.validationCodeAcceptances.codeHash, hashes),
      ),
    );
  const displacedByKey = new Map(
    displacedRows.map((row) => [
      key(row.shiftId, row.codeHash),
      {
        codeHash: row.codeHash,
        shiftId: row.winningShiftId,
        terminalId: row.winningTerminalId,
        scannedAt: row.winningScannedAt,
      },
    ]),
  );
  const ordinaryWrites = new Map<string, OwnerRow>();
  const registryWrites = new Map<string, OwnerRow>();
  const repeatWrites = new Map<string, Reprocessing>();
  for (const item of candidates) {
    const shift = targetById.get(item.shiftId);
    if (!shift) continue;
    const claim = {
      shiftId: item.shiftId,
      terminalId: deviceId,
      codeHash: item.code.codeHash,
      scannedAt: new Date(item.scannedAt),
    };
    const occurrenceKey = key(shift.id, claim.codeHash);
    const previousRepeat = repeatByKey.get(occurrenceKey)?.occurrence;
    const original = originalByHash.get(claim.codeHash);
    const previousOrdinary =
      ordinaryByKey.get(occurrenceKey) ?? (original?.shiftId === shift.id ? original : undefined);
    const active = [...repeatByKey.values()].find(
      (row) =>
        row.occurrence.codeHash === claim.codeHash &&
        row.occurrence.shiftId !== shift.id &&
        row.status !== "closed",
    );
    let outcome: ValidationOccurrenceOutcome["outcome"] = "conflict";
    let winner: OwnerRow | undefined = original;
    if (shift.status !== "planned" && item.boxId === null) {
      // A repeat fact survives a registry release. A replay must never resurrect registry ownership.
      if (previousRepeat && shift.allowPreviouslyAcceptedCodes) {
        winner = previousRepeat;
        if (sameScan(previousRepeat, claim)) outcome = "reprocessed";
        else if (claim.scannedAt < previousRepeat.scannedAt) {
          const occurrence = {
            ...previousRepeat,
            ...claim,
            operatorId: item.operatorId,
            canonicalRaw: item.code.canonicalRaw,
          };
          repeatWrites.set(occurrenceKey, occurrence);
          repeatByKey.set(occurrenceKey, { occurrence, status: shift.status });
          conflicts.push({ codeHash: claim.codeHash, losing: previousRepeat, winning: claim });
          outcome = "reprocessed";
        }
      } else if (previousOrdinary) {
        winner = previousOrdinary;
        const displacement = displacedByKey.get(occurrenceKey);
        if (displacement) winner = original ?? displacement;
        else if (sameScan(previousOrdinary, claim)) outcome = "first_accepted";
        else if (claim.scannedAt < previousOrdinary.scannedAt) {
          // Correct the retained winner without reviving a released or subsequently reassigned owner.
          if (original && sameScan(original, previousOrdinary)) {
            originalByHash.set(claim.codeHash, claim);
            registryWrites.set(claim.codeHash, claim);
          }
          ordinaryByKey.set(occurrenceKey, claim);
          ordinaryWrites.set(occurrenceKey, claim);
          conflicts.push({ codeHash: claim.codeHash, losing: previousOrdinary, winning: claim });
          outcome = "first_accepted";
        }
      } else if (active) {
        // Releasing original ownership does not cancel an active, separately accepted repeat.
        winner = active.occurrence;
      } else if (!original) {
        originalByHash.set(claim.codeHash, claim);
        registryWrites.set(claim.codeHash, claim);
        outcome = "first_accepted";
      } else if (shift.allowPreviouslyAcceptedCodes) {
        const source = sourceById.get(original.shiftId);
        if (source?.status === "closed" && source.productId === shift.productId) {
          const occurrence = {
            tenantId,
            ...claim,
            sourceShiftId: original.shiftId,
            operatorId: item.operatorId,
            canonicalRaw: item.code.canonicalRaw,
          };
          repeatWrites.set(occurrenceKey, occurrence);
          repeatByKey.set(occurrenceKey, { occurrence, status: shift.status });
          outcome = "reprocessed";
        }
      }
    }
    if (outcome === "first_accepted" && !ordinaryByKey.has(occurrenceKey)) {
      ordinaryByKey.set(occurrenceKey, claim);
      ordinaryWrites.set(occurrenceKey, claim);
    }
    if (outcome === "conflict" && winner)
      conflicts.push({ codeHash: claim.codeHash, losing: claim, winning: winner });
    const effectiveOriginal = originalByHash.get(claim.codeHash);
    outcomes.push({
      shiftId: claim.shiftId,
      codeHash: claim.codeHash,
      scannedAt: item.scannedAt,
      outcome,
      ...(outcome === "first_accepted" &&
      (!effectiveOriginal || !sameScan(effectiveOriginal, claim))
        ? { ownership: "released" as const }
        : {}),
    });
  }
  if (ordinaryWrites.size > 0)
    await tx
      .insert(schema.validationCodeAcceptances)
      .values([...ordinaryWrites.values()].map((row) => ({ tenantId, ...row })))
      .onConflictDoUpdate({
        target: [
          schema.validationCodeAcceptances.tenantId,
          schema.validationCodeAcceptances.shiftId,
          schema.validationCodeAcceptances.codeHash,
        ],
        set: { terminalId: sql`excluded.terminal_id`, scannedAt: sql`excluded.scanned_at` },
      });
  if (registryWrites.size > 0)
    await tx
      .insert(schema.codeRegistry)
      .values([...registryWrites.values()].map((row) => ({ tenantId, ...row })))
      .onConflictDoUpdate({
        target: [schema.codeRegistry.tenantId, schema.codeRegistry.codeHash],
        set: {
          terminalId: sql`excluded.terminal_id`,
          scannedAt: sql`excluded.scanned_at`,
          updatedAt: sql`now()`,
        },
      });
  if (repeatWrites.size > 0)
    await tx
      .insert(schema.validationCodeReprocessings)
      .values([...repeatWrites.values()])
      .onConflictDoUpdate({
        target: [
          schema.validationCodeReprocessings.tenantId,
          schema.validationCodeReprocessings.shiftId,
          schema.validationCodeReprocessings.codeHash,
        ],
        set: {
          terminalId: sql`excluded.terminal_id`,
          scannedAt: sql`excluded.scanned_at`,
          operatorId: sql`excluded.operator_id`,
          canonicalRaw: sql`excluded.canonical_raw`,
        },
      });
  // An existing winner may itself be displaced later in this batch. Publish the final
  // occurrence identity in every conflict, including claims blocked in another shift.
  for (const conflict of conflicts) {
    const finalWinner =
      repeatByKey.get(key(conflict.winning.shiftId, conflict.codeHash))?.occurrence ??
      ordinaryByKey.get(key(conflict.winning.shiftId, conflict.codeHash)) ??
      originalByHash.get(conflict.codeHash);
    if (finalWinner && finalWinner.shiftId === conflict.winning.shiftId)
      conflict.winning = finalWinner;
  }
  return { outcomes, conflicts };
}
