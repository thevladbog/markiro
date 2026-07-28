import { randomInt } from "node:crypto";
import { Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { and, eq, gt, isNull, max, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { generateDeviceToken, hashDeviceToken } from "../../pickup/device-token";
import { PickupOrdersService } from "../pickup-orders/pickup-orders.service";
import type { PairKioskResultDto } from "../pickup-orders/dto";
import { normalizePairSource } from "./pair-source";

const CODE_DIGITS = 8;
const TTL_MS = 15 * 60_000;
/** Bounded retries so a live-code hash collision can never be minted. */
const MINT_ATTEMPTS = 5;
/** Per-code attempt lockout: bounds brute force on the one unauthenticated kiosk route. */
const MAX_ATTEMPTS = 5;
/**
 * Per-source attempt budget for the fixed window below. The per-code
 * counter above cannot bound guessing at all -- a wrong guess matches no
 * row, so nothing gets counted -- so this is the actual brute-force bound
 * on the one unauthenticated route in the system.
 */
const PAIR_ATTEMPT_BUDGET = 10;
/**
 * Global backstop budget, keyed by the literal source `"*"`. Every attempt
 * counts toward it regardless of source, so it bounds guessing distributed
 * across many sources (rotated IPs, a botnet, ...) that would otherwise each
 * get their own fresh per-source budget. It is also the ONLY budget an
 * unattributable caller (empty `@Ip()`) can consume -- an unidentifiable
 * caller must never be able to exhaust a budget that identifiable callers
 * share.
 */
const GLOBAL_PAIR_ATTEMPT_BUDGET = 400;
/** The reserved source key for the global backstop bucket above. */
const GLOBAL_PAIR_SOURCE = "*";
/** Fixed window size for the limiter; deliberately the same as the code TTL. */
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
   * `source` is the caller's resolved IP, or `""` when unattributable (e.g.
   * an empty `@Ip()` behind some proxies/test clients) -- used ONLY for the
   * rate limiter below, never tenant-scoped, because the caller has no
   * tenant identity until redemption succeeds.
   */
  async redeem(code: string, source: string): Promise<PairKioskResultDto> {
    const now = new Date();
    const windowStart = this.pairAttemptWindowStart(now);
    // Record-then-check, atomically, BEFORE the code lookup: the per-code
    // counter below cannot bound guessing at all (a wrong guess matches no
    // row), so this is the only thing standing between the unauthenticated
    // route and unbounded online guessing across every tenant's live codes
    // at once. Every attempt is counted here, success or failure -- see
    // `assertUnderPairRateLimit` -- which closes a concurrency race a
    // check-then-record shape would leave open: N concurrent callers could
    // otherwise all read the same pre-increment count and all pass.
    await this.assertUnderPairRateLimit(source, windowStart);
    return this.attemptRedeem(code, now);
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

    // Computed BEFORE the transaction below, and the transaction is the last
    // thing this method does. `bootstrap` only reads plus idempotently
    // backfills a badge salt, so paying its cost for an attempt that then
    // fails to claim the code (transaction rolls back, nothing committed) is
    // free. Computing it AFTER commit, as before, meant a throw here would
    // strand a redemption: the code already spent and `device_token_hash`
    // already replaced, but the caller gets a 500 and no token back -- the
    // previously paired device deauthenticated and the new one never
    // credentialed either.
    const bootstrap = await this.pickupOrdersService.bootstrap(tenantId, kioskId);

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
            // Re-assert expiry at claim time, symmetric with the usedAt
            // re-check above: `now` was captured before this transaction
            // started, so a code that expired in the interim must not be
            // claimable just because it was still live when first read.
            gt(schema.kioskPairingCodes.expiresAt, now),
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
      bootstrap,
    };
  }

  /** Floors `now` to the start of its fixed window -- the unit the limiter counts in. */
  private pairAttemptWindowStart(now: Date): Date {
    return new Date(Math.floor(now.getTime() / PAIR_ATTEMPT_WINDOW_MS) * PAIR_ATTEMPT_WINDOW_MS);
  }

  /**
   * Two budgets, both consumed by every attempt through this route -- see
   * `recordPairAttempt` for why it counts attempts rather than only
   * failures:
   *  - per-source (`PAIR_ATTEMPT_BUDGET`): bounds one identifiable caller's
   *    guessing. Skipped entirely when `source` is unattributable (empty
   *    `@Ip()`), so an unidentifiable caller can never consume a budget that
   *    identifiable callers share.
   *  - global backstop (`GLOBAL_PAIR_ATTEMPT_BUDGET`, key `"*"`): bounds
   *    guessing distributed across many sources, and is the only budget an
   *    unattributable caller can consume.
   * Both counters are recorded before the code lookup in `attemptRedeem`
   * ever runs.
   */
  private async assertUnderPairRateLimit(source: string, windowStart: Date): Promise<void> {
    let sourceAttempts = 0;
    if (source) {
      sourceAttempts = await this.recordPairAttempt(normalizePairSource(source), windowStart);
    }
    const globalAttempts = await this.recordPairAttempt(GLOBAL_PAIR_SOURCE, windowStart);

    if (source && sourceAttempts > PAIR_ATTEMPT_BUDGET) throw new UnauthorizedException();
    if (globalAttempts > GLOBAL_PAIR_ATTEMPT_BUDGET) throw new UnauthorizedException();
  }

  /**
   * Atomically records one attempt against `(source, windowStart)` and
   * returns the post-increment count, in a single upsert -- record-then-check,
   * not check-then-record. The previous shape ran a SELECT, decided, and only
   * then wrote an INSERT/UPDATE afterward; N concurrent callers could all
   * read the same pre-increment count and all pass, landing the counter at
   * `count + N` instead of bounding it. `RETURNING` closes that race by
   * making the increment and the value used to decide in the same statement.
   *
   * The `failures` column name is unchanged (no new migration needed), but
   * as of this fix it counts every attempt through this path -- a successful
   * redemption included -- not only failed ones; that is intended at these
   * budget sizes.
   */
  private async recordPairAttempt(source: string, windowStart: Date): Promise<number> {
    const [row] = await this.db
      .insert(schema.kioskPairAttempts)
      .values({ source, windowStartedAt: windowStart, failures: 1 })
      .onConflictDoUpdate({
        target: [schema.kioskPairAttempts.source, schema.kioskPairAttempts.windowStartedAt],
        set: { failures: sql`${schema.kioskPairAttempts.failures} + 1` },
      })
      .returning({ failures: schema.kioskPairAttempts.failures });
    return row!.failures;
  }

  private isOneLiveCodeViolation(error: unknown): boolean {
    const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; constraint?: string } | undefined;
    const errorCode = err?.code || cause?.code;
    const constraint = err?.constraint || cause?.constraint;
    return errorCode === "23505" && constraint === "kiosk_pairing_codes_one_live_uq";
  }
}
