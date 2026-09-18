import { ConflictException, type Logger } from "@nestjs/common";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { formatSsccWithAi } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { PALLET_EXTENSION_DIGIT } from "../sscc/sscc.service";
import type {
  PalletMembershipDto,
  PalletMembershipOutcomeDto,
  PalletMembershipRemovalDto,
  PalletMembershipRemovalOutcomeDto,
} from "./dto";

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
  /** Null for a warehouse pallet, which belongs to no shift. */
  shiftId: string | null;
  kind: "production" | "warehouse";
  /** The product every member box must carry; set only for a warehouse pallet. */
  productId: string | null;
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
  /** Null for a warehouse pallet exception. */
  shiftId: string | null;
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
  shiftId: string | null,
  terminalId: string | null,
  devicePalletId: string,
): PalletKey {
  // A warehouse pallet has no shift, and its identity is (tenant, device,
  // devicePalletId). A shift id is a uuid, so the literal below can never
  // collide with one, and the key stays injective across both kinds.
  return `${shiftId ?? "warehouse"}|${terminalId ?? ""}|${devicePalletId}`;
}

export interface PalletRef {
  /** Null for a warehouse pallet. */
  shiftId: string | null;
  terminalId: string | null;
  devicePalletId: string;
  kind: "production" | "warehouse";
  /** Required for a warehouse ref; ignored for production. */
  productId: string | null;
  /** The authenticated device; required for a warehouse ref. */
  deviceId: string | null;
}

/**
 * Creates every pallet the batch names and returns their server ids.
 *
 * Called twice per batch. First as a pre-pass before the box-closure loop, so
 * a box's membership and its closure are ONE statement: the closure UPDATE
 * reads this map rather than doing its own round trip per box. Then again for
 * the warehouse pallets only MEMBERSHIPS name, which cannot be resolved until
 * that loop has written `boxes.sscc` -- the caller merges the second map into
 * the first.
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
    const key = palletKey(ref.shiftId, ref.terminalId, ref.devicePalletId);
    const seen = unique.get(key);
    // First ref wins, with ONE upgrade: a warehouse ref whose box could not be
    // resolved to a product carries `productId: null` and cannot seed a row,
    // so a later ref that DOES know the product replaces it. Never the other
    // way round -- one membership naming a box of a different product must not
    // be able to redefine a pallet another membership already seeded, or the
    // homogeneity check would test the wrong product. Production refs sharing
    // a key are identical in every field, so this is a no-op for them.
    if (seen !== undefined && !(seen.productId === null && ref.productId !== null)) continue;
    unique.set(key, ref);
  }
  if (unique.size === 0) return new Map();

  const ordered = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // Two inserts, because the two kinds have two DIFFERENT arbiters:
  // production pallets dedupe on `pallets_device_pallet_uq`
  // (tenant, shift, terminal, devicePalletId), warehouse pallets on the
  // partial `pallets_warehouse_device_pallet_uq` (tenant, device,
  // devicePalletId) WHERE kind = 'warehouse'. A partial unique index can only
  // be inferred as an arbiter when the statement repeats its predicate, which
  // is what the `where` below emits.
  const production = ordered.filter(([, ref]) => ref.kind === "production");
  // A warehouse ref with no product cannot be created: `pallets_kind_shape`
  // requires one. It is skipped rather than rejected -- its membership reports
  // `not_found` once the lookup below misses, and a closure always carries a
  // product.
  const warehouse = ordered.filter(
    ([, ref]) => ref.kind === "warehouse" && ref.productId !== null && ref.deviceId !== null,
  );

  if (production.length > 0) {
    await tx
      .insert(schema.pallets)
      .values(
        production.map(([, ref]) => ({
          tenantId,
          kind: "production" as const,
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
  }

  if (warehouse.length > 0) {
    await tx
      .insert(schema.pallets)
      .values(
        warehouse.map(([, ref]) => ({
          tenantId,
          kind: "warehouse" as const,
          shiftId: null,
          // `pallets_warehouse_terminal_check` requires terminal_id =
          // device_id::text, and the caller passes the authenticated device id
          // as both.
          terminalId: ref.terminalId,
          devicePalletId: ref.devicePalletId,
          productId: ref.productId,
          deviceId: ref.deviceId,
        })),
      )
      .onConflictDoNothing({
        target: [schema.pallets.tenantId, schema.pallets.deviceId, schema.pallets.devicePalletId],
        where: sql`${schema.pallets.kind} = 'warehouse'`,
      });
  }

  // A fresh SELECT rather than the insert's `.returning()`, for the same
  // reason the box upsert re-reads: a pallet already opened by an earlier
  // batch -- the ordinary case for every box after a pallet's first -- is
  // exactly the row ON CONFLICT DO NOTHING leaves untouched, and
  // `.returning()` never reports it.
  const shiftIds = [
    ...new Set(ordered.flatMap(([, ref]) => (ref.shiftId === null ? [] : [ref.shiftId]))),
  ];
  // A warehouse pallet's `shift_id` is NULL, so an `inArray` alone would never
  // see it; a batch that names both kinds has to reach both.
  const hasWarehouseRef = ordered.some(([, ref]) => ref.shiftId === null);
  const shiftPredicate =
    shiftIds.length === 0
      ? isNull(schema.pallets.shiftId)
      : hasWarehouseRef
        ? or(inArray(schema.pallets.shiftId, shiftIds), isNull(schema.pallets.shiftId))
        : inArray(schema.pallets.shiftId, shiftIds);
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
        shiftPredicate,
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
    // A warehouse row has a null `shiftId` and a `terminalId` equal to its own
    // device id, so `palletKey` renders it as `warehouse|<deviceId>|<id>` --
    // exactly what a membership or a warehouse closure computes. Another
    // device's warehouse pallet sharing the device-local id keys differently
    // and is therefore ignored here, which is the whole point of carrying the
    // terminal in the key.
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
 * guards -- and its LOGGING -- exactly.
 *
 * `recordConsumedSerial` is passed in rather than imported so this module does
 * not depend on the SSCC service (only on the constant naming the pallet
 * serial space); the caller binds the callback to the SAME transaction, and
 * passes its own logger so a no-op here is as findable as the box loop's.
 */
