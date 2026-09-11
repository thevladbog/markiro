import { ConflictException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

/**
 * The ingest transaction handle. Loosely derived from `Db["transaction"]`'s own
 * callback argument, same as `StationScanTransaction` in product-label-events.ts
 * and `SsccService.recordConsumedSerial`'s `executor`: a `PgTransaction` does
 * not structurally satisfy the full `Db` type (it has no `$client`), so a
 * parameter typed as plain `Db` would reject every call site.
 */
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One pallet closing on the device. `palletId` is the DEVICE-local id. */
export interface PalletClosureDto {
  palletId: string;
  shiftId: string;
  /** Informational wire field; the caller always substitutes the authenticated device id. */
  terminalId: string | null;
  sscc: string;
  closedAt: string;
  operatorId: string | null;
  printVerifiedAt: string | null;
  printSkippedAt: string | null;
}

/** One operator exception fact against a closed pallet. */
export interface PalletExceptionDto {
  kind: "disassemble" | "reprint";
  palletId: string;
  shiftId: string;
  /** Informational wire field; the caller always substitutes the authenticated device id. */
  terminalId: string | null;
  operatorId: string | null;
  reason: string;
  occurredAt: string;
}

/**
 * A pallet's identity as the device reports it. Matches
 * `pallets_device_pallet_uq` exactly: the device-local string alone is not
 * unique (two terminals both calling a pallet "p1", or one device reusing
 * "p1" after a shift change), so every lookup carries all three parts.
 *
 * `|` is the separator, the same one `boxKey` in station-scans.service.ts
 * already uses for the identical job. The key is injective even though
 * `devicePalletId` may legally contain a `|`: `shiftId` is a uuid and
 * `terminalId` is the authenticated device's uuid (or empty for a device with
 * no notion of "terminal"), so neither of the first two components can contain
 * the separator, and the third is last.
 */
export type PalletKey = string;

export function palletKey(
  shiftId: string,
  terminalId: string | null,
  devicePalletId: string,
): PalletKey {
  return `${shiftId}|${terminalId ?? ""}|${devicePalletId}`;
}

export interface PalletRef {
  shiftId: string;
  terminalId: string | null;
  devicePalletId: string;
}

/**
 * Creates every pallet the batch names and returns their server ids.
 *
 * A pre-pass, run before the box-closure loop, so a box's membership and its
 * closure are ONE statement: the closure UPDATE reads this map rather than
 * doing its own round trip per box.
 *
 * Sorted by the full key -- the same 40P01 reasoning the item upsert and the
 * box-closure loop already use: two overlapping batches touching the same
 * pallets must acquire them in the same order. Sorting by `devicePalletId`
 * alone would not be a TOTAL order (two shifts can each have a "p1"), leaving
 * the relative order of the tied rows up to array order.
 *
 * `ON CONFLICT DO NOTHING` rather than `DO UPDATE`: creating a pallet carries
 * no information beyond its identity. Everything else about it arrives with
 * its closure.
 */
export async function upsertPallets(
  tx: Transaction,
  tenantId: string,
  refs: readonly PalletRef[],
): Promise<Map<PalletKey, string>> {
  const unique = new Map<PalletKey, PalletRef>();
  for (const ref of refs) {
    unique.set(palletKey(ref.shiftId, ref.terminalId, ref.devicePalletId), ref);
  }
  if (unique.size === 0) return new Map();

  const ordered = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  await tx
    .insert(schema.pallets)
    .values(
      ordered.map(([, ref]) => ({
        tenantId,
        shiftId: ref.shiftId,
        terminalId: ref.terminalId,
        devicePalletId: ref.devicePalletId,
      })),
    )
    .onConflictDoNothing({
      target: [
        schema.pallets.tenantId,
        schema.pallets.shiftId,
        schema.pallets.terminalId,
        schema.pallets.devicePalletId,
      ],
    });

  // A fresh SELECT rather than the insert's `.returning()`, for the same
  // reason the box upsert re-reads: a pallet already opened by an earlier
  // batch -- the ordinary case for every box after a pallet's first -- is
  // exactly the row ON CONFLICT DO NOTHING leaves untouched, and
  // `.returning()` never reports it.
  const rows = await tx
    .select({
      id: schema.pallets.id,
      shiftId: schema.pallets.shiftId,
      terminalId: schema.pallets.terminalId,
      devicePalletId: schema.pallets.devicePalletId,
    })
    .from(schema.pallets)
    .where(
      and(
        eq(schema.pallets.tenantId, tenantId),
        inArray(schema.pallets.shiftId, [...new Set(ordered.map(([, ref]) => ref.shiftId))]),
        inArray(schema.pallets.devicePalletId, [
          ...new Set(ordered.map(([, ref]) => ref.devicePalletId)),
        ]),
      ),
    );

  // Terminal matching is done in the map, never in SQL: `eq(col, null)`
  // compiles to `col = NULL`, which three-valued logic never treats as true,
  // so a null-terminal device could not be matched by an equality predicate at
  // all. The SELECT above therefore over-fetches by terminal (bounded by the
  // batch's own shift/pallet ids) and this loop keeps only the exact triples.
  const byKey = new Map<PalletKey, string>();
  for (const row of rows) {
    byKey.set(palletKey(row.shiftId, row.terminalId, row.devicePalletId), row.id);
  }
  return byKey;
}

/**
 * Postgres reports a unique violation as SQLSTATE 23505 and names the
 * constraint; drizzle wraps the driver error, so both levels are checked (the
 * same shape `signer-agents.service.ts` already inspects).
 */
function isDuplicatePalletSscc(error: unknown): boolean {
  const candidate = error as
    | { code?: unknown; constraint?: unknown; cause?: { code?: unknown; constraint?: unknown } }
    | null
    | undefined;
  if (!candidate) return false;
  const levels = [candidate, candidate.cause];
  return levels.some(
    (level) => level?.code === "23505" && level?.constraint === "pallets_tenant_sscc_uq",
  );
}

/**
 * Applies this batch's pallet closures, mirroring the box-closure loop's
 * guards exactly.
 *
 * `recordConsumedSerial` is passed in rather than imported so this module does
 * not depend on the SSCC service; the caller binds it to the SAME transaction.
 */
export async function applyPalletClosures(
  tx: Transaction,
  tenantId: string,
  closures: readonly PalletClosureDto[],
  byKey: Map<PalletKey, string>,
  recordConsumedSerial: (sscc: string) => Promise<void>,
): Promise<void> {
  // Sorted by the full identity key for the same 40P01 reason the box loop
  // sorts, and for the same totality reason `upsertPallets` does.
  const ordered = [...closures].sort((a, b) => {
    const left = palletKey(a.shiftId, a.terminalId, a.palletId);
    const right = palletKey(b.shiftId, b.terminalId, b.palletId);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const closure of ordered) {
    const id = byKey.get(palletKey(closure.shiftId, closure.terminalId, closure.palletId));
    // `upsertPallets` created every pallet this batch names, so a miss here
    // means the row vanished under us; nothing to apply, and the serial is
    // still recorded below.
    if (id !== undefined) {
      // `closed_at IS NULL` is part of the match, not decoration. The identity
      // columns say WHICH pallet this is, not whether it is still open to
      // write to: a device that lost its local database and restarted its
      // pallet counter at "p1" inside a still-open shift would otherwise have
      // this UPDATE rewrite the OLD closed row's sscc, orphaning the serial
      // actually printed on the physical pallet. A genuine redelivery under a
      // fresh batch id also matches zero rows here, which is the correct
      // no-op.
      try {
        await tx
          .update(schema.pallets)
          .set({
            sscc: closure.sscc,
            closedAt: new Date(closure.closedAt),
            operatorId: closure.operatorId,
            printVerifiedAt:
              closure.printVerifiedAt === null ? null : new Date(closure.printVerifiedAt),
            printSkippedAt:
              closure.printSkippedAt === null ? null : new Date(closure.printSkippedAt),
            // Server-assigned at this SAME statement: a later
            // `contentsChangedAfterClose` compares against this, never the
            // client's `closedAt`, which is a device clock with no skew bound.
            closureReceivedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.pallets.tenantId, tenantId),
              eq(schema.pallets.id, id),
              isNull(schema.pallets.closedAt),
            ),
          );
      } catch (error) {
        // Two physical pallets carrying one serial is a device-side serial
        // reuse, not a server fault. Surfaced as a 409 rather than letting the
        // raw 23505 render as a 500: both abort the batch (the transaction is
        // already unusable by the time this is caught), but only one is
        // diagnosable from the device's own logs.
        if (isDuplicatePalletSscc(error)) {
          throw new ConflictException({ code: "station_pallet_sscc_conflict" });
        }
        throw error;
      }

      // Late print-verification outcome, mirroring the box-closure loop's
      // second, narrower write: a pallet is acked within seconds of closing --
      // usually long before the operator resolves the print prompt -- so the
      // closure that first lands here normally carries both fields null, and
      // the primary UPDATE above deliberately refuses to touch an
      // already-closed row. Scoped by `sscc` equality IN ADDITION to the
      // pallet's server id, so it can only ever match the pallet this
      // closure's own serial already names; a reused device pallet id burning
      // a NEW serial matches nothing here, exactly as it matches nothing
      // above.
      if (closure.printVerifiedAt !== null || closure.printSkippedAt !== null) {
        await tx
          .update(schema.pallets)
          .set({
            ...(closure.printVerifiedAt !== null
              ? { printVerifiedAt: new Date(closure.printVerifiedAt) }
              : {}),
            ...(closure.printSkippedAt !== null
              ? { printSkippedAt: new Date(closure.printSkippedAt) }
              : {}),
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.pallets.tenantId, tenantId),
              eq(schema.pallets.id, id),
              eq(schema.pallets.sscc, closure.sscc),
            ),
          );
      }
    }

    // Outside the matched-row check on purpose, exactly as the box loop calls
    // it before its own `rowCount === 0` branch: the server must learn that a
    // serial really got printed even when this closure is a redelivery, or a
    // device that later loses its database is handed the block back from its
    // start and reprints numbers already standing on pallets.
    await recordConsumedSerial(closure.sscc);
  }
}

