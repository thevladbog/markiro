import { randomInt } from "node:crypto";
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, asc, desc, eq, gt, isNull, max, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { loadEnv } from "../../env";
import { generateDeviceToken, hashDeviceToken, hashPairingCode } from "../../pickup/device-token";
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

// The pairing code is hashed with `hashPairingCode` (HMAC-SHA256 keyed by
// the server-held `PAIRING_CODE_PEPPER`), never `hashDeviceToken`'s plain
// sha256: an unkeyed digest over the 10^8 code space is trivially
// brute-forceable offline from a DB dump, which would let a leak recover
// every still-live code and redeem it directly, bypassing the HTTP rate
// limiter entirely. Deliberately not PBKDF2/bcrypt beyond that, though: the
// value is single-use, expires in 15 minutes, and the exchange must stay a
// single indexed hash probe for a device that has no credential yet. It is
// not a password.

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
    // Restricted to an active kiosk, mirroring `attemptRedeem`'s own
    // `status = 'active'` guard on the exchange: an archived kiosk can never
    // redeem a code, so issuing one would show the cabinet a code that is
    // guaranteed to come back as a generic 401 with no way to tell why. A 404
    // here matches how the rest of this service treats a kiosk it will not
    // act on.
    const [kiosk] = await this.db
      .select({ id: schema.kiosks.id })
      .from(schema.kiosks)
      .where(
        and(
          eq(schema.kiosks.tenantId, tenantId),
          eq(schema.kiosks.id, kioskId),
          eq(schema.kiosks.status, "active"),
        ),
      );
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
    const pepper = loadEnv().PAIRING_CODE_PEPPER;
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
      const codeHash = hashPairingCode(code, pepper);
      // The exchange looks a device up by hash alone, so a hash shared by two
      // simultaneously-live codes would be ambiguous. Mint a different one.
      // This is a best-effort SELECT-then-INSERT check with its own race
      // window (closed for real by `kiosk_pairing_codes_code_hash_live_uq`
      // below, a partial unique index on `code_hash WHERE used_at is null`) --
      // kept because it avoids paying for that race on the common,
      // non-colliding path.
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
        if (this.isHashCollision(error)) continue; // another live code (any tenant) already has this hash -- mint a different one
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
        try {
          await this.db
            .insert(schema.kioskPairingCodes)
            .values({ tenantId, kioskId, codeHash, expiresAt });
        } catch (retryError) {
          if (this.isHashCollision(retryError)) continue;
          throw retryError;
        }
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
    //
    // `.catch()`ed rather than awaited plain: this is bookkeeping AFTER a
    // redemption has already committed (the code is spent, the kiosk's
    // `device_token_hash` already replaced). If this UPDATE throws, the
    // caller must still get its token back -- the alternative (letting the
    // throw propagate) would give the caller a 500 while stranding the
    // redemption exactly the way moving `bootstrap` before the transaction,
    // above, was meant to prevent. The worst case of a swallowed refund is
    // one unit of budget not returned.
    await this.refundPairAttempt(source, windowStart).catch((error: unknown) => {
      this.logger.warn(
        `kiosk pairing refund failed after a committed redemption (budget not returned): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return result;
  }

  private async attemptRedeem(code: string, now: Date): Promise<PairKioskResultDto> {
    const codeHash = hashPairingCode(code, loadEnv().PAIRING_CODE_PEPPER);
    const rows = await this.db
      .select()
      .from(schema.kioskPairingCodes)
      .where(eq(schema.kioskPairingCodes.codeHash, codeHash))
      // Deterministic order so that, when only dead rows share this hash
      // (see `candidate` below), which row's `attempts` gets bumped is
      // stable rather than whatever order Postgres happens to return --
      // that row can belong to another tenant, so a non-deterministic pick
      // would be a non-deterministic cross-tenant write.
      .orderBy(desc(schema.kioskPairingCodes.createdAt), asc(schema.kioskPairingCodes.id));

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
            // re-check above -- but against the DATABASE's clock, not the
            // JS `now` captured at the top of `redeem`: `bootstrap()` above
            // runs between that capture and this statement and can take
            // seconds on a large tenant (badge re-hashing), so a code that
            // expires during bootstrap must not still be claimable just
            // because it was live when `now` was captured.
            gt(schema.kioskPairingCodes.expiresAt, sql`now()`),
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

      // Lock the kiosk row before computing nextDeviceSeq. The previously
      // paired device can be past `KioskDeviceGuard` and still mid-flight,
      // inserting its own order, when this re-pair runs -- `createFromKiosk`
      // (`insertOrderWithRetry` in pickup-orders.service.ts) takes this SAME
      // row lock before it inserts, so the two paths can never interleave
      // around this read. That makes the MAX below unable to miss an order
      // that is already committing: whichever of the two transactions asks
      // for the lock first now runs to completion before the other
      // proceeds, instead of the MAX read racing a commit that lands right
      // after it -- which, since (tenant, kiosk, deviceSeq) is the order
      // idempotency key, would otherwise hand this replacement device a
      // deviceSeq the late order already used and silently discard its
      // first genuine order as a false replay. Scoped to just this one row,
      // for only the remainder of this transaction.
      await tx
        .select({ id: schema.kiosks.id })
        .from(schema.kiosks)
        .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId)))
        .for("update");

      const [orderSeq] = await tx
        .select({ max: max(schema.pickupOrders.deviceSeq) })
        .from(schema.pickupOrders)
        .where(
          and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.kioskId, kioskId)),
        );

      // Rejections share the order idempotency key space but create no
      // order, so a MAX over orders alone would hand this device a seq a
      // rejection already spent -- and its next rejection would be dropped
      // as a replay. This read rides the kiosk row lock taken above; the
      // rejection INSERT deliberately does not take that lock, so an
      // in-flight one can still land after this read. That residual race
      // costs at most one missing journal row, whereas for orders the same
      // race would lose an order -- which is what the lock is there for.
      const [rejectionSeq] = await tx
        .select({ max: max(schema.pickupScanRejections.deviceSeq) })
        .from(schema.pickupScanRejections)
        .where(
          and(
            eq(schema.pickupScanRejections.tenantId, tenantId),
            eq(schema.pickupScanRejections.kioskId, kioskId),
          ),
        );

      const highest = Math.max(orderSeq?.max ?? -1, rejectionSeq?.max ?? -1);
      return { kiosk, nextDeviceSeq: highest + 1 };
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
   *
   * Symmetrically, a read-only pre-check runs FIRST, before either budget is
   * touched: once the global budget is already exhausted, a request from a
   * source that has never been seen before must still be turned away
   * WITHOUT allocating it a fresh `kiosk_pair_attempts` row. Without this, an
   * attacker rotating sources (exactly the distributed case the global
   * backstop exists to bound) grows the table without bound and keeps
   * writing to the DB long after pairing is already globally locked out. This
   * pre-check is a plain SELECT specifically so it never itself allocates a
   * row; it only needs to be conservative (skip when in doubt), not exact --
   * the atomic `RETURNING` increment below is still what actually decides
   * and charges a genuine transition past the budget, so a concurrent race
   * straddling the limit is still resolved correctly there.
   */
  private async assertUnderPairRateLimit(source: string, windowStart: Date): Promise<void> {
    const globalSoFar = await this.currentPairAttempts(GLOBAL_PAIR_SOURCE, windowStart);
    if (globalSoFar > GLOBAL_PAIR_ATTEMPT_BUDGET) {
      throw new UnauthorizedException();
    }

    if (source) {
      const normalizedSource = normalizePairSource(source);
      const sourceAttempts = await this.recordPairAttempt(normalizedSource, windowStart);
      if (sourceAttempts > PAIR_ATTEMPT_BUDGET) {
        // A tripped budget is a security event (sustained guessing) AND,
        // for the global bucket, a platform-wide outage -- and previously
        // left zero server-side signal, with the on-site technician seeing
        // only a generic "invalid code". Never log the submitted code
        // itself; the HTTP response stays an unchanged generic 401 so the
        // caller can't learn which limit they hit.
        //
        // Logged only on the transition past the budget (count === budget +
        // 1), so it fires exactly once per source per window -- this route
        // is unauthenticated, so logging every rejected request would let
        // sustained abuse turn request volume straight into unbounded log
        // volume. The normalised source key (never the raw submitted code)
        // is included so this line can drive an alert.
        if (sourceAttempts === PAIR_ATTEMPT_BUDGET + 1) {
          this.logger.warn(
            `kiosk pairing per-source budget exceeded for source ${normalizedSource}: ${sourceAttempts} attempts in window`,
          );
        }
        throw new UnauthorizedException();
      }
    }

    const globalAttempts = await this.recordPairAttempt(GLOBAL_PAIR_SOURCE, windowStart);
    if (globalAttempts > GLOBAL_PAIR_ATTEMPT_BUDGET) {
      // Same transition-only logging as the per-source branch above.
      if (globalAttempts === GLOBAL_PAIR_ATTEMPT_BUDGET + 1) {
        this.logger.warn(
          `kiosk pairing global budget exceeded: ${globalAttempts} attempts in window`,
        );
      }
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
   * Read-only lookup of the current `failures` count for `(source,
   * windowStart)` -- no write, unlike `recordPairAttempt`. Used only for the
   * global pre-check in `assertUnderPairRateLimit` above, so an already-
   * exhausted global budget can be detected and turned away without
   * allocating a row for a source seen for the first time. Zero when no row
   * exists yet for this window (nothing recorded, so nothing to bound).
   */
  private async currentPairAttempts(source: string, windowStart: Date): Promise<number> {
    const [row] = await this.db
      .select({ failures: schema.kioskPairAttempts.failures })
      .from(schema.kioskPairAttempts)
      .where(
        and(
          eq(schema.kioskPairAttempts.source, source),
          eq(schema.kioskPairAttempts.windowStartedAt, windowStart),
        ),
      );
    return row?.failures ?? 0;
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

  /**
   * 23505 on `kiosk_pairing_codes_code_hash_live_uq` -- the DB-enforced
   * backstop for the SELECT-then-INSERT clash check above: another live code
   * (this kiosk's retried insert above, or any other tenant's) already has
   * this exact hash. Bounded by the same `MINT_ATTEMPTS` loop as an ordinary
   * clash, never surfaced to the caller -- a hash collision must re-mint, not
   * fail the whole issuance.
   */
  private isHashCollision(error: unknown): boolean {
    const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; constraint?: string } | undefined;
    const errorCode = err?.code || cause?.code;
    const constraint = err?.constraint || cause?.constraint;
    return errorCode === "23505" && constraint === "kiosk_pairing_codes_code_hash_live_uq";
  }
}
