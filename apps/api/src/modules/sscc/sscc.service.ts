import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
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
      if (!GLN_PATTERN.test(cp.gln)) {
        throw new BadRequestException("sscc issuer counterparty's GLN must be exactly 13 digits");
      }
      return cp.gln.slice(0, 9);
    }

    const [profile] = await this.db
      .select({ gln: schema.orgProfiles.gln })
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, tenantId));
    if (!profile?.gln) throw new BadRequestException("organisation profile has no GLN");
    if (!GLN_PATTERN.test(profile.gln)) {
      throw new BadRequestException("organisation profile's GLN must be exactly 13 digits");
    }
    return profile.gln.slice(0, 9);
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
}