export async function applyPalletClosures(
  tx: Transaction,
  tenantId: string,
  closures: readonly PalletClosureDto[],
  byKey: Map<PalletKey, string>,
  recordConsumedSerial: (sscc: string) => Promise<void>,
  logger: Pick<Logger, "warn">,
): Promise<string[]> {
  // Member box ids of every warehouse pallet this batch actually closed. A
  // warehouse pallet's serial is printed on a label the handheld only produces
  // at closure, so closing one changes what the box registry must advertise
  // for each box standing on it (spec §2.3); the caller bumps their registry
  // version. A production pallet's members were already bumped when their own
  // closures wrote `boxes.pallet_id`.
  const memberBoxIds: string[] = [];
  // Sorted by the full identity key for the same 40P01 reason the box loop
  // sorts, and for the same totality reason `upsertPallets` does.
  const ordered = [...closures].sort((a, b) => {
    const left = palletKey(a.shiftId, a.terminalId, a.palletId);
    const right = palletKey(b.shiftId, b.terminalId, b.palletId);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const closure of ordered) {
    // The two SSCC serial spaces must never interleave: a box and the pallet
    // it stands on sharing one number is exactly what the separate extension
    // digits exist to prevent. A closure carrying a BOX-space serial writes to
    // `pallets.sscc` without tripping any constraint and makes
    // `recordConsumedSerial` advance the BOX block instead -- so it is
    // reported, loudly. Deliberately NOT rejected: a 400 here would wedge this
    // device's queue forever (the drain retries a rejected batch indefinitely
    // rather than dropping data), which is far worse than a mis-attributed
    // serial the warning below makes findable.
    if (closure.sscc[0] !== String(PALLET_EXTENSION_DIGIT)) {
      logger.warn(
        `Pallet closure for palletId ${closure.palletId} (tenant ${tenantId}, shift ` +
          `${closure.shiftId ?? "null"}, terminal ${closure.terminalId ?? "null"}) carries sscc ` +
          `${closure.sscc}, whose extension digit is not the pallet space's ` +
          `${PALLET_EXTENSION_DIGIT}; the serial will be recorded against the block that ` +
          `range belongs to, not the pallet block`,
      );
    }

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
      // Assigned in the try below and read after it. Every path through the
      // catch rethrows, so the statements past it are reachable only when the
      // UPDATE completed and set this.
      let matched: number;
      try {
        const changed = await tx
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
          )
          .returning({ id: schema.pallets.id });
        matched = changed.length;
      } catch (error) {
        // Two physical pallets carrying one serial is a device-side serial
        // reuse, not a server fault. Surfaced as a 409 rather than letting the
        // raw 23505 render as a 500: both abort the batch (the transaction is
        // already unusable by the time this is caught), but only one is
        // diagnosable from the device's own logs.
        //
        // Be clear about the cost, because it is NOT an ordinary rejection:
        // the device's drain retries every non-401 forever, so one duplicate
        // serial stops all scan, box and pallet delivery from that terminal
        // until someone edits its local database by hand. That wedge is
        // accepted here only because it is exactly what the box path already
        // does with `boxes_tenant_sscc_uq` (which merely renders as a 500
        // instead); changing it is a deliberate product decision about both
        // paths, not something to fix on the pallet side alone. Recorded as a
        // known wedge.
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

      // Zero rows is "nothing [more] to apply to the pallet row", not an
      // error -- the same branch the box-closure loop carries, and logged with
      // the same detail for the same reason. Two ordinary inputs land here: a
      // genuine redelivery of a closure an earlier batch already applied, and
      // a device that lost its local database, restarted its pallet counter at
      // an id it had already used inside a still-open shift, and closed the
      // NEW pallet with a NEW serial. The first is a correct no-op; the second
      // is not harmless at all -- `closed_at IS NULL` rightly protects the old
      // row, the sscc-scoped write above matches nothing, and
      // `recordConsumedSerial` below still marks the new serial consumed, so
      // that serial is standing on a physical pallet that no row references.
      // The guard stays; the SILENCE is what this log removes.
      if (matched === 0) {
        logger.warn(
          `Pallet closure for palletId ${closure.palletId} (tenant ${tenantId}, shift ` +
            `${closure.shiftId ?? "null"}, terminal ${closure.terminalId ?? "null"}, sscc ` +
            `${closure.sscc}) matched no open pallet row -- the pallet was already closed by ` +
            `an earlier delivery, or this device-local pallet id was reused after its first ` +
            `pallet closed; skipping as a no-op, but the serial is still recorded as consumed`,
        );
      }

      if (matched === 1 && closure.kind === "warehouse") {
        const members = await tx
          .select({ id: schema.boxes.id })
          .from(schema.boxes)
          .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.palletId, id)));
        memberBoxIds.push(...members.map((box) => box.id));
      }
    }

    // Outside the matched-row check on purpose, exactly as the box loop calls
    // it before its own `rowCount === 0` branch: the server must learn that a
    // serial really got printed even when this closure is a redelivery, or a
    // device that later loses its database is handed the block back from its
    // start and reprints numbers already standing on pallets.
    await recordConsumedSerial(closure.sscc);
  }
  return memberBoxIds;
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
): Promise<string[]> {
  // Boxes that stood on a pallet this batch took apart. They keep `pallet_id`
  // (see the disassemble branch below), but a handheld's registry must learn
  // that the pallet they name is retired, so the caller bumps their version.
  const disassembledBoxIds: string[] = [];
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

      const members = await tx
        .select({ id: schema.boxes.id })
        .from(schema.boxes)
        .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.palletId, id)));
      disassembledBoxIds.push(...members.map((box) => box.id));
    }
  }
  return disassembledBoxIds;
}

