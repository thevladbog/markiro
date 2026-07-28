import { randomInt } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { hashDeviceToken } from "../../pickup/device-token";

const CODE_DIGITS = 8;
const TTL_MS = 15 * 60_000;
/** Bounded retries so a live-code hash collision can never be minted. */
const MINT_ATTEMPTS = 5;

// `hashDeviceToken` is a plain sha256, which an attacker holding a DB dump
// could brute-force over the 10^8 code space. That is acceptable here and
// deliberately not PBKDF2: the value is single-use, expires in 15 minutes,
// and the exchange must stay a single indexed hash probe for a device that
// has no credential yet. It is not a password.

export interface IssuePairingCodeResultDto {
  code: string;
  expiresAt: Date;
}

@Injectable()
export class PairingService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * A single-use 8-digit code for `kioskId`. Only its hash is stored; the
   * plaintext is returned exactly once for the cabinet's reveal. Issuing a new
   * code retires any code still live for that kiosk.
   */
  async issueCode(tenantId: string, kioskId: string): Promise<IssuePairingCodeResultDto> {
    const [kiosk] = await this.db
      .select({ id: schema.kiosks.id })
      .from(schema.kiosks)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId)));
    if (!kiosk) throw new NotFoundException();

    // Retire the kiosk's live codes first: a device must never face two
    // valid codes, and the cabinet only ever shows the newest.
    await this.db
      .update(schema.kioskPairingCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.kioskPairingCodes.tenantId, tenantId),
          eq(schema.kioskPairingCodes.kioskId, kioskId),
          isNull(schema.kioskPairingCodes.usedAt),
        ),
      );

    const expiresAt = new Date(Date.now() + TTL_MS);
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
      const codeHash = hashDeviceToken(code);
      // The exchange looks a device up by hash alone, so a hash shared by two
      // simultaneously-live codes would be ambiguous. Mint a different one.
      const [clash] = await this.db
        .select({ id: schema.kioskPairingCodes.id })
        .from(schema.kioskPairingCodes)
        .where(
          and(
            eq(schema.kioskPairingCodes.codeHash, codeHash),
            isNull(schema.kioskPairingCodes.usedAt),
            gt(schema.kioskPairingCodes.expiresAt, new Date()),
          ),
        );
      if (clash) continue;

      try {
        await this.db
          .insert(schema.kioskPairingCodes)
          .values({ tenantId, kioskId, codeHash, expiresAt });
      } catch (error) {
        if (!this.isOneLiveCodeViolation(error)) throw error;
        // A concurrent caller inserted its own live code between our retire
        // UPDATE and our INSERT. Retire it too, then retry the insert once --
        // if it still fails, propagate rather than loop indefinitely.
        await this.db
          .update(schema.kioskPairingCodes)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(schema.kioskPairingCodes.tenantId, tenantId),
              eq(schema.kioskPairingCodes.kioskId, kioskId),
              isNull(schema.kioskPairingCodes.usedAt),
            ),
          );
        await this.db
          .insert(schema.kioskPairingCodes)
          .values({ tenantId, kioskId, codeHash, expiresAt });
      }
      return { code, expiresAt };
    }
    throw new Error("Could not mint a unique pairing code");
  }

  private isOneLiveCodeViolation(error: unknown): boolean {
    const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; constraint?: string } | undefined;
    const errorCode = err?.code || cause?.code;
    const constraint = err?.constraint || cause?.constraint;
    return errorCode === "23505" && constraint === "kiosk_pairing_codes_one_live_uq";
  }
}
