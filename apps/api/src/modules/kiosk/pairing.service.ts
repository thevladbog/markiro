import { randomInt } from "node:crypto";
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
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
// Exported (not just `const`) so tests can assert against the real budget/
// window rather than duplicating these numbers as literals that could drift
// out of sync with the implementation.
export const PAIR_ATTEMPT_BUDGET = 10;
/**
 * Global backstop budget, keyed by the literal source `"*"`. Every attempt
 * counts toward it regardless of source, so it bounds guessing distributed
 * across many sources (rotated IPs, a botnet, ...) that would otherwise each
 * get their own fresh per-source budget. It is also the ONLY budget an
 * unattributable caller (empty `@Ip()`) can consume -- an unidentifiable
 * caller must never be able to exhaust a budget that identifiable callers
 * share.
 */
export const GLOBAL_PAIR_ATTEMPT_BUDGET = 400;
/** The reserved source key for the global backstop bucket above. */
export const GLOBAL_PAIR_SOURCE = "*";
/** Fixed window size for the limiter; deliberately the same as the code TTL. */
export const PAIR_ATTEMPT_WINDOW_MS = TTL_MS;

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
  private readonly logger = new Logger(PairingService.name);

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
    const result = await this.attemptRedeem(code, now);
    // Compensating decrement, reached only once `attemptRedeem` has fully
    // resolved -- i.e. only after its internal transaction committed. Any
    // throw above (wrong/expired/used/attempts-exhausted code, a lost claim
    // race, a rolled-back transaction) skips this line entirely and the
    // increment from `assertUnderPairRateLimit` stands. This nets the budget
    // back down to bounding failures, undoing the cost a successful
    // redemption itself charged -- see `recordPairAttempt` -- so a site
    // provisioning more than `PAIR_ATTEMPT_BUDGET` kiosks in one window
    // (every kiosk behind one NAT shares a source key) isn't capped by the
    // brute-force limiter on its own happy path. It cannot be gamed: reaching
    // it requires a valid, single-use, live code, exactly the thing the
    // limiter exists to ration guessing at.
    await this.refundPairAttempt(source, windowStart);
    return result;
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
   *
   * The per-source verdict is rendered, and can throw, BEFORE the global
   * counter is ever touched. That order is load-bearing: a caller that has
   * already exhausted its own per-source budget must be turned away without
   * charging the shared global bucket, or a single blocked source can keep
   * burning the global budget on every subsequent request while denied --
   * cheaply driving the global bucket past its own limit and taking down
   * pairing for every tenant, not just the one source that tripped it. An
   * unattributable source (empty/falsy) has no per-source bucket to trip, so
   * it falls straight through to the global check, unchanged from before.
   */
  private async assertUnderPairRateLimit(source: string, windowStart: Date): Promise<void> {
    if (source) {
      const sourceAttempts = await this.recordPairAttempt(normalizePairSource(source), windowStart);
      if (sourceAttempts > PAIR_ATTEMPT_BUDGET) {
        // A tripped budget is a security event (sustained guessing) AND,
        // for the global bucket, a platform-wide outage -- and previously
        // left zero server-side signal, with the on-site technician seeing
        // only a generic "invalid code". Never log the submitted code
        // itself; the HTTP response stays an unchanged generic 401 so the
        // caller can't learn which limit they hit.
        this.logger.warn(
          `kiosk pairing per-source budget exceeded: ${sourceAttempts} attempts in window`,
        );
        throw new UnauthorizedException();
      }
    }

    const globalAttempts = await this.recordPairAttempt(GLOBAL_PAIR_SOURCE, windowStart);
    if (globalAttempts > GLOBAL_PAIR_ATTEMPT_BUDGET) {
      this.logger.warn(
        `kiosk pairing global budget exceeded: ${globalAttempts} attempts in window`,
      );
      throw new UnauthorizedException();
    }
  }

  /**
   * Compensating decrement for a successful redemption -- see the call site
   * in `redeem` for why this exists and why it can't be gamed. Mirrors
   * `assertUnderPairRateLimit`'s source handling: the per-source bucket is
   * only touched when `source` is attributable, the global bucket always.
   */
  private async refundPairAttempt(source: string, windowStart: Date): Promise<void> {
    if (source) {
      await this.decrementPairAttempt(normalizePairSource(source), windowStart);
    }
    await this.decrementPairAttempt(GLOBAL_PAIR_SOURCE, windowStart);
  }

  /**
   * Atomically decrements `(source, windowStart)`, floored at zero
   * (`GREATEST(failures - 1, 0)`) so a refund can never push the counter
   * negative regardless of ordering with a concurrent increment. Only ever
   * called for a `(source, windowStart)` pair that `recordPairAttempt`
   * already inserted earlier in the same request, so a plain UPDATE (no
   * upsert) is sufficient -- there is nothing to refund if the row doesn't
   * exist, and it always does by this point.
   */
  private async decrementPairAttempt(source: string, windowStart: Date): Promise<void> {
    await this.db
      .update(schema.kioskPairAttempts)
      .set({ failures: sql`GREATEST(${schema.kioskPairAttempts.failures} - 1, 0)` })
      .where(
        and(
          eq(schema.kioskPairAttempts.source, source),
          eq(schema.kioskPairAttempts.windowStartedAt, windowStart),
        ),
      );
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
   * The `failures` column name is unchanged (no new migration needed). It
   * counts every attempt through this path up front, a successful redemption
   * included -- `redeem` issues a compensating `decrementPairAttempt` once a
   * redemption actually succeeds (see there), so the column's steady-state
   * value bounds net failures again: a site provisioning many kiosks behind
   * one NAT nets back down to ~0 as each one pairs, while a run of wrong
   * guesses stays charged.
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