/**
 * The refusals `pallet_membership_rejections.reason` accepts. A narrower set
 * than `PalletMembershipStatus`: an accepted membership is the `boxes` row
 * itself, a replay is not a refusal at all, and `subscription_read_only` never
 * reaches this module (the ingest quarantines those records before applying
 * anything). Keep in step with
 * `pallet_membership_rejections_reason_check`, which 23514s the whole batch
 * on anything else.
 */
type PalletMembershipRejectionReason =
  | "already_on_pallet"
  | "not_found"
  | "not_closed"
  | "disassembled"
  | "pallet_closed"
  | "product_mismatch";

/**
 * Applies this batch's warehouse memberships (spec §2.3) one statement each,
 * sorted by (palletId, boxSscc) for the usual 40P01 reason. The UPDATE is the
 * whole rule: the box closed and not disassembled, the TARGET pallet still
 * open and not disassembled, same product as the pallet, and the box
 * either on no pallet or on a pallet that has since been disassembled --
 * `boxes.pallet_id` may only ever be overwritten in that last case. Zero rows
 * matched -> one diagnostic SELECT classifies the refusal and a
 * `pallet_membership_rejections` row remembers it, because a handheld that
 * reboots after the answer has nothing else to rebuild its conflict view
 * from.
 *
 * Outcomes are returned in the CALLER's order, not the sorted one: the
 * response contract is one entry per submitted record, same order.
 */
