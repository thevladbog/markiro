import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { kmHash, parseKm } from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import { JournalService } from "../integrations/journal.service";
import { CHZ_CHANNEL_TYPE } from "../signer-agents/chz-constants";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import { ChzOmsTokenService, type ChzOmsTokenResult } from "./chz-oms-token.service";
import { OmsClient } from "./oms.client";
import type { OmsAuth, OmsCodesBlock } from "./oms.types";

type OrderRow = typeof schema.chzKmOrders.$inferSelect;
type ActiveOmsToken = Extract<ChzOmsTokenResult, { status: "ok" }>;

export const MAX_SIGN_ATTEMPTS = 5;
export const CODES_BLOCK_SIZE = 10_000;
/**
 * How many code-bearing СУЗ calls (`GET /codes` plus the reconciliation's
 * `retryBlock`) one pass may make before handing the rest to its successor.
 *
 * The cap exists because the pass has to end inside its pg-boss lease
 * (`expireInSeconds: 900` on `run-chz-km-order`). An expired lease makes the
 * job runnable again while the original handler is still working, and two
 * passes drawing from the same buffer is exactly what costs codes: the loser
 * of the `fetched_count` fence rolls back codes СУЗ has already billed, and a
 * closed sub-order can no longer re-list them. Without a cap a 150 000-code
 * order is fifteen sequential `GET /codes` calls in one pass, each with the
 * client's own 120-second timeout -- 1800 seconds of network ceiling alone,
 * twice the lease.
 *
 * Four is that ceiling divided by the worst case a pass can face:
 * 2 x `listBlocks` at the 15-second timeout (the start-of-pass reconcile and
 * the before-final-block one) + 4 x 120 seconds of code calls = 510 seconds,
 * leaving 390 of the 900 for the transactional inserts of up to four
 * 10 000-row blocks and their round trips. Five would leave 270 and six only
 * 150, less than a comfortable margin for a single block's insert. A capped
 * pass returns `finished: false`, so the existing re-enqueue chain resumes it
 * 30 seconds later -- fifteen blocks cost four passes and two minutes, well
 * inside the order's 48-hour deadline.
 */
export const MAX_CODE_BLOCKS_PER_PASS = 4;
const ERROR_MESSAGE_LIMIT = 500;
const SIGN_WAIT_SECONDS = 30;
const BUFFER_POLL_SECONDS = 30;
const BUFFER_POLL_SLOW_SECONDS = 300;
const TOKEN_WAIT_SECONDS = 300;
const SLOW_POLL_AFTER_PASSES = 10;

export const CHZ_KM_ORDER_SAFE_ERROR_CODES = [
  "CHZ_OMS_SETTINGS_MISSING",
  "CHZ_OMS_TOKEN_UNAVAILABLE",
  "CHZ_SIGNING_FAILED",
  "CHZ_ORDER_REJECTED_BY_SUZ",
  "CHZ_ORDER_SUBMIT_UNRECORDED",
  "CHZ_ORDER_TIMED_OUT",
  "CHZ_CODES_UNPARSEABLE",
  "CHZ_CODES_DUPLICATE",
  "CHZ_CODES_INCOMPLETE",
  "CHZ_CODES_OVERDELIVERED",
  "CHZ_JOB_RETRIES_EXHAUSTED",
] as const;
export type ChzKmOrderSafeErrorCode = (typeof CHZ_KM_ORDER_SAFE_ERROR_CODES)[number];

export interface AttemptContext {
  retryCount: number;
  retryLimit: number;
}
export interface RunOutcome {
  finished: boolean;
  retryAfterSeconds: number;
}

/**
 * The one TypeScript definition of "this order will never move again", shared
 * by the runner's own guards, by `fail()`'s conditional `UPDATE` and by the
 * boot sweep in `JobsModule`. The database keeps its own copies -- the
 * `chz_km_orders_unfinished_idx` predicate in `packages/db/src/schema/chz.ts`
 * -- because changing an index predicate needs a migration, not an import.
 */
export const CHZ_KM_ORDER_TERMINAL_STATES = ["completed", "rejected", "failed"] as const;

const TERMINAL = new Set<OrderRow["state"]>(CHZ_KM_ORDER_TERMINAL_STATES);

