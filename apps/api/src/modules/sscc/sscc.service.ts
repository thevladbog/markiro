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
  issuerGln: string;
  extensionDigit: number;
  fromSerial: number;
  toSerial: number;
}

@Injectable()
export class SsccService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Whose numbers this shift's boxes carry.
   *
   * `ssccIssuerCounterpartyId` is an explicit choice, not `counterpartyId`:
   * that field says who the goods are for, this one says whose numbers they
   * carry, and packing for a client under one's own SSCCs is ordinary.
   */
  async resolveIssuerGln(tenantId: string, shiftId: string): Promise<string> {
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
      return cp.gln;
    }

    const [profile] = await this.db
      .select({ gln: schema.orgProfiles.gln })
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, tenantId));
    if (!profile?.gln) throw new BadRequestException("organisation profile has no GLN");
    return profile.gln;
  }

  /**
   * Reserves `size` serials in ONE statement.
   *
   * A read followed by a write would eventually hand two devices overlapping
   * ranges, and an overlapping range is indistinguishable from a duplicate
   * box. The upsert both creates the counter on first use and advances an
   * existing one, returning the value it advanced FROM.
   */
  async allocate(
    tenantId: string,
    issuerGln: string,
    extensionDigit: number,
    deviceId: string,
    size: number,
  ): Promise<SsccBlock> {
    const [row] = await this.db
      .insert(schema.ssccCounters)
      .values({ tenantId, issuerGln, extensionDigit, nextSerial: size })
      .onConflictDoUpdate({
        target: [
          schema.ssccCounters.tenantId,
          schema.ssccCounters.issuerGln,
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
      issuerGln,
      extensionDigit,
      fromSerial: toExclusive - size,
      toSerial: toExclusive - 1,
    };

    await this.db.insert(schema.ssccBlocks).values({
      tenantId,
      issuerGln,
      extensionDigit,
      deviceId,
      fromSerial: block.fromSerial,
      toSerial: block.toSerial,
    });

    return block;
  }
}