export async function applyPalletMemberships(
  tx: Transaction,
  tenantId: string,
  memberships: readonly PalletMembershipDto[],
  byKey: Map<PalletKey, string>,
  deviceId: string,
): Promise<{ outcomes: PalletMembershipOutcomeDto[]; changedBoxIds: string[] }> {
  const ordered = [...memberships]
    .map((membership, index) => ({ membership, index }))
    .sort((a, b) => {
      const left = `${a.membership.palletId}|${a.membership.boxSscc}`;
      const right = `${b.membership.palletId}|${b.membership.boxSscc}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const outcomes: PalletMembershipOutcomeDto[] = new Array<PalletMembershipOutcomeDto>(
    memberships.length,
  );
  const changedBoxIds: string[] = [];

  for (const { membership, index } of ordered) {
    const palletId = byKey.get(palletKey(null, deviceId, membership.palletId));
    if (palletId === undefined) {
      // No pallet row could be created, which for a warehouse pallet means no
      // membership in this batch resolved its box to a product (see
      // `upsertPallets`). The box is unknown to this tenant; there is no row
      // to record the refusal against either.
      outcomes[index] = {
        palletId: membership.palletId,
        boxSscc: membership.boxSscc,
        status: "not_found",
      };
      continue;
    }

    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE boxes b
         SET pallet_id = ${palletId}, updated_at = now()
        FROM shifts s, pallets tp
       WHERE b.tenant_id = ${tenantId} AND b.sscc = ${membership.boxSscc}
         AND s.tenant_id = b.tenant_id AND s.id = b.shift_id
         AND tp.tenant_id = b.tenant_id AND tp.id = ${palletId}
         AND tp.product_id = s.product_id
         AND tp.closed_at IS NULL AND tp.disassembled_at IS NULL
         AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL
         AND (b.pallet_id IS NULL
              OR EXISTS (SELECT 1 FROM pallets old
                          WHERE old.tenant_id = b.tenant_id AND old.id = b.pallet_id
                            AND old.id <> ${palletId} AND old.disassembled_at IS NOT NULL))
      RETURNING b.id
    `);
    const accepted = updated.rows[0];
    if (accepted) {
      changedBoxIds.push(accepted.id);
      outcomes[index] = {
        palletId: membership.palletId,
        boxSscc: membership.boxSscc,
        status: "accepted",
      };
      continue;
    }

    const diagnostic = await tx.execute<{
      id: string;
      closed_at: Date | null;
      disassembled_at: Date | null;
      pallet_id: string | null;
      old_sscc: string | null;
      old_disassembled_at: Date | null;
      target_closed_at: Date | null;
      target_disassembled_at: Date | null;
      same_product: boolean;
    }>(sql`
      SELECT b.id, b.closed_at, b.disassembled_at, b.pallet_id,
             old.sscc AS old_sscc, old.disassembled_at AS old_disassembled_at,
             tp.closed_at AS target_closed_at, tp.disassembled_at AS target_disassembled_at,
             (s.product_id = tp.product_id) AS same_product
        FROM boxes b
        JOIN shifts s ON s.tenant_id = b.tenant_id AND s.id = b.shift_id
        JOIN pallets tp ON tp.tenant_id = b.tenant_id AND tp.id = ${palletId}
        LEFT JOIN pallets old ON old.tenant_id = b.tenant_id AND old.id = b.pallet_id
       WHERE b.tenant_id = ${tenantId} AND b.sscc = ${membership.boxSscc}
    `);
    const row = diagnostic.rows[0];

    // Ordered by what the operator can act on, not by the UPDATE's own clause
    // order: a replay is the commonest answer and must never be reported as a
    // conflict, and "someone else's pallet already holds it" is the only
    // refusal that names another pallet.
    let status: PalletMembershipRejectionReason | "replayed";
    let winningPalletId: string | null = null;
    let winningPalletSscc: string | undefined;
    if (!row) status = "not_found";
    else if (row.pallet_id === palletId) status = "replayed";
    else if (row.closed_at === null) status = "not_closed";
    else if (row.disassembled_at !== null) status = "disassembled";
    else if (row.pallet_id !== null && row.old_disassembled_at === null) {
      status = "already_on_pallet";
      winningPalletId = row.pallet_id;
      // Null until that pallet closes: the serial is printed at closure, so an
      // open rival pallet has no number to show the operator yet.
      if (row.old_sscc !== null) winningPalletSscc = formatSsccWithAi(row.old_sscc);
    } else if (row.target_closed_at !== null || row.target_disassembled_at !== null) {
      // The TARGET pallet is already closed (its SSCC label is printed and its
      // contents are what the export claims) or disassembled. Nothing may be
      // added to it any more.
      status = "pallet_closed";
    } else if (!row.same_product) {
      // The last rule the UPDATE carried, read from the diagnostic rather
      // than inferred: the box's shift makes a different product than the one
      // the warehouse pallet was seeded with.
      status = "product_mismatch";
    } else {
      // Every clause of the UPDATE is now accounted for, so a zero-row match
      // with none of them refused is a rule this classifier does not know
      // about. Better a loud 500 on a batch the station will retry than a
      // refusal reported under a status the operator cannot act on.
      throw new Error("unclassified membership refusal");
    }

    outcomes[index] = {
      palletId: membership.palletId,
      boxSscc: membership.boxSscc,
      status,
      ...(winningPalletSscc !== undefined ? { winningPalletSscc } : {}),
    };

    if (status !== "replayed") {
      // Unique per (tenant, pallet, sscc), so a redelivered batch re-reports
      // the same refusal without duplicating the row.
      await tx
        .insert(schema.palletMembershipRejections)
        .values({
          tenantId,
          palletId,
          boxSscc: membership.boxSscc,
          boxId: row?.id ?? null,
          reason: status,
          winningPalletId,
          addedAt: new Date(membership.addedAt),
        })
        .onConflictDoNothing();
    }
  }

  return { outcomes, changedBoxIds };
}

