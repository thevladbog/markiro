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
import { PairAttemptsService } from "../device-pairing/pair-attempts.service";
import {
  PAIR_CODE_MAX_ATTEMPTS,
  PAIRING_TTL_MS,
  mintPairingCode,
  pairAttemptWindowStart,
} from "../device-pairing/pairing-policy";

/** Bounded retries so a live-code hash collision can never be minted. */
const MINT_ATTEMPTS = 5;

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
    private readonly pairAttemptsService: PairAttemptsService,
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

    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    const pepper = loadEnv().PAIRING_CODE_PEPPER;
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      const code = mintPairingCode();
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
    const windowStart = pairAttemptWindowStart(now);
    // Record-then-check, atomically, BEFORE the code lookup: the per-code
    // counter below cannot bound guessing at all (a wrong guess matches no
    // row), so this is the only thing standing between the unauthenticated
    // route and unbounded online guessing across every tenant's live codes
    // at once. Every attempt is counted here, success or failure -- see
    // `assertUnderPairRateLimit` -- which closes a concurrency race a
    // check-then-record shape would leave open: N concurrent callers could
    // otherwise all read the same pre-increment count and all pass.
    await this.pairAttemptsService.assertUnderPairRateLimit(source, windowStart);
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
    await this.pairAttemptsService
      .refundPairAttempt(source, windowStart)
      .catch((error: unknown) => {
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
    if (candidate.attempts >= PAIR_CODE_MAX_ATTEMPTS) throw new UnauthorizedException();
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
