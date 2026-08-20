import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, desc, eq, gte, isNull, lte, max, sql } from "drizzle-orm";
import { parseSscc, ssccSerialCapacity } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";

type SsccTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Boxes take extension digit 0; 1 is reserved for pallets (06d). */
export const BOX_EXTENSION_DIGIT = 0;

/** An issuer prefix is always the first 9 digits of a 13-digit GLN — see deriveIssuerPrefix. */
const ISSUER_PREFIX_LENGTH = 9;

export interface SsccBlock {
  issuerPrefix: string;
  extensionDigit: number;
  fromSerial: number;
  toSerial: number;
  /**
   * The highest serial in this block known to be consumed, or null before
   * any is. Always null for a block just cut by `allocate` (nothing in a
   * fresh range has been used yet); carries the real value through from
   * `allocateForBundle` when it hands back an existing block, so the
   * device can reconcile its own cursor against the row it already holds
   * instead of being handed a range shaped like a brand new one (final
   * review, finding 1).
   */
  consumedThroughSerial: number | null;
}

/** A GS1 GLN is always exactly 13 digits; the issuer prefix is its first 9. */
const GLN_PATTERN = /^\d{13}$/;

/**
 * CodeRabbit PR33 review, Finding 4: a NAMED exhaustion error, thrown by
 * `allocate` when a (tenant, issuer prefix, extension digit) counter has
 * nothing left to give at all -- distinct from `InternalServerErrorException`
 * (an unexpected failure) or `BadRequestException` (a caller error). This is
 * an entirely expected, if rare, business condition once a 9-digit issuer
 * prefix's whole 10-million-serial space is spent, and callers (see
 * `ShiftsService.bundleSscc`) treat it as such -- caught and degraded to
 * `sscc: null`, the same way a missing GLN already is, rather than a 500.
 */
export class SsccCapacityExhaustedException extends ConflictException {
  constructor(issuerPrefix: string, extensionDigit: number) {
    super(
      `SSCC serial space for issuer prefix ${issuerPrefix}, extension digit ${extensionDigit} is exhausted`,
    );
  }
}

/**
 * Derives the 9-digit issuer prefix from a 13-digit GLN. Exported (rather
 * than kept private to `resolveIssuerPrefix` below) so the org-profile and
 * counterparties counter-settings endpoints (Task 5) can compute the SAME
 * prefix a shift's box allocation would use, without duplicating the format
 * check or re-deriving the slicing rule in three places.
 *
 * `ownerLabel` only shapes the error message (e.g. "organisation profile",
 * "sscc issuer counterparty", "counterparty") -- the validation itself is
 * identical regardless of who owns the GLN.
 */
export function deriveIssuerPrefix(gln: string, ownerLabel: string): string {
  if (!GLN_PATTERN.test(gln)) {
    throw new BadRequestException(`${ownerLabel}'s GLN must be exactly 13 digits`);
  }
  return gln.slice(0, 9);
}

/**
 * The lowest `nextSerial` an admin may legally seed for (tenant, issuer
 * prefix, extension digit): one past the highest serial ever actually
 * PRINTED under that triple, or the extension digit's own first serial when
 * nothing has been.
 *
 * "Printed", not "handed out" (2026-08-20 reseed design): reseeding now
 * revokes the blocks a device holds (`SsccService.seedCounter`), so a serial
 * that was merely allocated is not a reason to burn the whole rest of the
 * space -- the device is told to drop that range and will never emit it.
 * What must never be reissued is a serial already on a physical box, and
 * `consumedThroughSerial` -- advanced only by `recordConsumedSerial`, only
 * when a box closure names a real SSCC -- is exactly that set.
 *
 * Deliberately scans REVOKED blocks too: revocation invalidates a range's
 * unprinted remainder, never the record of what was printed from it.
 *
 * Exported as a plain function (rather than a method requiring
 * `SsccService` as an injected dependency) so `seedCounter` can call it on a
 * transaction handle, and so the e2e suite can assert the floor directly.
 */
export async function seedFloor(
  db: Pick<Db, "select">,
  tenantId: string,
  issuerPrefix: string,
  extensionDigit: number,
): Promise<number> {
  const [row] = await db
    .select({ printed: max(schema.ssccBlocks.consumedThroughSerial) })
    .from(schema.ssccBlocks)
    .where(
      and(
        eq(schema.ssccBlocks.tenantId, tenantId),
        eq(schema.ssccBlocks.issuerPrefix, issuerPrefix),
        eq(schema.ssccBlocks.extensionDigit, extensionDigit),
      ),
    );
  const firstSerial = extensionDigit === 0 ? 1 : 0;
  return row?.printed == null ? firstSerial : Math.max(Number(row.printed) + 1, firstSerial);
}