/**
 * Takes boxes back off the device's own OPEN warehouse pallets (spec
 * 2026-09-18-open-pallet-box-removal §2). The undo of `applyPalletMemberships`,
 * and the second relaxation of 06d's «pallet_id is never cleared»: a draft
 * pallet has no SSCC, no label and no export, so nothing refers to it.
 *
 * Runs BEFORE memberships so a removal and a re-scan of the same box in one
 * batch land in that order. Never creates a pallet row: a removal naming a
 * pallet the server has never seen is `not_found`, which is harmless.
 *
 * Sorted by (palletId, boxSscc) for the usual 40P01 reason, and reported in the
 * CALLER's order, exactly like the membership path.
 */
export async function applyPalletMembershipRemovals(
  tx: Transaction,
  tenantId: string,
  removals: readonly PalletMembershipRemovalDto[],
  deviceId: string,
): Promise<{
  outcomes: PalletMembershipRemovalOutcomeDto[];
  changedBoxIds: string[];
  touchedPalletIds: string[];
}> {
  const ordered = [...removals]
    .map((removal, index) => ({ removal, index }))
    .sort((a, b) => {
      const left = `${a.removal.palletId}|${a.removal.boxSscc}`;
      const right = `${b.removal.palletId}|${b.removal.boxSscc}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const outcomes = new Array<PalletMembershipRemovalOutcomeDto>(removals.length);
  const changedBoxIds: string[] = [];
  const touched = new Set<string>();
  // One lookup per device-local pallet id, reused by every removal naming it.
  // The empty id is the "this device has no such warehouse pallet" sentinel;
  // a real id is a uuid, so the two can never be confused. Only the id is
  // cached: whether the pallet is still open is re-read at the point it
  // decides an outcome, because this batch is not the only writer.
  const palletByDeviceId = new Map<string, { id: string }>();

  for (const { removal, index } of ordered) {
    let pallet = palletByDeviceId.get(removal.palletId);
    if (pallet === undefined) {
      const [row] = await tx
        .select({ id: schema.pallets.id })
        .from(schema.pallets)
        .where(
          and(
            eq(schema.pallets.tenantId, tenantId),
            eq(schema.pallets.kind, "warehouse"),
            eq(schema.pallets.deviceId, deviceId),
            eq(schema.pallets.devicePalletId, removal.palletId),
          ),
        )
        .limit(1);
      pallet = row ? { id: row.id } : { id: "" };
      palletByDeviceId.set(removal.palletId, pallet);
    }
    const base = { palletId: removal.palletId, boxSscc: removal.boxSscc };
    if (pallet.id === "") {
      outcomes[index] = { ...base, status: "not_found" };
      continue;
    }
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE boxes b
         SET pallet_id = NULL, updated_at = now()
        FROM pallets tp
       WHERE b.tenant_id = ${tenantId} AND b.sscc = ${removal.boxSscc}
         AND tp.tenant_id = b.tenant_id AND tp.id = b.pallet_id AND tp.id = ${pallet.id}
         AND tp.closed_at IS NULL AND tp.disassembled_at IS NULL
      RETURNING b.id
    `);
    const removed = updated.rows[0];
    if (removed) {
      changedBoxIds.push(removed.id);
      touched.add(pallet.id);
      outcomes[index] = { ...base, status: "removed" };
      continue;
    }
    const [box] = await tx
      .select({ palletId: schema.boxes.palletId })
      .from(schema.boxes)
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.sscc, removal.boxSscc)))
      .limit(1);
    // Ordered by what the operator can act on: a box that is simply not on
    // this pallet any more is the common replay; a closed pallet is the one
    // answer that sends them to the disassemble flow instead.
    if (!box) {
      outcomes[index] = { ...base, status: "not_found" };
      continue;
    }
    if (box.palletId !== pallet.id) {
      outcomes[index] = { ...base, status: "replayed" };
      continue;
    }
    // The box IS on this pallet and the statement still refused it, so the
    // pallet must have closed or been disassembled. Re-read that state instead
    // of trusting the value cached before the UPDATE: a disassembly committed
    // in between is a real race, and it has to classify rather than throw.
    const [state] = await tx
      .select({
        closedAt: schema.pallets.closedAt,
        disassembledAt: schema.pallets.disassembledAt,
      })
      .from(schema.pallets)
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.id, pallet.id)))
      .limit(1);
    if (state !== undefined && (state.closedAt !== null || state.disassembledAt !== null)) {
      outcomes[index] = { ...base, status: "pallet_closed" };
      continue;
    }
    throw new Error("unclassified membership removal refusal");
  }
  return { outcomes, changedBoxIds, touchedPalletIds: [...touched] };
}

