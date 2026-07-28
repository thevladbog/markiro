import { randomInt } from "node:crypto";
import { Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { and, eq, gt, isNull, max, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { generateDeviceToken, hashDeviceToken } from "../../pickup/device-token";
import { PickupOrdersService } from "../pickup-orders/pickup-orders.service";
import type { PairKioskResultDto } from "../pickup-orders/dto";

const CODE_DIGITS = 8;
const TTL_MS = 15 * 60_000;
/** Bounded retries so a live-code hash collision can never be minted. */
const MINT_ATTEMPTS = 5;
/** Per-code attempt lockout: bounds brute force on the one unauthenticated kiosk route. */
const MAX_ATTEMPTS = 5;
/**
 * Per-source failure budget for the fixed window below. The per-code
 * counter above cannot bound guessing at all -- a wrong guess matches no
 * row, so nothing gets counted -- so this is the actual brute-force bound
 * on the one unauthenticated route in the system.
 */
const PAIR_ATTEMPT_BUDGET = 10;
/** Fixed window size for the per-source limiter; deliberately the same as the code TTL. */
const PAIR_ATTEMPT_WINDOW_MS = TTL_MS;

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
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly pickupOrdersService: PickupOrdersService,
  ) {}

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

  /**
   * Exchanges a plaintext code for a device credential plus the initial
   * dataset. Redemption is atomic: the row is claimed by a conditional
   * UPDATE, so two devices racing on the same code cannot both win.
   *
   * `source` is the caller's IP (or `"unknown"`), used ONLY for the
   * per-source rate limiter below -- it is never tenant-scoped, because the
   * caller has no tenant identity until redemption succeeds.
   */
  async redeem(code: string, source: string): Promise<PairKioskResultDto> {
    const now = new Date();
    const windowStart = this.pairAttemptWindowStart(now);
    // Checked BEFORE the code lookup: the per-code counter below cannot
    // bound guessing (a wrong guess matches no row), so this is the only
    // thing standing between the unauthenticated route and unbounded online
    // guessing across every tenant's live codes at once.
    await this.assertUnderPairRateLimit(source, windowStart);

    try {
      return await this.attemptRedeem(code, now);
    } catch (error) {
      // Every failed redemption counts against the source, whatever the
      // reason -- unknown code, dead code, exhausted per-code attempts, an
      // ambiguous cross-tenant hash collision, a lost claim race, or an
      // archived kiosk. Always the same 401; never a distinguishable 429,
      // which would tell an attacker they'd hit a real limiter.
      if (error instanceof UnauthorizedException) {
        await this.recordPairFailure(source, windowStart);
      }
      throw error;
    }
  }

  private async attemptRedeem(code: string, now: Date): Promise<PairKioskResultDto> {
    const codeHash = hashDeviceToken(code);
    const rows = await this.db
      .select()
      .from(schema.kioskPairingCodes)
      .where(eq(schema.kioskPairingCodes.codeHash, codeHash));

    const liveRows = rows.filter((r) => r.usedAt === null && r.expiresAt.getTime() > now.getTime());

    if (liveRows.length > 1) {
      // Two tenants can legitimately end up with the same code hash live at
      // once: `issueCode`'s clash check is SELECT-then-INSERT with no DB
      // constraint backing it. There is no way to tell which tenant the
      // presenting device belongs to, so refuse outright rather than
      // arbitrarily handing one tenant's device token and bootstrap to
      // another tenant's kiosk.
      throw new UnauthorizedException();
    }

    // A freshly minted code can legitimately collide with a dead
    // (used/expired) historical row sharing the same hash. Prefer the live
    // row so an operator's just-issued code is never shadowed by history.
    const candidate = liveRows[0] ?? rows[0];

    // A wrong code matches nothing — there is no row to count attempts on, so
    // the per-code lockout necessarily applies per issued code, exactly as
    // designed.
    if (!candidate) throw new UnauthorizedException();
    if (candidate.attempts >= MAX_ATTEMPTS) throw new UnauthorizedException();
    if (candidate.usedAt || candidate.expiresAt.getTime() <= now.getTime()) {
      await this.db
        .update(schema.kioskPairingCodes)
        .set({ attempts: candidate.attempts + 1 })
        .where(
          and(
            eq(schema.kioskPairingCodes.id, candidate.id),
            eq(schema.kioskPairingCodes.tenantId, candidate.tenantId),
          ),
        );
      throw new UnauthorizedException();
    }

    const { tenantId, kioskId } = candidate;
    const token = generateDeviceToken();
    const tokenHash = hashDeviceToken(token);

    // The claim, the kiosk's token write, and the deviceSeq read must commit
    // together: burning the code without successfully handing the kiosk a
    // token (or vice versa) would deauthenticate the previously paired
    // device while leaving the new one without a credential either.
    const { kiosk, nextDeviceSeq } = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(schema.kioskPairingCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(schema.kioskPairingCodes.id, candidate.id),
            isNull(schema.kioskPairingCodes.usedAt),
          ),
        )
        .returning({ id: schema.kioskPairingCodes.id });
      if (!claimed) throw new UnauthorizedException();

      const [kiosk] = await tx
        .update(schema.kiosks)
        .set({ deviceTokenHash: tokenHash })
        .where(
          and(
            eq(schema.kiosks.tenantId, tenantId),
            eq(schema.kiosks.id, kioskId),
            eq(schema.kiosks.status, "active"),
          ),
        )
        .returning({ name: schema.kiosks.name, location: schema.kiosks.location });
      if (!kiosk) throw new UnauthorizedException();

      const [seq] = await tx
        .select({ max: max(schema.pickupOrders.deviceSeq) })
        .from(schema.pickupOrders)
        .where(
          and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.kioskId, kioskId)),
        );

      return { kiosk, nextDeviceSeq: (seq?.max ?? -1) + 1 };
    });

    return {
      device: { kioskId, kioskName: kiosk.name, place: kiosk.location },
      token,
      nextDeviceSeq,
      bootstrap: await this.pickupOrdersService.bootstrap(tenantId, kioskId),
    };
  }

  /** Floors `now` to the start of its fixed window -- the unit the per-source limiter counts in. */
  private pairAttemptWindowStart(now: Date): Date {
    return new Date(Math.floor(now.getTime() / PAIR_ATTEMPT_WINDOW_MS) * PAIR_ATTEMPT_WINDOW_MS);
  }

  private async assertUnderPairRateLimit(source: string, windowStart: Date): Promise<void> {
    const [row] = await this.db
      .select({ failures: schema.kioskPairAttempts.failures })
      .from(schema.kioskPairAttempts)
      .where(
        and(
          eq(schema.kioskPairAttempts.source, source),
          eq(schema.kioskPairAttempts.windowStartedAt, windowStart),
        ),
      );
    if (row && row.failures >= PAIR_ATTEMPT_BUDGET) throw new UnauthorizedException();
  }

  private async recordPairFailure(source: string, windowStart: Date): Promise<void> {
    await this.db
      .insert(schema.kioskPairAttempts)
      .values({ source, windowStartedAt: windowStart, failures: 1 })
      .onConflictDoUpdate({
        target: [schema.kioskPairAttempts.source, schema.kioskPairAttempts.windowStartedAt],
        set: { failures: sql`${schema.kioskPairAttempts.failures} + 1` },
      });
  }

  private isOneLiveCodeViolation(error: unknown): boolean {
    const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; constraint?: string } | undefined;
    const errorCode = err?.code || cause?.code;
    const constraint = err?.constraint || cause?.constraint;
    return errorCode === "23505" && constraint === "kiosk_pairing_codes_one_live_uq";
  }
}