/**
 * Atomically seeds (tenant, issuer prefix, extension digit)'s counter to
 * `nextSerial`, in ONE statement that re-validates `seedFloor`'s condition
 * live against `sscc_blocks` at write time -- the highest serial actually
 * PRINTED under this key, matching `seedFloor`'s own definition above. The
 * two expressions must always say the same thing: if they drift, the
 * pre-check and the write disagree and one of them is decorative.
 *
 * `putSscc` (org-profile.service.ts, counterparties.service.ts) used to read
 * `seedFloor` and then write `nextSerial` unconditionally in a SEPARATE
 * statement. If an `allocate()` call's counter-advance (and matching
 * `sscc_blocks` insert) landed in the gap between that read and this write,
 * the write would silently overwrite the counter with a value now BEHIND
 * the block just issued -- the next `allocate()` would then re-cut that same
 * range for a different device, an SSCC collision across devices, exactly
 * what `seedFloor` exists to prevent in the first place.
 *
 * Folding the guard into the `ON CONFLICT DO UPDATE ... WHERE` clause makes
 * the check part of the SAME atomic statement as the write: the subquery
 * against `sscc_blocks` is evaluated against the database's CURRENT
 * committed state at the moment this statement runs, not a value read
 * earlier and passed in, so a block that committed a moment before is
 * already reflected. Returns `false` (having written nothing) when that
 * guard excludes the update -- the floor moved out from under the caller's
 * own pre-check, and the caller should surface a conflict rather than
 * silently accept a stale seed.
 *
 * The INSERT branch (no counter row yet for this key) needs no such guard:
 * every `sscc_blocks` row is created in the SAME transaction as its
 * `sscc_counters` row (`allocate`, above), so a block can never exist
 * without a corresponding counter row already present -- meaning a
 * brand-new key can never have a floor above 0 to violate.
 */
export async function atomicSeedSscc(
  db: Pick<Db, "insert">,
  tenantId: string,
  issuerPrefix: string,
  extensionDigit: number,
  nextSerial: number,
): Promise<boolean> {
  const [row] = await db
    .insert(schema.ssccCounters)
    .values({ tenantId, issuerPrefix, extensionDigit, nextSerial })
    .onConflictDoUpdate({
      target: [
        schema.ssccCounters.tenantId,
        schema.ssccCounters.issuerPrefix,
        schema.ssccCounters.extensionDigit,
      ],
      set: { nextSerial, updatedAt: sql`now()` },
      setWhere: sql`${nextSerial} >= COALESCE((
        SELECT MAX(${schema.ssccBlocks.consumedThroughSerial}) + 1 FROM ${schema.ssccBlocks}
        WHERE ${schema.ssccBlocks.tenantId} = ${tenantId}
          AND ${schema.ssccBlocks.issuerPrefix} = ${issuerPrefix}
          AND ${schema.ssccBlocks.extensionDigit} = ${extensionDigit}
      ), ${extensionDigit === 0 ? 1 : 0})`,
    })
    .returning({ nextSerial: schema.ssccCounters.nextSerial });
  return row !== undefined;
}