/**
 * Deletes every named warehouse pallet that is still an open draft and holds
 * no box any more, with its own rejection rows and after clearing every
 * `winning_pallet_id` that points at it from another pallet's rejection (both
 * FKs are ON DELETE NO ACTION). Runs AFTER memberships, so a batch that
 * empties a draft and refills it in the same delivery keeps it.
 */
export async function pruneEmptyWarehouseDrafts(
  tx: Transaction,
  tenantId: string,
  palletIds: readonly string[],
): Promise<string[]> {
  const deleted: string[] = [];
  for (const palletId of [...palletIds].sort()) {
    const [empty] = await tx
      .select({ id: schema.pallets.id })
      .from(schema.pallets)
      .where(
        and(
          eq(schema.pallets.tenantId, tenantId),
          eq(schema.pallets.id, palletId),
          eq(schema.pallets.kind, "warehouse"),
          isNull(schema.pallets.closedAt),
          isNull(schema.pallets.disassembledAt),
          sql`NOT EXISTS (SELECT 1 FROM boxes b WHERE b.tenant_id = ${tenantId} AND b.pallet_id = ${palletId})`,
        ),
      )
      .limit(1);
    if (!empty) continue;
    // ANOTHER device's refusal can point at this draft: `applyPalletMemberships`
    // stores the box's CURRENT pallet as `winning_pallet_id` on an
    // `already_on_pallet` rejection, and that row hangs off the RIVAL pallet,
    // so the delete below never reaches it. Its FK is ON DELETE NO ACTION, so
    // the pallet delete would raise 23503, 500 the batch, and wedge the
    // handheld's removal queue on an endless retry. The rival's record of what
    // it scanned is kept; only the pointer, meaningless once the draft is gone,
    // is cleared.
    await tx
      .update(schema.palletMembershipRejections)
      .set({ winningPalletId: null })
      .where(
        and(
          eq(schema.palletMembershipRejections.tenantId, tenantId),
          eq(schema.palletMembershipRejections.winningPalletId, palletId),
        ),
      );
    await tx
      .delete(schema.palletMembershipRejections)
      .where(
        and(
          eq(schema.palletMembershipRejections.tenantId, tenantId),
          eq(schema.palletMembershipRejections.palletId, palletId),
        ),
      );
    await tx
      .delete(schema.pallets)
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.id, palletId)));
    deleted.push(palletId);
  }
  return deleted;
}