/**
 * Writes each exception's audit row and, for `disassemble`, retires the pallet
 * without touching its boxes.
 */
export async function applyPalletExceptions(
  tx: Transaction,
  tenantId: string,
  exceptions: readonly PalletExceptionDto[],
  byKey: Map<PalletKey, string>,
): Promise<void> {
  const ordered = [...exceptions].sort((a, b) => {
    const left = palletKey(a.shiftId, a.terminalId, a.palletId);
    const right = palletKey(b.shiftId, b.terminalId, b.palletId);
    if (left !== right) return left < right ? -1 : 1;
    return a.kind.localeCompare(b.kind);
  });
  for (const ex of ordered) {
    const id = byKey.get(palletKey(ex.shiftId, ex.terminalId, ex.palletId));
    if (id === undefined) continue;

    await tx.insert(schema.palletExceptions).values({
      tenantId,
      kind: ex.kind,
      palletId: id,
      shiftId: ex.shiftId,
      terminalId: ex.terminalId,
      operatorId: ex.operatorId,
      reason: ex.reason,
      // Null: this came from a station operator, not a cabinet document.
      disaggregationDocumentId: null,
      occurredAt: new Date(ex.occurredAt),
    });

    if (ex.kind === "disassemble") {
      // Only the pallet is retired. Its boxes stay closed and keep
      // `pallet_id`: taking a pallet apart takes boxes off a stack, it does
      // not open them, and the membership is the record that they stood there.
      // COALESCE keeps the FIRST disassembly's instant across a redelivery.
      await tx
        .update(schema.pallets)
        .set({
          disassembledAt: sql`coalesce(${schema.pallets.disassembledAt}, now())`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.id, id)));
    }
  }
}
