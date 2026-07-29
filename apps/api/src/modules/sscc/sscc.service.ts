import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";

/** Boxes take extension digit 0; 1 is reserved for pallets (06d). */
export const BOX_EXTENSION_DIGIT = 0;

export interface SsccBlock {
  issuerPrefix: string;
  extensionDigit: number;
  fromSerial: number;
  toSerial: number;
}

/** A GS1 GLN is always exactly 13 digits; the issuer prefix is its first 9. */
const GLN_PATTERN = /^\d{13}$/;

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
  async resolveIssuerPrefix(tenantId: string, shiftId: string): Promise<string> {
    const [shift] = await this.db
      .select({ issuer: schema.shifts.ssccIssuerCounterpartyId })
      .from(schema.shifts)
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)));
    if (!shift) throw new BadRequestException("shift not found");

    if (shift.issuer) {
      const [cp] = await this.db
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

    const [profile] = await this.db
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
   */
  async allocate(
    tenantId: string,
    issuerPrefix: string,
    extensionDigit: number,
    deviceId: string,
    size: number,
  ): Promise<SsccBlock> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.ssccCounters)
        .values({ tenantId, issuerPrefix, extensionDigit, nextSerial: size })
        .onConflictDoUpdate({
          target: [
            schema.ssccCounters.tenantId,
            schema.ssccCounters.issuerPrefix,
            schema.ssccCounters.extensionDigit,
          ],
          set: {
            nextSerial: sql`${schema.ssccCounters.nextSerial} + ${size}`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ next: schema.ssccCounters.nextSerial });

      if (!row) throw new InternalServerErrorException("Failed to allocate sscc block");
      const toExclusive = Number(row.next);
      const block: SsccBlock = {
        issuerPrefix,
        extensionDigit,
        fromSerial: toExclusive - size,
        toSerial: toExclusive - 1,
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
    });
  }

  /**
   * The bundle's entry point into allocation (Task 7 review, finding 3):
   * cuts a fresh block only the FIRST time this device is seen for this
   * (tenant, issuer prefix, extension digit) triple; every later call for
   * the same triple hands back the block it already holds instead.
   *
   * The bundle is not a top-up channel. The station re-downloads it on
   * every shift entry, re-entry and app restart, and nothing else caps how
   * often that happens -- if each fetch cut a fresh 2000-serial block, a
   * device would work through a 10-million-serial number space in about
   * 5000 fetches, mid-shift, with `buildSscc` then throwing SSCC_RANGE on
   * the factory floor. The bundle's actual job is narrower: guarantee a
   * device numbers for an issuer it has NEVER held. A device already
   * running low on its existing block gets topped up through the sync
   * response instead (a later task) -- deliberately NOT here, so this
   * method never even looks at how many serials of the existing block are
   * left, only whether one exists at all.
   *
   * A repeat call deliberately returns the device's EXISTING block rather
   * than signalling "nothing to do": the device may have lost its local
   * database (a factory reset, a corrupted store) and be re-provisioning
   * from scratch, in which case the range it already holds server-side is
   * exactly what it needs handed back, not withheld.
   */
  async allocateForBundle(
    tenantId: string,
    issuerPrefix: string,
    extensionDigit: number,
    deviceId: string,
    size: number,
  ): Promise<SsccBlock> {
    const [existing] = await this.db
      .select({
        issuerPrefix: schema.ssccBlocks.issuerPrefix,
        extensionDigit: schema.ssccBlocks.extensionDigit,
        fromSerial: schema.ssccBlocks.fromSerial,
        toSerial: schema.ssccBlocks.toSerial,
      })
      .from(schema.ssccBlocks)
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.issuerPrefix, issuerPrefix),
          eq(schema.ssccBlocks.extensionDigit, extensionDigit),
          eq(schema.ssccBlocks.deviceId, deviceId),
        ),
      )
      .orderBy(desc(schema.ssccBlocks.issuedAt))
      .limit(1);

    if (existing) return existing;
    return this.allocate(tenantId, issuerPrefix, extensionDigit, deviceId, size);
  }
}