/**
 * Expands the outcomes of the memberships this batch actually APPLIED back
 * over every membership the device SUBMITTED, in the caller's order.
 *
 * Generic over the outcome type because memberships and their REMOVALS answer
 * the same shape and are denied by the same rule; only the status vocabulary
 * differs, and `subscription_read_only` belongs to both.
 *
 * A read-only subscription denies every membership in the batch, quarantines
 * it and filters it out of the body, so `applied` is a subsequence of `all`
 * with the denied indexes removed. The handheld matches this list to its own
 * outbox positionally, so a record it refused must keep its original index and
 * report that refusal there.
 *
 * A cursor that runs past `applied` (or stops short of its end) means the two
 * lists disagree about which records were applied -- every later outcome would
 * then be attributed to the wrong membership, which is worse than a failed
 * batch the station retries. Reported as an error rather than papered over.
 */
export function assembleMembershipOutcomes<
  O extends { palletId: string; boxSscc: string; status: string },
>(
  all: readonly { palletId: string; boxSscc: string }[],
  deniedIndexes: ReadonlySet<number>,
  applied: readonly O[],
): (O | { palletId: string; boxSscc: string; status: "subscription_read_only" })[] {
  let cursor = 0;
  const outcomes = all.map((membership, index) => {
    if (deniedIndexes.has(index)) {
      return {
        palletId: membership.palletId,
        boxSscc: membership.boxSscc,
        status: "subscription_read_only" as const,
      };
    }
    const outcome = applied[cursor];
    cursor += 1;
    if (outcome === undefined) throw new Error("membership outcome cursor desynchronised");
    return outcome;
  });
  if (cursor !== applied.length) throw new Error("membership outcome cursor desynchronised");
  return outcomes;
}