@Injectable()
export class SsccService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Whose numbers this shift's boxes carry, as a 9-digit issuer PREFIX (the
   * GLN's first 9 digits) rather than the full 13-digit GLN.
   *
   * The prefix, not the GLN, is what makes a serial unique: one GS1 member
   * commonly holds several GLNs (one per location) that share the same
   * prefix, so `sscc_counters`/`sscc_blocks` are keyed on the prefix — see
   * their schema comments in platform.ts.
   *
   * `ssccIssuerCounterpartyId` is an explicit choice, not `counterpartyId`:
   * that field says who the goods are for, this one says whose numbers they
   * carry, and packing for a client under one's own SSCCs is ordinary.
   */
  async resolveIssuerPrefix(
    tenantId: string,
    shiftId: string,
    executor: Pick<Db, "select"> = this.db,
  ): Promise<string> {
    const [shift] = await executor
      .select({ issuer: schema.shifts.ssccIssuerCounterpartyId })
      .from(schema.shifts)
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)));
    if (!shift) throw new BadRequestException("shift not found");

    if (shift.issuer) {
      const [cp] = await executor
        .select({ gln: schema.counterparties.gln })
        .from(schema.counterparties)
        .where(
          and(
            eq(schema.counterparties.tenantId, tenantId),
            eq(schema.counterparties.id, shift.issuer),
          ),
        );
      if (!cp?.gln) throw new BadRequestException("sscc issuer counterparty has no GLN");
      return deriveIssuerPrefix(cp.gln, "sscc issuer counterparty");
    }

    const [profile] = await executor
      .select({ gln: schema.orgProfiles.gln })
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, tenantId));
    if (!profile?.gln) throw new BadRequestException("organisation profile has no GLN");
    return deriveIssuerPrefix(profile.gln, "organisation profile");
  }

  /**
   * Reserves `size` serials and records who received them, atomically.
   *
   * The counter upsert is one statement — a read followed by a write would
   * eventually hand two devices overlapping ranges, and an overlapping range
   * is indistinguishable from a duplicate box. It's wrapped in a transaction
   * together with the `sscc_blocks` insert so the pair is atomic too: without
   * it, a failure on the insert alone (a stale deviceId tripping its FK, a
   * transient error) would leave the counter already advanced with nothing
   * recording who got the range — a burned, unaccounted-for block, which is
   * exactly what this table exists to prevent.
   *
   * CodeRabbit PR33 review, Finding 4: the increment used to be unconditional
   * -- `nextSerial + size`, with nothing stopping it from crossing the
   * prefix's own capacity (`ssccSerialCapacity`, `10 ** (16 - 9)` for a
   * 9-digit issuer prefix). The settings API lets an admin seed `nextSerial`
   * up to `9_999_999` (one below capacity), so an allocation near the
   * ceiling could produce a block whose `toSerial` sat beyond it. The device
   * would then burn a serial from that block, have `buildSscc` throw
   * `SSCC_RANGE` when asked to build the actual SSCC, and repeat -- burning
   * another serial each time -- until the block was exhausted, with only a
   * console error to show for it (see `close-box.ts` on the device side).
   *
   * The fix stays inside the SAME statement/transaction as the increment,
   * never a separate check that could race a concurrent `allocate` for the
   * SAME counter: the UPDATE's SET expression computes
   * `LEAST(nextSerial + size, capacity)` using the row's OWN current value
   * at conflict-resolution time -- exactly the value Postgres's `ON CONFLICT
   * DO UPDATE` already serializes concurrent upsers against (the same
   * guarantee the un-clamped `nextSerial + size` expression already relied
   * on) -- so two concurrent allocations against a nearly-exhausted counter
   * can never together cross `capacity`, only ever approach it. `before`
   * (this call's own pre-increment value) is derived from the RETURNED
   * unclamped next value minus `size`, needing no separate read: it is
   * correct regardless of clamping, because it is computed from this
   * request's own known inputs, not a fresh query that could see a value a
   * concurrent transaction has since changed.
   *
   * - `before >= capacity`: nothing at all remains. Refuse cleanly by
   *   throwing `SsccCapacityExhaustedException` -- INSIDE the transaction, so
   *   the increment this statement just performed is rolled back and the
   *   counter is left exactly as it was, never parked over capacity.
   * - `before < capacity` but the unclamped `after` would exceed it: grant
   *   only the remainder (`capacity - before`), a partial (but still
   *   correct, still usable) block, and issue a follow-up UPDATE — still
   *   inside this same transaction, so no concurrent allocate can observe
   *   the intermediate unclamped value — correcting the persisted counter
   *   back down to `capacity` so it does not silently sit over-capacity for
   *   the next call.
   */
  async allocate(
    tenantId: string,
    issuerPrefix: string,
    extensionDigit: number,
    deviceId: string,
    size: number,
    transaction?: SsccTransaction,
  ): Promise<SsccBlock> {
    const capacity = ssccSerialCapacity(issuerPrefix);
    const firstSerial = extensionDigit === 0 ? 1 : 0;
    const perform = async (tx: SsccTransaction): Promise<SsccBlock> => {
      const [row] = await tx
        .insert(schema.ssccCounters)
        .values({ tenantId, issuerPrefix, extensionDigit, nextSerial: firstSerial + size })
        .onConflictDoUpdate({
          target: [
            schema.ssccCounters.tenantId,
            schema.ssccCounters.issuerPrefix,
            schema.ssccCounters.extensionDigit,
          ],
          set: {
            nextSerial: sql`GREATEST(${schema.ssccCounters.nextSerial}, ${firstSerial}) + ${size}`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ next: schema.ssccCounters.nextSerial });

      if (!row) throw new InternalServerErrorException("Failed to allocate sscc block");
      // Unclamped: the counter's actual post-increment value, which may sit
      // beyond `capacity` at this point -- corrected below before this
      // transaction ever commits.
      const rawNext = Number(row.next);
      const before = rawNext - size;

      if (before >= capacity) {
        // Nothing left to give at all. Throwing here rolls back the
        // increment above (still inside this transaction), leaving the
        // counter exactly where it was for the next attempt to see the
        // same, consistent "exhausted" state.
        throw new SsccCapacityExhaustedException(issuerPrefix, extensionDigit);
      }

      const toExclusive = Math.min(rawNext, capacity);
      if (toExclusive !== rawNext) {
        // Partial: this allocation would have crossed the boundary. Correct
        // the persisted counter back down to `capacity` -- still inside this
        // transaction, so no concurrent allocate can ever observe the
        // intermediate unclamped value.
        await tx
          .update(schema.ssccCounters)
          .set({ nextSerial: toExclusive, updatedAt: sql`now()` })
          .where(
            and(
              eq(schema.ssccCounters.tenantId, tenantId),
              eq(schema.ssccCounters.issuerPrefix, issuerPrefix),
              eq(schema.ssccCounters.extensionDigit, extensionDigit),
            ),
          );
      }

      const block: SsccBlock = {
        issuerPrefix,
        extensionDigit,
        fromSerial: before,
        toSerial: toExclusive - 1,
        consumedThroughSerial: null,
      };

      await tx.insert(schema.ssccBlocks).values({
        tenantId,
        issuerPrefix,
        extensionDigit,
        deviceId,
        fromSerial: block.fromSerial,
        toSerial: block.toSerial,
      });

      return block;
    };
    return transaction ? perform(transaction) : this.db.transaction(perform);
  }

  /**
   * The bundle's entry point into allocation (Task 7 review, finding 3):
   * hands back the device's own block for this (tenant, issuer prefix,
   * extension digit) triple rather than cutting a fresh one on every fetch,
   * UNLESS that block is fully consumed, in which case a fresh one is cut
   * instead of handing back an exhausted range (Task 7 correction).
   *
   * The bundle is not a top-up channel. The station re-downloads it on
   * every shift entry, re-entry and app restart, and nothing else caps how
   * often that happens -- if each fetch cut a fresh 2000-serial block, a
   * device would work through a 10-million-serial number space in about
   * 5000 fetches, mid-shift, with `buildSscc` then throwing SSCC_RANGE on
   * the factory floor. The bundle's actual job is narrower: guarantee a
   * device numbers for an issuer it has NEVER held, and recover a device
   * that lost its own record of what it already holds.
   *
   * A repeat call returns the device's EXISTING block's ORIGINAL
   * `fromSerial`/`toSerial` -- never shrunk -- PLUS `consumedThroughSerial`
   * as its own field, so the device can reconcile against the row it
   * already holds (matching primary key: `(issuer_prefix, extension_digit,
   * from_serial)` on the device's own `sscc_pool`) rather than being handed
   * a range shaped like a brand new one.
   *
   * This used to shrink `fromSerial` to `consumedThroughSerial + 1`
   * instead (final review, finding 1): that reads like a fresh, disjoint
   * range to the device's `addRange`, which inserts it as a SECOND row
   * alongside the one it already holds for the same block (its primary key
   * is keyed on `from_serial`, and a shrunk `fromSerial` never matches the
   * original). `burnSerial`'s `ORDER BY from_serial` then drains the
   * original row's remainder first and, once THAT is exhausted, restarts
   * the second row from ITS OWN `from_serial` -- reissuing every serial in
   * between a second time, onto a second physical box, long after the
   * first row's labels are already printed. Returning the original bounds
   * unconditionally means the device's `addRange` always targets the SAME
   * row it already has; the cursor itself is reconciled device-side via
   * `consumedThroughSerial`, which also recovers a device that lost its
   * local database (a factory reset, a corrupted store): re-provisioning
   * from scratch, it has no row to conflict against, so this field lets it
   * seed a fresh row's cursor PAST what was already printed instead of
   * restarting at `fromSerial` and reprinting labels already on boxes --
   * caught only later, and only at ingest, by `boxes_tenant_sscc_uq`.
   */
  async allocateForBundle(
    tenantId: string,
    issuerPrefix: string,
    extensionDigit: number,
    deviceId: string,
    size: number,
    transaction?: SsccTransaction,
  ): Promise<SsccBlock> {
    const perform = async (tx: SsccTransaction): Promise<SsccBlock> => {
      const [existing] = await tx
        .select({
          issuerPrefix: schema.ssccBlocks.issuerPrefix,
          extensionDigit: schema.ssccBlocks.extensionDigit,
          fromSerial: schema.ssccBlocks.fromSerial,
          toSerial: schema.ssccBlocks.toSerial,
          consumedThroughSerial: schema.ssccBlocks.consumedThroughSerial,
        })
        .from(schema.ssccBlocks)
        .where(
          and(
            eq(schema.ssccBlocks.tenantId, tenantId),
            eq(schema.ssccBlocks.issuerPrefix, issuerPrefix),
            eq(schema.ssccBlocks.extensionDigit, extensionDigit),
            eq(schema.ssccBlocks.deviceId, deviceId),
            // A revoked block is not this device's block any more: the admin
            // reseeded the counter and the device is being told (via the
            // bundle's `ssccRevokedFrom`) to drop this range entirely. Handing
            // it back here would make the whole reseed a no-op.
            isNull(schema.ssccBlocks.revokedAt),
          ),
        )
        .orderBy(desc(schema.ssccBlocks.issuedAt))
        .limit(1);

      // "< toSerial" (i.e. exhausted is ">=", not "==="): consumedThroughSerial
      // can never legitimately exceed toSerial -- recordConsumedSerial's own
      // covering-range predicates forbid it -- but if it somehow did (a
      // defensive concern, not an expected path), the old "!== toSerial" test
      // would still read that as "not yet fully consumed" and hand back an
      // INVERTED, empty range (fromSerial > toSerial) as though it were
      // usable, rather than recognising the block as exhausted and cutting a
      // fresh one.
      if (
        existing &&
        (existing.consumedThroughSerial == null ||
          existing.consumedThroughSerial < existing.toSerial)
      ) {
        return {
          issuerPrefix: existing.issuerPrefix,
          extensionDigit: existing.extensionDigit,
          fromSerial: existing.fromSerial,
          toSerial: existing.toSerial,
          consumedThroughSerial: existing.consumedThroughSerial,
        };
      }
      // No block at all yet, OR the held one is fully consumed -- either way,
      // cut a fresh one rather than hand back a range with nothing left in it.
      return this.allocate(tenantId, issuerPrefix, extensionDigit, deviceId, size, tx);
    };
    return transaction ? perform(transaction) : this.db.transaction(perform);
  }

  /**
   * Advances `sscc_blocks.consumedThroughSerial` for the block that covers
   * `sscc`'s serial, the moment the server first learns that serial was
   * really used -- a box closure arriving at ingest, carrying the SSCC that
   * went on the box. This is the ONLY thing that ever moves the cursor: the
   * bundle's own allocation path never does, on purpose (see
   * `allocateForBundle`'s doc comment) -- a handed-out serial is not a used
   * one until a box closure says so.
   *
   * One statement, tenant-scoped, and monotonic (`GREATEST`): a batch of box
   * closures can arrive out of order (offline devices, retried sync
   * batches), and consumption must never regress to an earlier serial just
   * because its closure happened to land after a later one's.
   *
   * Silently a no-op for an `sscc` this app didn't itself issue (fails
   * `parseSscc`, or its serial falls outside every block on record) --
   * `boxes.sscc` should never carry such a value given `buildSscc` is the
   * only thing that produces one, but this method has no reason to blow up
   * ingest over a value it can't attribute to a block.
   *
   * `executor` defaults to `this.db` but accepts a transaction handle too
   * (loosely typed, same as `PickupOrdersService.recordScanRejection`, so
   * both satisfy it): station-scans.service.ts's ingest MUST call this in
   * the SAME transaction as the box closure it derives the SSCC from, or a
   * rollback of one would leave the other applied.
   */
  async recordConsumedSerial(
    tenantId: string,
    sscc: string,
    executor: Pick<Db, "update"> = this.db,
  ): Promise<void> {
    const parsed = parseSscc(sscc, ISSUER_PREFIX_LENGTH);
    if (!parsed) return;

    await executor
      .update(schema.ssccBlocks)
      .set({
        consumedThroughSerial: sql`GREATEST(COALESCE(${schema.ssccBlocks.consumedThroughSerial}, -1), ${parsed.serial})`,
      })
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.issuerPrefix, parsed.gs1Prefix),
          eq(schema.ssccBlocks.extensionDigit, parsed.extensionDigit),
          lte(schema.ssccBlocks.fromSerial, parsed.serial),
          gte(schema.ssccBlocks.toSerial, parsed.serial),
        ),
      );
  }
}