/**
 * One pass over one КМ order: sign it, submit it to СУЗ, poll the code
 * buffer, and fetch every code once the buffer is active. Every step writes
 * its outcome to `chz_km_orders`/`chz_km_codes` before returning, so a pass
 * that dies mid-way is resumed -- never restarted from a blank slate -- by
 * the next one.
 *
 * `finished` tells the caller (the pg-boss job, Task 10) whether to
 * re-enqueue itself after `retryAfterSeconds`. The deadline check runs
 * before anything else that could return early -- in particular before the
 * token gate -- because it needs only `deadlineAt`, not a token or a
 * network call: it is what stops an order for a tenant whose signer agent
 * never comes back from being an immortal job.
 */
@Injectable()
export class ChzKmOrderRunnerService {
  private readonly logger = new Logger(ChzKmOrderRunnerService.name);
  /** Overridable in tests to exercise multi-block fetching with small orders. */
  blockSize = CODES_BLOCK_SIZE;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: ChzOmsTokenService,
    private readonly client: OmsClient,
    private readonly crypto: ChzCryptoService,
    private readonly journal: JournalService,
  ) {}

  async run(tenantId: string, orderId: string, attempt: AttemptContext): Promise<RunOutcome> {
    let order = await this.load(tenantId, orderId);
    if (!order || TERMINAL.has(order.state)) return { finished: true, retryAfterSeconds: 0 };
    // Deadline first, before the token: an order for a tenant whose agent
    // never returns must still end, and this check costs neither a token
    // lookup nor a request.
    if (order.deadlineAt.getTime() < Date.now()) {
      await this.fail(order, "CHZ_ORDER_TIMED_OUT", null);
      return { finished: true, retryAfterSeconds: 0 };
    }
    if (order.state === "created") return this.startSigning(order);
    if (order.state === "signing") return this.finishSigning(order, attempt);

    const token = await this.requireToken(order, attempt);
    if (token.status !== "ok") return token.outcome;

    try {
      if (order.state === "submitted" || order.state === "buffer_pending") {
        order = await this.pollBuffer(order, token.auth);
        if (!order || order.state !== "buffer_active") {
          return {
            finished: order ? TERMINAL.has(order.state) : true,
            retryAfterSeconds:
              attempt.retryCount >= SLOW_POLL_AFTER_PASSES
                ? BUFFER_POLL_SLOW_SECONDS
                : BUFFER_POLL_SECONDS,
          };
        }
      }
      if (order.state === "buffer_active" || order.state === "fetching") {
        order = await this.fetchCodes(order, token.auth);
      }
    } catch (error) {
      if (!(error instanceof OmsUnauthorizedError)) throw error;
      await this.tokens.invalidateAndRequestRefresh(tenantId, token.obtainedAt);
      return { finished: false, retryAfterSeconds: TOKEN_WAIT_SECONDS };
    }
    return {
      finished: order ? TERMINAL.has(order.state) : true,
      retryAfterSeconds: BUFFER_POLL_SECONDS,
    };
  }

  /**
   * The one place that decides what a non-`ok` token status means. An
   * unconfigured or rotated encryption key and missing СУЗ settings are
   * operator work that no amount of waiting resolves, so they end the order
   * with the diagnosis that names them; every other status is transient and
   * worth another pass until the job's own retry budget is spent. Signing
   * goes through here too: an order for a tenant with no СУЗ settings must
   * not sit in `signing` re-polling a permanently broken token while it
   * holds the tenant's only signing slot.
   */
  private async requireToken(
    order: OrderRow,
    attempt: AttemptContext,
  ): Promise<ActiveOmsToken | { status: "stop"; outcome: RunOutcome }> {
    const token = await this.tokens.getActiveToken(order.tenantId);
    if (token.status === "ok") return token;
    if (
      token.status === "unconfigured" ||
      token.status === "undecryptable" ||
      token.status === "settings_missing" ||
      attempt.retryCount >= attempt.retryLimit
    ) {
      await this.fail(
        order,
        token.status === "settings_missing"
          ? "CHZ_OMS_SETTINGS_MISSING"
          : "CHZ_OMS_TOKEN_UNAVAILABLE",
        null,
      );
      return { status: "stop", outcome: { finished: true, retryAfterSeconds: 0 } };
    }
    return { status: "stop", outcome: { finished: false, retryAfterSeconds: TOKEN_WAIT_SECONDS } };
  }

  private async startSigning(order: OrderRow): Promise<RunOutcome> {
    if (order.attempts >= MAX_SIGN_ATTEMPTS) {
      await this.fail(order, "CHZ_SIGNING_FAILED", null);
      return { finished: true, retryAfterSeconds: 0 };
    }
    const dataBase64 = Buffer.from(order.requestBody, "utf8").toString("base64");
    let inserted: string | null;
    try {
      inserted = await this.db.transaction(async (tx) => {
        const [task] = await tx
          .insert(schema.chzSignerTasks)
          .values({
            tenantId: order.tenantId,
            type: "sign_detached",
            payload: { purpose: "oms_order", orderId: order.id, dataBase64 },
          })
          .onConflictDoNothing()
          .returning({ id: schema.chzSignerTasks.id });
        if (!task) return null;
        const now = new Date();
        const [updated] = await tx
          .update(schema.chzKmOrders)
          .set({
            state: "signing",
            signerTaskId: task.id,
            // Nothing reads `claimed_at`: no staleness sweep needs it, because
            // `finishSigning` re-reads the task on every pass. It is kept as
            // the only record of when a signing slot was taken, for support
            // reading a stuck order's row; dropping the column needs a
            // migration, which this change does not carry.
            claimedAt: now,
            attempts: sql`${schema.chzKmOrders.attempts} + 1`,
            updatedAt: now,
          })
          .where(this.ownedOrderInState(order, "created"))
          .returning({ id: schema.chzKmOrders.id });
        // Returning here instead of throwing would commit the task row on
        // its own: `chz_signer_tasks_open_uq` allows one open task per
        // tenant and type, so that orphan would block every other order's
        // signing with no order referencing it. Roll the insert back.
        if (!updated) throw new OrderFenceLostError();
        return task.id;
      });
    } catch (error) {
      if (!(error instanceof OrderFenceLostError)) throw error;
      this.logger.warn(`Order ${order.id} left 'created' while its signer task was being created`);
      inserted = null;
    }
    if (inserted === null) return { finished: false, retryAfterSeconds: SIGN_WAIT_SECONDS };
    await this.append(order, "ok", "Заказ КМ отправлен на подпись агенту", {
      signerTaskId: inserted,
    });
    return { finished: false, retryAfterSeconds: SIGN_WAIT_SECONDS };
  }

  private async finishSigning(order: OrderRow, attempt: AttemptContext): Promise<RunOutcome> {
    if (order.signerTaskId === null) return this.reset(order);
    const [task] = await this.db
      .select()
      .from(schema.chzSignerTasks)
      .where(
        and(
          eq(schema.chzSignerTasks.tenantId, order.tenantId),
          eq(schema.chzSignerTasks.id, order.signerTaskId),
        ),
      );
    // A missing row (the task was somehow lost after being recorded) is
    // treated exactly like a `failed`/`expired` one: reset unconditionally,
    // on this very pass, rather than waiting for a staleness window. There is
    // therefore no separate "stale signing" sweep in `run()` -- this check
    // already runs every time the order is in `signing`, which is strictly
    // sooner than any time-based sweep could fire.
    if (!task || task.status === "failed" || task.status === "expired") {
      await this.append(order, "warn", "Подпись заказа КМ не получена, повтор", {
        signerTaskId: order.signerTaskId,
        taskStatus: task?.status ?? "missing",
      });
      return this.reset(order);
    }
    if (task.status !== "completed")
      return { finished: false, retryAfterSeconds: SIGN_WAIT_SECONDS };
    const signature = (task.resultSummary as { signatureBase64?: unknown } | null)?.signatureBase64;
    if (typeof signature !== "string" || signature.length === 0) return this.reset(order);
    const token = await this.requireToken(order, attempt);
    if (token.status !== "ok") return token.outcome;
    const created = await this.client.createOrder(token.auth, order.requestBody, signature);
    switch (created.status) {
      case "ok": {
        const now = new Date();
        const [updated] = await this.db
          .update(schema.chzKmOrders)
          .set({ state: "submitted", omsOrderId: created.value.orderId, updatedAt: now })
          .where(this.ownedOrderInState(order, "signing"))
          .returning({ id: schema.chzKmOrders.id });
        // СУЗ has created -- and billed -- the order the identifier below
        // names, and the row moved (state or `attempts`) under a second pass
        // before we could record it. Journalling an acceptance the write did
        // not make would leave the order in its old state with the office
        // told it succeeded, and whichever pass owns the row now would sign
        // and submit a *second* billed order. So the acceptance is not
        // journalled, the identifier is -- it is the only record that the
        // first order exists -- and the order ends here for a human to
        // reconcile in СУЗ. `fail` is fenced on the state only, so it lands
        // whatever the other pass did with `attempts`, and is a no-op if that
        // pass has already made the order terminal.
        if (!updated) {
          this.logger.error(
            `Order fence lost recording СУЗ order ${created.value.orderId} for order ${order.id}`,
          );
          await this.append(order, "error", "Ответ СУЗ не записан: заказ КМ изменился", {
            omsOrderId: created.value.orderId,
          });
          const latest = await this.load(order.tenantId, order.id);
          if (latest) await this.fail(latest, "CHZ_ORDER_SUBMIT_UNRECORDED", null);
          return { finished: true, retryAfterSeconds: 0 };
        }
        await this.append(order, "ok", "Заказ КМ принят СУЗ", {
          omsOrderId: created.value.orderId,
        });
        return {
          finished: false,
          retryAfterSeconds: Math.max(
            BUFFER_POLL_SECONDS,
            Math.ceil(created.value.expectedCompleteMs / 1000),
          ),
        };
      }
      case "unauthorized":
        await this.tokens.invalidateAndRequestRefresh(order.tenantId, token.obtainedAt);
        return { finished: false, retryAfterSeconds: TOKEN_WAIT_SECONDS };
      case "rejected":
        await this.fail(order, "CHZ_ORDER_REJECTED_BY_SUZ", created.message);
        return { finished: true, retryAfterSeconds: 0 };
      case "unavailable":
        return { finished: false, retryAfterSeconds: SIGN_WAIT_SECONDS };
    }
  }

  /** `signing → created` keeping `attempts`; the next pass creates a fresh task. */
  private async reset(order: OrderRow): Promise<RunOutcome> {
    await this.db
      .update(schema.chzKmOrders)
      .set({ state: "created", signerTaskId: null, claimedAt: null, updatedAt: new Date() })
      .where(this.ownedOrderInState(order, "signing"));
    return { finished: false, retryAfterSeconds: SIGN_WAIT_SECONDS };
  }

  private async pollBuffer(order: OrderRow, auth: OmsAuth): Promise<OrderRow | null> {
    if (order.omsOrderId === null) return order;
    const status = await this.client.getBufferStatus(auth, order.omsOrderId, order.gtin14);
    if (status.status === "unauthorized") throw new OmsUnauthorizedError();
    // A 4xx here is СУЗ's verdict on the request itself -- an order id it does
    // not know, a closed one, a GTIN that does not belong to it -- and no
    // amount of re-polling changes it. Re-polling would burn the full 48-hour
    // deadline and then report `CHZ_ORDER_TIMED_OUT`, hiding the real
    // diagnosis behind a misleading one, so this ends the order with СУЗ's
    // own wording exactly as `finishSigning` and `fetchCodes` already do.
    // Transport failures (`unavailable`) stay a wait: those do pass.
    if (status.status === "rejected") {
      await this.fail(order, "CHZ_ORDER_REJECTED_BY_SUZ", status.message);
      return this.load(order.tenantId, order.id);
    }
    if (status.status !== "ok") {
      this.logger.warn(`СУЗ buffer status ${status.status} for order ${order.id}`);
      return order;
    }
    const info = status.value;
    const now = new Date();
    const common = {
      bufferStatus: info.bufferStatus,
      availableCodes: info.availableCodes >= 0 ? info.availableCodes : null,
      // Stored, never read back: `fetched_count` is what the runner and the
      // cabinet count with. `total_passed` is СУЗ's own view of how many codes
      // it has handed out, which is what support compares ours against when
      // the two disagree. Kept for that; dropping the column needs a migration.
      totalPassed: info.totalPassed >= 0 ? info.totalPassed : null,
      bufferExpiresAt: info.expiredDate === null ? null : new Date(info.expiredDate),
      updatedAt: now,
    };
    if (info.bufferStatus === "REJECTED") {
      await this.db
        .update(schema.chzKmOrders)
        .set({
          ...common,
          state: "rejected",
          rejectionReason: (info.rejectionReason ?? "REJECTED").slice(0, ERROR_MESSAGE_LIMIT),
        })
        .where(this.ownedOrderInState(order, order.state));
      await this.append(order, "error", "СУЗ отклонил заказ КМ", { omsOrderId: order.omsOrderId });
      return this.load(order.tenantId, order.id);
    }
    const state = info.bufferStatus === "ACTIVE" ? "buffer_active" : "buffer_pending";
    await this.db
      .update(schema.chzKmOrders)
      .set({ ...common, state })
      .where(this.ownedOrderInState(order, order.state));
    return this.load(order.tenantId, order.id);
  }

  private async fetchCodes(order: OrderRow, auth: OmsAuth): Promise<OrderRow | null> {
    if (order.omsOrderId === null) return order;
    let current: OrderRow | null = order;
    if (current.state === "buffer_active") {
      await this.db
        .update(schema.chzKmOrders)
        .set({ state: "fetching", updatedAt: new Date() })
        .where(this.ownedOrderInState(current, "buffer_active"));
      current = await this.load(order.tenantId, order.id);
    }
    // `fetchedCount` as of this pass's last reconciliation; `null` until it
    // has reconciled once.
    let reconciledAt: number | null = null;
    // Shared by `getCodes` here and `retryBlock` inside `reconcileBlocks`:
    // both draw a block over the same 120-second client timeout, so both
    // spend the pass's lease. See `MAX_CODE_BLOCKS_PER_PASS`.
    const budget = { remaining: MAX_CODE_BLOCKS_PER_PASS };
    while (current && current.state === "fetching" && current.fetchedCount < current.quantity) {
      const omsOrderId = current.omsOrderId;
      if (omsOrderId === null) return current;
      const isLast = current.quantity - current.fetchedCount <= this.blockSize;
      // Blocks can only be re-fetched while the sub-order is open, and the
      // last code closes it. Reconciling only before the final block is not
      // enough: "final" is derived from our own counter, and that counter is
      // exactly what goes stale when a block is lost between СУЗ's response
      // and our commit. So every pass reconciles once before drawing
      // anything -- one GET over an empty list on a fresh order, and on a
      // resumed one it recovers the lost block while the buffer still holds
      // the codes we have not drawn. The before-final-block reconcile stays,
      // but is skipped when the counter has not moved since the last one.
      if (reconciledAt !== current.fetchedCount && (reconciledAt === null || isLast)) {
        const reconciled = await this.reconcileBlocks(current, auth, omsOrderId, budget);
        if (reconciled === null) return this.load(order.tenantId, order.id);
        current = reconciled;
        reconciledAt = current.fetchedCount;
        if (current.state !== "fetching" || current.fetchedCount >= current.quantity) break;
      }
      // Out of block budget -- including a reconciliation that spent it and
      // is therefore itself unfinished. The order stays `fetching`, so `run`
      // reports `finished: false` and the next pass reconciles and carries on
      // from the counter this one committed.
      if (budget.remaining <= 0) return current;
      budget.remaining -= 1;
      const quantity = Math.min(this.blockSize, current.quantity - current.fetchedCount);
      const block = await this.client.getCodes(auth, omsOrderId, current.gtin14, quantity);
      if (block.status === "unauthorized") throw new OmsUnauthorizedError();
      if (block.status === "rejected") {
        await this.fail(current, "CHZ_ORDER_REJECTED_BY_SUZ", block.message);
        return this.load(order.tenantId, order.id);
      }
      if (block.status !== "ok") return current;
      const fetchedBefore = current.fetchedCount;
      const stored = await this.storeBlock(current, block.value);
      if (!stored) return this.load(order.tenantId, order.id);
      current = await this.load(order.tenantId, order.id);
      // An empty block, or one whose blockId is already stored, commits
      // nothing and leaves the loop's only exit condition untouched -- the
      // next iteration would re-issue the identical request with no delay
      // and no cap. Reconciliation has already run this pass and found
      // nothing missing, so СУЗ has nothing more for us: say so instead of
      // spinning until the deadline turns it into a misleading timeout.
      if (current && current.fetchedCount <= fetchedBefore) {
        await this.fail(current, "CHZ_CODES_INCOMPLETE", null);
        return this.load(order.tenantId, order.id);
      }
    }
    if (current && current.state === "fetching" && current.fetchedCount >= current.quantity) {
      await this.db
        .update(schema.chzKmOrders)
        .set({ state: "completed", updatedAt: new Date() })
        .where(this.ownedOrderInState(current, "fetching"));
      await this.append(current, "ok", "Коды КМ получены", {
        omsOrderId: current.omsOrderId,
        quantity: current.quantity,
      });
      current = await this.load(order.tenantId, order.id);
    }
    return current;
  }

  /**
   * Re-fetches every block СУЗ lists that the database does not hold.
   * Returns null when the pass must stop: СУЗ was unavailable, or it rejected
   * the request and the order is now `failed`.
   */
  private async reconcileBlocks(
    order: OrderRow,
    auth: OmsAuth,
    omsOrderId: string,
    budget: { remaining: number },
  ): Promise<OrderRow | null> {
    const listed = await this.client.listBlocks(auth, omsOrderId, order.gtin14);
    if (listed.status === "unauthorized") throw new OmsUnauthorizedError();
    if (listed.status === "rejected") {
      await this.fail(order, "CHZ_ORDER_REJECTED_BY_SUZ", listed.message);
      return null;
    }
    if (listed.status !== "ok") return null;
    const held = new Set(
      (
        await this.db
          .selectDistinct({ blockId: schema.chzKmCodes.blockId })
          .from(schema.chzKmCodes)
          .where(
            and(
              eq(schema.chzKmCodes.tenantId, order.tenantId),
              eq(schema.chzKmCodes.orderId, order.id),
            ),
          )
      ).map((row) => row.blockId),
    );
    let current: OrderRow | null = order;
    for (const block of listed.value) {
      if (held.has(block.blockId) || !current) continue;
      // Every recovered block is a 120-second call out of the same pass
      // lease as a `getCodes`, so it spends the same budget. Stopping here
      // leaves the order `fetching`; the next pass lists the blocks again and
      // recovers the rest.
      if (budget.remaining <= 0) return current;
      budget.remaining -= 1;
      const again = await this.client.retryBlock(auth, block.blockId);
      if (again.status === "unauthorized") throw new OmsUnauthorizedError();
      if (again.status === "rejected") {
        await this.fail(current, "CHZ_ORDER_REJECTED_BY_SUZ", again.message);
        return null;
      }
      if (again.status !== "ok") return null;
      if (!(await this.storeBlock(current, again.value)))
        return this.load(order.tenantId, order.id);
      current = await this.load(order.tenantId, order.id);
    }
    return current;
  }

  /**
   * One transaction per block: rows plus the counter, so a crash leaves either
   * the whole block or none of it. A block already stored (same blockId) is a
   * no-op, which makes the СУЗ retry path idempotent.
   */
  private async storeBlock(order: OrderRow, block: OmsCodesBlock): Promise<boolean> {
    // `chz_km_orders_counts_check` asserts fetched_count <= quantity, so one
    // code too many raises a raw SQLSTATE 23514 that no arm below matches:
    // it would escape the runner, roll back codes СУЗ has already drawn, and
    // hit the same violation again on every re-fetch. СУЗ handing out more
    // than we asked for is a protocol violation; truncating would hide it.
    if (order.fetchedCount + block.codes.length > order.quantity) {
      await this.fail(order, "CHZ_CODES_OVERDELIVERED", null);
      return false;
    }
    const rows: (typeof schema.chzKmCodes.$inferInsert)[] = [];
    let seq = order.fetchedCount;
    for (const code of block.codes) {
      seq += 1;
      let hash: string;
      try {
        hash = kmHash(parseKm(code));
      } catch {
        await this.fail(order, "CHZ_CODES_UNPARSEABLE", null);
        return false;
      }
      const sealed = this.crypto.encryptWithAad(`${order.tenantId}/${order.id}/${seq}`, code);
      rows.push({
        tenantId: order.tenantId,
        orderId: order.id,
        seq,
        encryptedCode: sealed.encryptedToken,
        codeNonce: sealed.tokenNonce,
        codeTag: sealed.tokenTag,
        codeHash: hash,
        blockId: block.blockId,
      });
    }
    try {
      await this.db.transaction(async (tx) => {
        const [known] = await tx
          .select({ seq: schema.chzKmCodes.seq })
          .from(schema.chzKmCodes)
          .where(
            and(
              eq(schema.chzKmCodes.tenantId, order.tenantId),
              eq(schema.chzKmCodes.orderId, order.id),
              eq(schema.chzKmCodes.blockId, block.blockId),
            ),
          )
          .limit(1);
        if (known) return;
        for (let i = 0; i < rows.length; i += 1000) {
          await tx.insert(schema.chzKmCodes).values(rows.slice(i, i + 1000));
        }
        const now = new Date();
        const [updated] = await tx
          .update(schema.chzKmOrders)
          .set({ fetchedCount: seq, updatedAt: now })
          .where(
            and(
              this.ownedOrderInState(order, "fetching"),
              eq(schema.chzKmOrders.fetchedCount, order.fetchedCount),
            ),
          )
          .returning({ id: schema.chzKmOrders.id });
        if (!updated) throw new OrderFenceLostError();
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error, "chz_km_codes_tenant_hash_uq")) {
        await this.fail(order, "CHZ_CODES_DUPLICATE", null);
        return false;
      }
      if (error instanceof OrderFenceLostError) {
        // Silent rollback otherwise: this is the only trace a concurrent
        // second run for the same order would ever leave.
        this.logger.warn(`Order fence lost while storing a code block for order ${order.id}`);
        return false;
      }
      throw error;
    }
  }

  async abandonAfterJobRetriesExhausted(tenantId: string, orderId: string): Promise<void> {
    const order = await this.load(tenantId, orderId);
    if (order && !TERMINAL.has(order.state))
      await this.fail(order, "CHZ_JOB_RETRIES_EXHAUSTED", null);
  }

  private async fail(
    order: OrderRow,
    errorCode: ChzKmOrderSafeErrorCode,
    errorMessage: string | null,
  ): Promise<void> {
    const now = new Date();
    const updated = await this.db
      .update(schema.chzKmOrders)
      .set({
        state: "failed",
        errorCode,
        errorMessage:
          errorMessage === null || errorMessage.length === 0
            ? null
            : errorMessage.slice(0, ERROR_MESSAGE_LIMIT),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chzKmOrders.tenantId, order.tenantId),
          eq(schema.chzKmOrders.id, order.id),
          notInArray(schema.chzKmOrders.state, [...CHZ_KM_ORDER_TERMINAL_STATES]),
        ),
      )
      .returning({ id: schema.chzKmOrders.id });
    if (updated.length) {
      await this.append(order, "error", `Заказ КМ не выполнен: ${errorCode}`, {
        omsOrderId: order.omsOrderId,
      });
    }
  }

  private ownedOrderInState(order: OrderRow, state: OrderRow["state"]) {
    return and(
      eq(schema.chzKmOrders.tenantId, order.tenantId),
      eq(schema.chzKmOrders.id, order.id),
      eq(schema.chzKmOrders.state, state),
      eq(schema.chzKmOrders.attempts, order.attempts),
    );
  }

  private async load(tenantId: string, orderId: string): Promise<OrderRow | null> {
    const [row] = await this.db
      .select()
      .from(schema.chzKmOrders)
      .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, orderId)));
    return row ?? null;
  }

  /** Counts and ids only; never a code, never a token, never an exception message. */
  private async append(
    order: OrderRow,
    outcome: "ok" | "warn" | "error",
    message: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.journal.append({
        tenantId: order.tenantId,
        channelType: CHZ_CHANNEL_TYPE,
        sessionId: null,
        direction: "out",
        outcome,
        grain: "item",
        message,
        details: { orderId: order.id, ...details },
      });
    } catch (error) {
      this.logger.error(
        `Failed to journal KM order event for tenant ${order.tenantId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}

class OmsUnauthorizedError extends Error {}

/** The order row moved (state or `attempts`) between our read and our write. */
class OrderFenceLostError extends Error {}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const err = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  } | null;
  const code = err?.code ?? err?.cause?.code;
  const name = err?.constraint ?? err?.cause?.constraint;
  return code === "23505" && name === constraint;
}
