import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { formatPhc, PHC_ITERATIONS, validatePickupKm } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { getOrCreateBadgeSalt, readBadgeSalt } from "../../lib/badge-salt";
import { nextOrderNo } from "../../pickup/order-number";
import { computeTotalPrice } from "../../pickup/total-price";
import type { PickupSlipData } from "../../pickup/slip";
import { OperatorsService } from "../operators/operators.service";
import type {
  CreateOrderDto,
  CreateOrderResultDto,
  KioskBootstrapDto,
  ListPickupOrdersQueryDto,
  ListPickupOrdersResponseDto,
  OrderConflict,
  PickupOrderDetailDto,
  PickupOrderRowDto,
  PickupOrderStatus,
  ResolvePickupOrderDto,
} from "./dto";

/** An item that survived KM validation, allowlist resolution and in-request dedup. */
interface ResolvedItem {
  rawKm: string;
  productId: string;
  gtin14: string;
  serial: string;
  kmKey: string;
  unitPrice: string | null;
}

/**
 * How far AHEAD of server time a device-supplied `createdAt` may sit before
 * the server stops believing it. Deliberately small: an unsynced tablet drifts
 * by seconds to minutes, and the request itself adds only network latency, so
 * five minutes covers every honest case. Everything past it is either a broken
 * clock or the attack this bound exists for -- rolling a kiosk's date forward
 * hands its worker a brand-new UTC day, and therefore a fresh daily allowance,
 * as often as the date is rolled again.
 */
const CLIENT_CLOCK_AHEAD_TOLERANCE_MS = 5 * 60_000;

/**
 * How far BEHIND server time it may sit. Generous, because a legitimately old
 * timestamp is the whole point of `createdAt`: an offline kiosk replays its
 * queue with the original scan times. Bounded at seven days by an invariant
 * the device already enforces -- it blocks itself after 7 days without a
 * successful bootstrap (see `generatedAt` in ./dto.ts) -- so a device cannot
 * honestly accumulate a longer backlog than this. Backdating is the weaker
 * direction anyway: it spends an allowance on a day already past, it does not
 * mint a new one.
 */
const CLIENT_CLOCK_BEHIND_TOLERANCE_MS = 7 * 24 * 60 * 60_000;

/** One item classified against `validatePickupKm`, still pending allowlist resolution. */
type ParsedItem =
  | { rawKm: string; ok: true; gtin14: string; serial: string; key: string }
  | { rawKm: string; ok: false; conflictReason: "not_km" | "incomplete" };

export type ApplyExternalStatusOutcome =
  "applied" | "not_found" | "not_pending" | "missing_writeoff_reason";

export interface ApplyExternalStatusResult {
  outcome: ApplyExternalStatusOutcome;
  currentStatus?: PickupOrderStatus;
}

/**
 * One order `findExportCandidates` reports as held back this round because
 * at least one of its (non-voided) items' products still has no 1С
 * `external_ref` -- same shape `order-export.ts`'s own `planExport` produces
 * for its `HeldOrder[]`, so `ExchangeController.query`'s journaling loop can
 * consume either uniformly.
 */
export interface HeldExportOrder {
  orderId: string;
  orderNo: string;
  unlinkedProductIds: string[];
}

/** `findExportCandidates`'s result -- see that method's own comment (Fix 4, final review) for why these are two separate queries. */
export interface ExportCandidatesResult {
  candidates: {
    id: string;
    orderNo: string;
    createdAt: Date;
    reason: "buy" | "writeoff";
    writeoffReasonName: string | null;
    totalPrice: string | null;
    items: { productId: string; productExternalRef: string | null; unitPrice: string | null }[];
  }[];
  held: HeldExportOrder[];
}

@Injectable()
export class PickupOrdersService {
  private readonly logger = new Logger(PickupOrdersService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly operatorsService: OperatorsService,
  ) {}

  /**
   * Authoritative kiosk create/sync path (brief's 7-step algorithm):
   * 1. idempotency on (tenantId, kioskId, deviceSeq)
   * 2. badge -> active employee
   * 3. writeoff reason validation
   * 4. per-item KM validation + allowlist resolution + in-request dedup
   * 5. per-employee day-limit
   * 6. transactional insert, retrying around a kmKey race (23505)
   * 7. return the outcome
   */
  async createFromKiosk(
    tenantId: string,
    kioskId: string,
    dto: CreateOrderDto,
  ): Promise<CreateOrderResultDto> {
    // 1. Idempotency: a replayed sync for the same device sequence returns the same order, unchanged.
    const [existing] = await this.db
      .select()
      .from(schema.pickupOrders)
      .where(
        and(
          eq(schema.pickupOrders.tenantId, tenantId),
          eq(schema.pickupOrders.kioskId, kioskId),
          eq(schema.pickupOrders.deviceSeq, dto.deviceSeq),
        ),
      );
    if (existing) {
      return {
        orderNo: existing.orderNo,
        status: "pending",
        itemCount: existing.itemCount,
        conflicts: [],
      };
    }

    // 1b. Settle the ONE timestamp this request is filed under, before any step
    // that can throw. Every path below that persists something -- the two
    // rejection rows thrown out of steps 2 and 3, the all-conflict rejection
    // row, and the order itself -- must date it identically, and none of them
    // may take `dto.createdAt` raw: the device's clock is untrusted, and
    // `resolveScanTime` is the clamp that keeps a rolled-forward tablet from
    // minting itself a fresh daily allowance (see its doc comment). Hoisted
    // here rather than left at step 5 purely so the early-throw paths can
    // share it.
    const when = this.resolveScanTime(dto.createdAt, kioskId);

    // 2. Badge -> active employee (badge's revoked_at is null, employee active).
    //
    // 422, NOT 401, AND THE DIFFERENCE IS LOAD-BEARING. The badge is a field
    // of the ORDER, not the caller's credential: the device already
    // authenticated (`KioskDeviceGuard`), and what failed is that a well-formed
    // body names an employee no withdrawal can be filed against — which is
    // exactly what 422 says and 401 does not.
    //
    // 401 on this route is RESERVED for the device token, because the kiosk
    // cannot ask anything else. `POST /kiosk/orders` is the only route where a
    // device meets both failures, and it holds nothing but a status code to
    // tell them apart: 401 means the token is gone (archived kiosk, or a
    // replacement device having redeemed a new one) and sends it back to
    // pairing with its queue intact, so the sync worker deliberately excludes
    // 401 from the statuses it quarantines on. While an unknown badge shared
    // that 401, an order whose employee was deleted or archived server-side
    // before it synced was UNDELIVERABLE AND UNQUARANTINABLE: it parked at the
    // head of the offline queue forever and every later order sat behind it,
    // while the kiosk went on accepting and confirming new ones.
    //
    // 403 would have been the same mistake in a different digit — it also
    // speaks about the CALLER's authority, which is not what is wrong here, and
    // this codebase already uses it that way (`TenantGuard`,
    // `AuthorizationGuard`). 422 is already in the kiosk's terminal allowlist
    // (`TERMINAL_STATUSES`, apps/kiosk/src/sync/worker.ts), so the queue
    // unblocks the moment this ships, including on a device still running an
    // older bundle.
    const employeeId = await this.resolveActiveEmployeeId(tenantId, dto);
    if (!employeeId) {
      // An offline sync lands hours after the scan, so the badge may have
      // been revoked in between -- and this 422 fires before a single item
      // is examined, so without this the codes the worker walked off with
      // leave no trace at all. Codes only: an item-less badge heartbeat
      // lost nothing and must not add noise here.
      if (dto.items.length > 0) {
        await this.recordScanRejection(this.db, {
          tenantId,
          kioskId,
          employeeId: null,
          badgeCode: await this.auditBadgeValue(tenantId, dto),
          orderId: null,
          deviceSeq: dto.deviceSeq,
          codes: dto.items.map((item) => ({ rawKm: item.rawKm, reason: "unknown_badge" })),
          scannedAt: when,
        });
      }
      throw new UnprocessableEntityException("Unknown or inactive badge");
    }

    // 3. Writeoff orders require a non-archived reason belonging to this tenant.
    let writeoffReasonId: string | null;
    try {
      writeoffReasonId = await this.resolveWriteoffReasonId(tenantId, dto);
    } catch (error) {
      // Same offline-drift shape as the unrecognised badge above: the kiosk
      // cached the reason list at bootstrap, the admin archived (or removed)
      // it hours later, and this throws before a single item is examined --
      // so without this the codes the worker walked off with leave no trace
      // at all. Codes only: an item-less sync lost no product and must not
      // add noise. The employee IS known here (step 2 already succeeded), so
      // this is `badgeCode: null` -- the mirror image of the badge case.
      // Rethrow unchanged: this call site must not alter the kiosk's
      // response, whichever of `resolveWriteoffReasonId`'s two messages fired.
      if (dto.items.length > 0) {
        await this.recordScanRejection(this.db, {
          tenantId,
          kioskId,
          employeeId,
          badgeCode: null,
          orderId: null,
          deviceSeq: dto.deviceSeq,
          codes: dto.items.map((item) => ({ rawKm: item.rawKm, reason: "unknown_reason" })),
          scannedAt: when,
        });
      }
      throw error;
    }

    // 4. Per-item KM validation, allowlist resolution and in-request dedup.
    const { conflicts, candidates } = await this.resolveItems(tenantId, kioskId, dto.items);

    // 5. Day-limit: accept up to dayLimitPerEmployee, flag the rest as over_limit.
    // `when` is the server's decision, not the device's claim (see
    // `resolveScanTime`, settled at step 1b), and the SAME value then dates the
    // order row below -- so the limit is always counted against the day the
    // order is filed under.
    const { accepted, overflowConflicts } = await this.applyDayLimit(
      tenantId,
      kioskId,
      employeeId,
      when,
      candidates,
    );
    conflicts.push(...overflowConflicts);

    // 5b. A non-empty scan that produced only conflicts (nothing accepted) must
    // NOT persist an empty pending order — it would clutter the свод with a
    // 0-item row that can never be resolved. But first re-check idempotency: a
    // concurrent submission carrying the same deviceSeq may have created the
    // real order since step 1 (e.g. this request over-limited precisely because
    // its twin's items just landed — so that winner is already committed).
    // Return the winner if present; otherwise it's a genuine all-conflict scan
    // and we return the conflicts with an empty orderNo. (A genuinely item-less
    // sync, `items: []` e.g. a badge heartbeat, is excluded and still creates
    // its order.)
    if (accepted.length === 0 && dto.items.length > 0) {
      const [twin] = await this.db
        .select({
          orderNo: schema.pickupOrders.orderNo,
          itemCount: schema.pickupOrders.itemCount,
        })
        .from(schema.pickupOrders)
        .where(
          and(
            eq(schema.pickupOrders.tenantId, tenantId),
            eq(schema.pickupOrders.kioskId, kioskId),
            eq(schema.pickupOrders.deviceSeq, dto.deviceSeq),
          ),
        );
      if (twin) {
        return {
          orderNo: twin.orderNo,
          status: "pending",
          itemCount: twin.itemCount,
          conflicts: [],
        };
      }
      // No order row is created here, so `syncConflicts` has nowhere to live.
      // `pickup_scan_rejections` is that home: the cabinet would otherwise
      // never learn that a worker's ENTIRE scan session was refused -- the
      // same blind spot `syncConflicts` exists to close, in its worst case.
      await this.recordScanRejection(this.db, {
        tenantId,
        kioskId,
        employeeId,
        badgeCode: null,
        orderId: null,
        deviceSeq: dto.deviceSeq,
        codes: conflicts,
        scannedAt: when,
      });
      // Kept alongside the durable row: cheap, and ops alerting may key on it.
      this.logger.warn(
        `kiosk ${kioskId}: all ${dto.items.length} scanned code(s) refused for employee ${employeeId} — ${conflicts.map((c) => c.reason).join(", ")}`,
      );
      return { orderNo: "", status: "pending", itemCount: 0, conflicts };
    }

    // 6. Transactional insert; a kmKey race against another open order converts that item to a duplicate conflict.
    const order = await this.insertOrderWithRetry(
      tenantId,
      kioskId,
      employeeId,
      dto.reason,
      writeoffReasonId,
      dto.deviceSeq,
      when,
      accepted,
      conflicts,
    );

    // 7. Outcome. (A device-seq race outcome carries its own `conflicts: []`, mirroring the
    // sequential idempotent path — this request's own conflicts belong to a duplicate submission.)
    return {
      orderNo: order.orderNo,
      status: "pending",
      itemCount: order.itemCount,
      conflicts: order.conflicts ?? conflicts,
    };
  }

  /** Offline-cache payload: everything a kiosk needs to operate without a round-trip per scan. */
  async bootstrap(tenantId: string, kioskId: string): Promise<KioskBootstrapDto> {
    // ONE reading of the clock for the whole payload, so `generatedAt` and the
    // UTC day the per-employee counts below are taken over can never straddle
    // a midnight between two `new Date()` calls.
    const generatedAt = new Date();

    const [kiosk] = await this.db
      .select({
        dayLimitPerEmployee: schema.kiosks.dayLimitPerEmployee,
        showPrices: schema.kiosks.showPrices,
      })
      .from(schema.kiosks)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId)));

    const reasons = await this.db
      .select({ id: schema.pickupOrderReasons.id, name: schema.pickupOrderReasons.name })
      .from(schema.pickupOrderReasons)
      .where(
        and(
          eq(schema.pickupOrderReasons.tenantId, tenantId),
          eq(schema.pickupOrderReasons.archived, false),
        ),
      )
      .orderBy(asc(schema.pickupOrderReasons.sortOrder), asc(schema.pickupOrderReasons.name));

    const products = await this.db
      .select({
        id: schema.products.id,
        gtin14: schema.products.gtin14,
        name: schema.products.name,
        unitPrice: schema.products.unitPrice,
        egaisCode: schema.products.egaisCode,
      })
      .from(schema.kioskProducts)
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.kioskProducts.tenantId),
          eq(schema.products.id, schema.kioskProducts.productId),
        ),
      )
      .where(
        and(eq(schema.kioskProducts.tenantId, tenantId), eq(schema.kioskProducts.kioskId, kioskId)),
      );

    const badgeSalt = await getOrCreateBadgeSalt(this.db, tenantId);

    const employeeRows = await this.db
      .select()
      .from(schema.employees)
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.status, "active")))
      .orderBy(asc(schema.employees.fullName));

    // Reuses the roster builder's hashing/backfill path, so kiosk and station
    // can never drift on how a badge verifier is produced.
    const badgeHashes = await this.operatorsService.badgeHashesFor(
      tenantId,
      employeeRows.map((e) => e.id),
    );
    const operators = await this.operatorsService.buildRoster(tenantId);

    // ONE grouped query for the entire roster, never one per employee: this
    // runs on every bootstrap and every paired kiosk pulls one every five
    // minutes.
    const takenElsewhere = await this.takenTodayElsewhereByEmployee(tenantId, kioskId, generatedAt);

    return {
      generatedAt: generatedAt.toISOString(),
      config: {
        dayLimitPerEmployee: kiosk?.dayLimitPerEmployee ?? 0,
        showPrices: kiosk?.showPrices ?? true,
      },
      badgeSalt,
      reasons,
      products,
      employees: employeeRows.map((e) => ({
        id: e.id,
        fullName: e.fullName,
        role: e.role,
        badgeHash: badgeHashes.get(e.id) ?? null,
        // Absent from the grouped result means this employee took nothing at
        // another kiosk today, which is `0` and not a missing field: the device
        // reads this per employee and adds it to its own count.
        takenTodayElsewhere: takenElsewhere.get(e.id) ?? 0,
      })),
      operators: operators.map((o) => ({
        employeeId: o.operatorId,
        name: o.name,
        login: o.login,
        role: o.role,
        pinHash: o.pinHash,
        badgeHash: o.badgeHash,
        // From the roster record, not hardcoded -- `buildRoster` only
        // returns active operators today so this is always `true`, but the
        // field must reflect the record, not an assumption baked into this
        // mapping.
        active: o.active,
      })),
    };
  }

  /** Admin list, joined with employee/kiosk/writeoff-reason names, newest first. */
  async list(
    tenantId: string,
    query: ListPickupOrdersQueryDto,
  ): Promise<ListPickupOrdersResponseDto> {
    const conditions: SQL[] = [eq(schema.pickupOrders.tenantId, tenantId)];
    if (query.status) conditions.push(eq(schema.pickupOrders.status, query.status));
    if (query.reason) conditions.push(eq(schema.pickupOrders.reason, query.reason));
    if (query.from)
      conditions.push(gte(schema.pickupOrders.createdAt, new Date(`${query.from}T00:00:00.000Z`)));
    if (query.to)
      conditions.push(lte(schema.pickupOrders.createdAt, new Date(`${query.to}T23:59:59.999Z`)));

    const rows = await this.queryJoinedRows(conditions);
    return { items: rows.map((row) => this.mapRowDto(row)) };
  }

  /**
   * Orders ready for `mode=query` this round, split into two INDEPENDENTLY
   * queried sets -- see Fix 4's own explanation below for why they must be
   * independent.
   *
   * `candidates`: `pending`, never yet exported (`exported_at is null`), AND
   * -- via the `NOT EXISTS` condition below -- with every (non-voided)
   * item's product ALREADY linked to a 1С `external_ref`. Ordered
   * oldest-first and capped at `limit`, so a channel with more eligible
   * orders than `limit` still makes steady progress across rounds rather
   * than the same newest batch crowding out the rest forever. Guaranteed
   * exportable by construction, so `planExport` (order-export.ts), which
   * still runs over this result, will report every one of these `eligible`
   * -- its own held-splitting logic simply never has anything left to hold.
   *
   * Fix 4 (final review): this `NOT EXISTS` is the entire fix, and it is
   * what changed here. The PREVIOUS version of this method selected the
   * oldest `limit` pending+unexported orders FIRST, un-filtered, and only
   * AFTERWARDS -- in the caller, via `planExport` -- split that batch into
   * eligible vs. held (held = has an item whose product lacks a 1С link).
   * Once `limit` (200) or more orders were held, EVERY order this method
   * surfaced, every round, was held, and no eligible order was ever selected
   * again -- a real starvation bug, most likely to trigger on a tenant's
   * very first exchange when its whole catalog is still unlinked. Excluding
   * held orders IN THE QUERY, before `limit` is applied, is what breaks
   * that: an eligible order can no longer be crowded out of the batch by
   * however many held orders happen to be older than it.
   *
   * `held`: a SEPARATE, independently-limited query (`findHeldExportOrders`)
   * -- pending+unexported orders WITH at least one unlinked item -- for
   * `ExchangeController.query`'s held-order journaling ONLY. Once
   * `candidates` above excludes held orders entirely, nothing else would
   * ever learn about them, and that journaling would silently stop working
   * -- not an acceptable side effect of the starvation fix. This query does
   * NOT need to be exhaustive every round (a bounded top-N sample is fine
   * for a journal entry); its whole point is that it must never gate or
   * compete with the `candidates` query above the way the single combined
   * query used to.
   *
   * Items for `candidates` are fetched in a SECOND query (keyed on the same
   * order ids) rather than joined into the first, same shape `readJournal`
   * already uses for sessions + events (`integrations.service.ts`) -- an
   * order-to-items join would repeat every order column once per item row
   * for no reason.
   */
  async findExportCandidates(tenantId: string, limit: number): Promise<ExportCandidatesResult> {
    const orders = await this.db
      .select({
        id: schema.pickupOrders.id,
        orderNo: schema.pickupOrders.orderNo,
        createdAt: schema.pickupOrders.createdAt,
        reason: schema.pickupOrders.reason,
        writeoffReasonName: schema.pickupOrderReasons.name,
        totalPrice: schema.pickupOrders.totalPrice,
      })
      .from(schema.pickupOrders)
      .leftJoin(
        schema.pickupOrderReasons,
        eq(schema.pickupOrderReasons.id, schema.pickupOrders.writeoffReasonId),
      )
      .where(
        and(
          eq(schema.pickupOrders.tenantId, tenantId),
          eq(schema.pickupOrders.status, "pending"),
          isNull(schema.pickupOrders.exportedAt),
          exists(this.activeItemSubquery(tenantId)),
          notExists(this.unlinkedItemSubquery(tenantId)),
        ),
      )
      .orderBy(asc(schema.pickupOrders.createdAt))
      .limit(limit);

    let candidates: ExportCandidatesResult["candidates"] = [];
    if (orders.length > 0) {
      const orderIds = orders.map((order) => order.id);
      const items = await this.db
        .select({
          orderId: schema.pickupOrderItems.orderId,
          productId: schema.pickupOrderItems.productId,
          productExternalRef: schema.products.externalRef,
          unitPrice: schema.pickupOrderItems.unitPrice,
        })
        .from(schema.pickupOrderItems)
        .innerJoin(schema.products, eq(schema.products.id, schema.pickupOrderItems.productId))
        .where(
          and(
            eq(schema.pickupOrderItems.tenantId, tenantId),
            inArray(schema.pickupOrderItems.orderId, orderIds),
            eq(schema.pickupOrderItems.voided, false),
          ),
        );

      const itemsByOrder = new Map<
        string,
        { productId: string; productExternalRef: string | null; unitPrice: string | null }[]
      >();
      for (const item of items) {
        const entry = {
          productId: item.productId,
          productExternalRef: item.productExternalRef,
          unitPrice: item.unitPrice,
        };
        const bucket = itemsByOrder.get(item.orderId);
        if (bucket) bucket.push(entry);
        else itemsByOrder.set(item.orderId, [entry]);
      }

      candidates = orders.map((order) => ({ ...order, items: itemsByOrder.get(order.id) ?? [] }));
    }

    const held = await this.findHeldExportOrders(tenantId, limit);
    return { candidates, held };
  }

  /**
   * The correlated "this order has an unlinked item" subquery both
   * `findExportCandidates` (as `NOT EXISTS`, to exclude) and
   * `findHeldExportOrders` (as `EXISTS`, to include) build on -- centralised
   * so the two queries can never quietly drift on what "held" means.
   * Correlates on `schema.pickupOrders.id` from the OUTER query each caller
   * already selects `FROM`; returns a fresh query builder on every call
   * since a drizzle select builder is consumed by the `exists`/`notExists`
   * wrapper that reads it, not reusable across two call sites.
   */
  private unlinkedItemSubquery(tenantId: string) {
    return this.db
      .select({ one: sql<number>`1` })
      .from(schema.pickupOrderItems)
      .innerJoin(schema.products, eq(schema.products.id, schema.pickupOrderItems.productId))
      .where(
        and(
          eq(schema.pickupOrderItems.tenantId, tenantId),
          eq(schema.pickupOrderItems.orderId, schema.pickupOrders.id),
          eq(schema.pickupOrderItems.voided, false),
          isNull(schema.products.externalRef),
        ),
      );
  }

  private activeItemSubquery(tenantId: string) {
    return this.db
      .select({ one: sql<number>`1` })
      .from(schema.pickupOrderItems)
      .where(
        and(
          eq(schema.pickupOrderItems.tenantId, tenantId),
          eq(schema.pickupOrderItems.orderId, schema.pickupOrders.id),
          eq(schema.pickupOrderItems.voided, false),
        ),
      );
  }

  /**
   * A bounded (`limit`-sized) sample of pending, unexported orders that have
   * at least one item whose product still lacks a 1С `external_ref` -- feeds
   * `ExchangeController.query`'s held-order journaling ONLY. See
   * `findExportCandidates`'s own comment (Fix 4, final review) for why this
   * is deliberately a query separate from the one that actually feeds
   * `planExport`: it must never gate or compete with that one.
   */
  private async findHeldExportOrders(tenantId: string, limit: number): Promise<HeldExportOrder[]> {
    const orders = await this.db
      .select({ id: schema.pickupOrders.id, orderNo: schema.pickupOrders.orderNo })
      .from(schema.pickupOrders)
      .where(
        and(
          eq(schema.pickupOrders.tenantId, tenantId),
          eq(schema.pickupOrders.status, "pending"),
          isNull(schema.pickupOrders.exportedAt),
          exists(this.unlinkedItemSubquery(tenantId)),
        ),
      )
      .orderBy(asc(schema.pickupOrders.createdAt))
      .limit(limit);

    if (orders.length === 0) return [];

    const orderIds = orders.map((order) => order.id);
    const unlinkedItems = await this.db
      .select({
        orderId: schema.pickupOrderItems.orderId,
        productId: schema.pickupOrderItems.productId,
      })
      .from(schema.pickupOrderItems)
      .innerJoin(schema.products, eq(schema.products.id, schema.pickupOrderItems.productId))
      .where(
        and(
          eq(schema.pickupOrderItems.tenantId, tenantId),
          inArray(schema.pickupOrderItems.orderId, orderIds),
          eq(schema.pickupOrderItems.voided, false),
          isNull(schema.products.externalRef),
        ),
      );

    const unlinkedByOrder = new Map<string, Set<string>>();
    for (const item of unlinkedItems) {
      const bucket = unlinkedByOrder.get(item.orderId);
      if (bucket) bucket.add(item.productId);
      else unlinkedByOrder.set(item.orderId, new Set([item.productId]));
    }

    return orders.map((order) => ({
      orderId: order.id,
      orderNo: order.orderNo,
      unlinkedProductIds: [...(unlinkedByOrder.get(order.id) ?? new Set<string>())],
    }));
  }

  /** Admin detail: joined row + the employee's active badge code + items (with product names). */
  async detail(tenantId: string, id: string): Promise<PickupOrderDetailDto> {
    const [row] = await this.db
      .select({
        ...this.joinedSelection(),
        employeeId: schema.pickupOrders.employeeId,
        receiptNo: schema.pickupOrders.receiptNo,
        actNo: schema.pickupOrders.actNo,
      })
      .from(schema.pickupOrders)
      .leftJoin(schema.employees, eq(schema.employees.id, schema.pickupOrders.employeeId))
      .leftJoin(schema.kiosks, eq(schema.kiosks.id, schema.pickupOrders.kioskId))
      .leftJoin(
        schema.pickupOrderReasons,
        eq(schema.pickupOrderReasons.id, schema.pickupOrders.writeoffReasonId),
      )
      .where(and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.id, id)));

    if (!row) throw new NotFoundException();

    const [badge] = await this.db
      .select({ badgeCode: schema.employeeBadges.badgeCode })
      .from(schema.employeeBadges)
      .where(
        and(
          eq(schema.employeeBadges.tenantId, tenantId),
          eq(schema.employeeBadges.employeeId, row.employeeId),
          isNull(schema.employeeBadges.revokedAt),
        ),
      );

    const itemRows = await this.db
      .select({
        id: schema.pickupOrderItems.id,
        gtin14: schema.pickupOrderItems.gtin14,
        serial: schema.pickupOrderItems.serial,
        rawKm: schema.pickupOrderItems.rawKm,
        productName: schema.products.name,
        externalRef: schema.products.externalRef,
        unitPrice: schema.pickupOrderItems.unitPrice,
        voided: schema.pickupOrderItems.voided,
      })
      .from(schema.pickupOrderItems)
      .leftJoin(schema.products, eq(schema.products.id, schema.pickupOrderItems.productId))
      .where(
        and(
          eq(schema.pickupOrderItems.tenantId, tenantId),
          eq(schema.pickupOrderItems.orderId, id),
        ),
      );

    const exportHeldProductNames = [
      ...new Set(
        itemRows
          .filter((item) => !item.voided && item.externalRef === null)
          .map((item) => item.productName)
          .filter((name): name is string => Boolean(name)),
      ),
    ];

    return {
      ...this.mapRowDto(row),
      employeeBadgeCode: badge?.badgeCode ?? null,
      items: itemRows.map((item) => ({
        id: item.id,
        gtin14: item.gtin14,
        serial: item.serial,
        rawKm: item.rawKm,
        productName: item.productName ?? "",
        unitPrice: item.unitPrice,
      })),
      receiptNo: row.receiptNo,
      actNo: row.actNo,
      syncConflicts: (row.syncConflicts as OrderConflict[] | null) ?? [],
      exportHeldProductNames,
    };
  }

  /**
   * Gathers everything `renderPickupSlipHtml` needs for the printed A4 slip:
   * the order + its (non-voided) items joined with product names, the
   * employee's currently-active badge (may be none), and this tenant's
   * `organization` name + `orgProfiles` INN (the profile row may not exist
   * yet — org comes back null in that case, not a 404).
   */
  async slipData(tenantId: string, id: string): Promise<PickupSlipData> {
    const [row] = await this.db
      .select({
        orderNo: schema.pickupOrders.orderNo,
        createdAt: schema.pickupOrders.createdAt,
        reason: schema.pickupOrders.reason,
        totalPrice: schema.pickupOrders.totalPrice,
        employeeId: schema.pickupOrders.employeeId,
        employeeFullName: schema.employees.fullName,
        employeeRole: schema.employees.role,
        kioskName: schema.kiosks.name,
        writeoffReasonName: schema.pickupOrderReasons.name,
      })
      .from(schema.pickupOrders)
      .leftJoin(schema.employees, eq(schema.employees.id, schema.pickupOrders.employeeId))
      .leftJoin(schema.kiosks, eq(schema.kiosks.id, schema.pickupOrders.kioskId))
      .leftJoin(
        schema.pickupOrderReasons,
        eq(schema.pickupOrderReasons.id, schema.pickupOrders.writeoffReasonId),
      )
      .where(and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.id, id)));

    if (!row) throw new NotFoundException();

    const [badge] = await this.db
      .select({ badgeCode: schema.employeeBadges.badgeCode })
      .from(schema.employeeBadges)
      .where(
        and(
          eq(schema.employeeBadges.tenantId, tenantId),
          eq(schema.employeeBadges.employeeId, row.employeeId),
          isNull(schema.employeeBadges.revokedAt),
        ),
      );

    const [org] = await this.db
      .select({ name: schema.organization.name, inn: schema.orgProfiles.inn })
      .from(schema.organization)
      .leftJoin(schema.orgProfiles, eq(schema.orgProfiles.tenantId, schema.organization.id))
      .where(eq(schema.organization.id, tenantId));

    const itemRows = await this.db
      .select({
        gtin14: schema.pickupOrderItems.gtin14,
        serial: schema.pickupOrderItems.serial,
        rawKm: schema.pickupOrderItems.rawKm,
        productName: schema.products.name,
        unitPrice: schema.pickupOrderItems.unitPrice,
      })
      .from(schema.pickupOrderItems)
      .leftJoin(schema.products, eq(schema.products.id, schema.pickupOrderItems.productId))
      .where(
        and(
          eq(schema.pickupOrderItems.tenantId, tenantId),
          eq(schema.pickupOrderItems.orderId, id),
          eq(schema.pickupOrderItems.voided, false),
        ),
      )
      .orderBy(asc(schema.pickupOrderItems.scannedAt));

    return {
      orderNo: row.orderNo,
      createdAt: row.createdAt,
      org: org ? { name: org.name, inn: org.inn } : null,
      employee: {
        fullName: row.employeeFullName ?? "",
        role: row.employeeRole,
        badgeCode: badge?.badgeCode ?? null,
      },
      kioskName: row.kioskName ?? "",
      reason: row.reason,
      writeoffReasonName: row.writeoffReasonName,
      // Derived FROM the (non-voided) items rendered below, not from the stored
      // `pickupOrders.totalPrice` passthrough — that column isn't recomputed by
      // `cancel()` when it voids items, so it would go stale (non-zero total
      // next to an empty table) for a cancelled order. This keeps "Итого"
      // consistent with the table for every status.
      total: computeTotalPrice(itemRows),
      items: itemRows.map((item, index) => ({
        n: index + 1,
        productName: item.productName ?? "",
        gtin14: item.gtin14,
        serial: item.serial,
        rawKm: item.rawKm,
        unitPrice: item.unitPrice,
      })),
    };
  }

  /**
   * Resolve a pending order: `punch` records the receipt number; `writeoff`
   * requires a writeoff reason (supplied — validated against this tenant,
   * else inherited from the order's own `writeoffReasonId` — else 400) and
   * records the act number. Either way, must currently be `pending` (409
   * otherwise), and records who resolved it (`resolvedByUserId`, threaded
   * from `TenantGuard`).
   */
  async resolve(
    tenantId: string,
    id: string,
    dto: ResolvePickupOrderDto,
    userId: string,
  ): Promise<PickupOrderRowDto> {
    const current = await this.findRow(tenantId, id);
    if (!current) throw new NotFoundException();
    if (current.status !== "pending") {
      throw new ConflictException("Order can only be resolved while pending");
    }

    const resolvedAt = new Date();
    const pendingCondition = and(
      eq(schema.pickupOrders.tenantId, tenantId),
      eq(schema.pickupOrders.id, id),
      eq(schema.pickupOrders.status, "pending"),
    );

    let updatedId: string | undefined;
    if (dto.action === "punch") {
      const [row] = await this.db
        .update(schema.pickupOrders)
        .set({
          status: "punched",
          receiptNo: dto.receiptNo ?? null,
          resolvedAt,
          resolvedByUserId: userId,
        })
        .where(pendingCondition)
        .returning({ id: schema.pickupOrders.id });
      updatedId = row?.id;
    } else {
      const writeoffReasonId = dto.writeoffReasonId ?? current.writeoffReasonId;
      if (!writeoffReasonId) {
        throw new BadRequestException("writeoffReasonId is required to write off this order");
      }
      if (dto.writeoffReasonId) {
        await this.assertValidWriteoffReason(tenantId, dto.writeoffReasonId);
      }
      const [row] = await this.db
        .update(schema.pickupOrders)
        .set({
          status: "writtenoff",
          actNo: dto.actNo ?? null,
          writeoffReasonId,
          resolvedAt,
          resolvedByUserId: userId,
        })
        .where(pendingCondition)
        .returning({ id: schema.pickupOrders.id });
      updatedId = row?.id;
    }

    if (!updatedId) throw new ConflictException("Order can only be resolved while pending");
    return this.rowDtoById(tenantId, updatedId);
  }

  /**
   * Export raw KMs from the specified orders. Each item's rawKm is on a separate line.
   * Order IDs that don't belong to this tenant are silently excluded (no error).
   * Returns one rawKm per line, joined by newlines, preserving GS bytes.
   */
  async exportCodes(tenantId: string, orderIds: string[]): Promise<string> {
    if (orderIds.length === 0) return "";

    const rows = await this.db
      .select({ rawKm: schema.pickupOrderItems.rawKm })
      .from(schema.pickupOrderItems)
      .where(
        and(
          eq(schema.pickupOrderItems.tenantId, tenantId),
          inArray(schema.pickupOrderItems.orderId, orderIds),
          eq(schema.pickupOrderItems.voided, false),
        ),
      )
      .orderBy(asc(schema.pickupOrderItems.orderId), asc(schema.pickupOrderItems.scannedAt));

    return rows.map((r) => r.rawKm).join("\n");
  }

  /**
   * Cancel a pending order (409 otherwise) and void its items in the same
   * transaction — voiding frees the partial-unique index on `kmKey`, so a
   * cancelled code can be re-scanned into a new order.
   */
  async cancel(tenantId: string, id: string): Promise<PickupOrderRowDto> {
    const cancelledId = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ status: schema.pickupOrders.status })
        .from(schema.pickupOrders)
        .where(and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.id, id)));

      if (!current) throw new NotFoundException();
      if (current.status !== "pending") {
        throw new ConflictException("Order can only be cancelled while pending");
      }

      const [row] = await tx
        .update(schema.pickupOrders)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(schema.pickupOrders.tenantId, tenantId),
            eq(schema.pickupOrders.id, id),
            eq(schema.pickupOrders.status, "pending"),
          ),
        )
        .returning({ id: schema.pickupOrders.id });

      if (!row) throw new ConflictException("Order can only be cancelled while pending");

      await tx
        .update(schema.pickupOrderItems)
        .set({ voided: true })
        .where(
          and(
            eq(schema.pickupOrderItems.tenantId, tenantId),
            eq(schema.pickupOrderItems.orderId, id),
          ),
        );

      return row.id;
    });

    return this.rowDtoById(tenantId, cancelledId);
  }

  /**
   * Applies a status 1С reported for this tenant's order via the CommerceML
   * `type=sale` reconciliation (спека §6, `order-status.ts`'s
   * `resolveMappedStatus`). Same guarded `pending -> X` transition
   * `resolve`/`cancel` above already enforce -- an order 1С reports as
   * changed, but this server no longer sees as `pending` (an admin already
   * resolved/cancelled it locally, or 1С already reported this exact change
   * before), is a discrepancy for the CALLER to journal, never a thrown
   * exception: one bad row inside a reconciliation batch must never abort
   * the rest of it (same discipline `commerceml/apply.ts` already follows
   * for a bad price).
   */
  async applyExternalStatus(
    tenantId: string,
    orderId: string,
    mappedStatus: "punched" | "writtenoff" | "cancelled",
  ): Promise<ApplyExternalStatusResult> {
    const current = await this.findRow(tenantId, orderId);
    if (!current) return { outcome: "not_found" };
    if (current.status !== "pending") {
      return { outcome: "not_pending", currentStatus: current.status };
    }

    const pendingCondition = and(
      eq(schema.pickupOrders.tenantId, tenantId),
      eq(schema.pickupOrders.id, orderId),
      eq(schema.pickupOrders.status, "pending"),
    );

    if (mappedStatus === "cancelled") {
      const cancelledId = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.pickupOrders)
          .set({ status: "cancelled" })
          .where(pendingCondition)
          .returning({ id: schema.pickupOrders.id });
        if (!row) return null;
        await tx
          .update(schema.pickupOrderItems)
          .set({ voided: true })
          .where(
            and(
              eq(schema.pickupOrderItems.tenantId, tenantId),
              eq(schema.pickupOrderItems.orderId, orderId),
            ),
          );
        return row.id;
      });
      return cancelledId ? { outcome: "applied" } : { outcome: "not_pending" };
    }

    if (mappedStatus === "writtenoff" && !current.writeoffReasonId) {
      return { outcome: "missing_writeoff_reason" };
    }

    const resolvedAt = new Date();
    const [row] = await this.db
      .update(schema.pickupOrders)
      .set(
        mappedStatus === "punched"
          ? { status: "punched", resolvedAt, resolvedByUserId: null }
          : { status: "writtenoff", resolvedAt, resolvedByUserId: null },
      )
      .where(pendingCondition)
      .returning({ id: schema.pickupOrders.id });

    return row ? { outcome: "applied" } : { outcome: "not_pending" };
  }

  /**
   * A writeoffReasonId explicitly supplied to /resolve must belong to this
   * tenant and be non-archived — symmetric with the kiosk create path
   * (`resolveWriteoffReasonId`), so an archived reason can't be re-attached
   * on resolve any more than it can on ingest.
   */
  private async assertValidWriteoffReason(
    tenantId: string,
    writeoffReasonId: string,
  ): Promise<void> {
    const [reason] = await this.db
      .select({ id: schema.pickupOrderReasons.id })
      .from(schema.pickupOrderReasons)
      .where(
        and(
          eq(schema.pickupOrderReasons.tenantId, tenantId),
          eq(schema.pickupOrderReasons.id, writeoffReasonId),
          eq(schema.pickupOrderReasons.archived, false),
        ),
      );
    if (!reason) {
      throw new BadRequestException("Unknown or archived writeoff reason for this organization");
    }
  }

  private async findRow(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(schema.pickupOrders)
      .where(and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.id, id)));
    return row;
  }

  private async rowDtoById(tenantId: string, id: string): Promise<PickupOrderRowDto> {
    const rows = await this.queryJoinedRows([
      eq(schema.pickupOrders.tenantId, tenantId),
      eq(schema.pickupOrders.id, id),
    ]);
    const row = rows[0];
    if (!row) throw new NotFoundException();
    return this.mapRowDto(row);
  }

  private async queryJoinedRows(conditions: SQL[]) {
    return this.db
      .select(this.joinedSelection())
      .from(schema.pickupOrders)
      .leftJoin(schema.employees, eq(schema.employees.id, schema.pickupOrders.employeeId))
      .leftJoin(schema.kiosks, eq(schema.kiosks.id, schema.pickupOrders.kioskId))
      .leftJoin(
        schema.pickupOrderReasons,
        eq(schema.pickupOrderReasons.id, schema.pickupOrders.writeoffReasonId),
      )
      .where(and(...conditions))
      .orderBy(desc(schema.pickupOrders.createdAt));
  }

  private joinedSelection() {
    return {
      id: schema.pickupOrders.id,
      orderNo: schema.pickupOrders.orderNo,
      employeeName: schema.employees.fullName,
      kioskName: schema.kiosks.name,
      reason: schema.pickupOrders.reason,
      writeoffReasonName: schema.pickupOrderReasons.name,
      itemCount: schema.pickupOrders.itemCount,
      totalPrice: schema.pickupOrders.totalPrice,
      status: schema.pickupOrders.status,
      createdAt: schema.pickupOrders.createdAt,
      exportedAt: schema.pickupOrders.exportedAt,
      syncConflicts: schema.pickupOrders.syncConflicts,
    };
  }

  private mapRowDto(row: {
    id: string;
    orderNo: string;
    employeeName: string | null;
    kioskName: string | null;
    reason: "buy" | "writeoff";
    writeoffReasonName: string | null;
    itemCount: number;
    totalPrice: string | null;
    status: "pending" | "punched" | "writtenoff" | "cancelled";
    createdAt: Date;
    exportedAt: Date | null;
    syncConflicts: { rawKm: string; reason: string }[] | null;
  }): PickupOrderRowDto {
    return {
      id: row.id,
      orderNo: row.orderNo,
      employeeName: row.employeeName ?? "",
      kioskName: row.kioskName ?? "",
      reason: row.reason,
      writeoffReasonName: row.writeoffReasonName,
      itemCount: row.itemCount,
      totalPrice: row.totalPrice,
      status: row.status,
      createdAt: row.createdAt,
      exportedAt: row.exportedAt,
      conflictCount: row.syncConflicts?.length ?? 0,
    };
  }

  /**
   * Persist refused codes so the cabinet can see them. Idempotent on
   * `(tenant, kiosk, deviceSeq)` -- the same key `pickup_orders` uses -- so a
   * replayed sync (a lost response, or a kiosk that keeps retrying a 401)
   * records once rather than once per attempt.
   *
   * `db` is loosely typed so both `this.db` and a transaction handle satisfy
   * it: the partial-refusal call site MUST enlist in the order's own
   * transaction, or a kmKey-race rollback would leave an orphan row.
   */
  private async recordScanRejection(
    db: Pick<Db, "insert">,
    row: {
      tenantId: string;
      kioskId: string;
      employeeId: string | null;
      badgeCode: string | null;
      orderId: string | null;
      deviceSeq: number;
      codes: { rawKm: string; reason: string }[];
      scannedAt: Date;
    },
  ): Promise<void> {
    await db.insert(schema.pickupScanRejections).values(row).onConflictDoNothing();
  }

  /**
   * The badge the order names -> the active employee it belongs to, by
   * whichever of the two identifiers the body carries (see `CreateOrderDto`:
   * exactly one is present, and `badgeCode` is the legacy one).
   *
   * BOTH BRANCHES ASK THE SAME QUESTION of the same row, which is what keeps
   * this change invisible to everything downstream: an active badge of this
   * tenant, held by an active employee. So roster drift between an offline
   * scan and its sync resolves exactly as it always did -- a revoked badge or
   * an archived employee is unresolvable either way, and a card reissued to
   * somebody else in between resolves to its new holder either way.
   */
  private async resolveActiveEmployeeId(
    tenantId: string,
    dto: CreateOrderDto,
  ): Promise<string | undefined> {
    const presented = this.presentedBadge(dto);
    const match =
      "digest" in presented
        ? eq(schema.employeeBadges.badgeHash, await this.badgeHashFor(tenantId, presented.digest))
        : eq(schema.employeeBadges.badgeCode, presented.code);

    const [badge] = await this.db
      .select({ employeeId: schema.employeeBadges.employeeId })
      .from(schema.employeeBadges)
      .innerJoin(
        schema.employees,
        and(
          eq(schema.employees.tenantId, schema.employeeBadges.tenantId),
          eq(schema.employees.id, schema.employeeBadges.employeeId),
        ),
      )
      .where(
        and(
          eq(schema.employeeBadges.tenantId, tenantId),
          match,
          isNull(schema.employeeBadges.revokedAt),
          eq(schema.employees.status, "active"),
        ),
      );
    return badge?.employeeId;
  }

  /**
   * Which of the two identifiers the body names the badge by, as one value the
   * callers below can exhaust.
   *
   * The 400 is unreachable through the HTTP DTO -- `createOrderSchema` already
   * requires exactly one -- but reachable through a direct service call, which
   * this module has (see the kiosk-row lock test). Loud rather than tolerated:
   * a body naming no badge cannot produce a 422 either, because the rejection
   * row that 422 writes has nothing to put in `badge_code`, and the table's
   * `badge_xor_employee` check forbids leaving it null there.
   */
  private presentedBadge(dto: CreateOrderDto): { digest: string } | { code: string } {
    if (dto.badgeDigest !== undefined) return { digest: dto.badgeDigest };
    if (dto.badgeCode !== undefined) return { code: dto.badgeCode };
    throw new BadRequestException("Exactly one of badgeDigest or badgeCode is required");
  }

  /**
   * The stored verifier a digest would equal, rebuilt from the tenant's salt.
   *
   * `employee_badges.badge_hash` is a whole PHC string and the device sends
   * only the digest half, so the comparison is made by rebuilding the string
   * around it rather than by decomposing the column -- an equality the index
   * planner can use, and no PBKDF2 on this path at all.
   *
   * The salt is READ, never minted (`readBadgeSalt`): this runs once per order
   * and has no business writing a row to answer a lookup. A tenant with no
   * salt row has no verifiers either, so the empty string it falls back to
   * matches nothing and the caller's 422 is the correct outcome.
   */
  private async badgeHashFor(tenantId: string, digestB64: string): Promise<string> {
    const salt = await readBadgeSalt(this.db, tenantId);
    if (salt === null) return "";
    return formatPhc(PHC_ITERATIONS, salt, digestB64);
  }

  /**
   * What `pickup_scan_rejections.badge_code` records for a badge that no
   * longer resolves -- the plaintext code wherever the tenant still has the
   * row, which is what makes that column worth reading («so the admin can
   * still tell whose badge was used once the employee is gone from the
   * roster»).
   *
   * A digest is looked up across ALL of the tenant's badges, REVOKED INCLUDED,
   * which is the whole trick: the badge is unresolvable precisely because it
   * was revoked or its employee archived, and neither of those deletes the row
   * (`EmployeesService` only ever sets `revoked_at`). So the case the column
   * exists for is exactly the case this recovers.
   *
   * The digest itself is the fallback, and it is not reachable from a real
   * kiosk: `Idle` refuses to open a session for a badge its cached roster
   * cannot resolve, so every badge a device sends was an active badge of this
   * tenant when the snapshot was taken. A digest matching no row at all means
   * the caller is not a kiosk following that flow, and an opaque token is a
   * truer record of it than a guess. Non-null either way, because the table's
   * `badge_xor_employee` check requires a value whenever `employee_id` is null.
   */
  private async auditBadgeValue(tenantId: string, dto: CreateOrderDto): Promise<string> {
    const presented = this.presentedBadge(dto);
    if (!("digest" in presented)) return presented.code;
    // More than one row can share a hash -- the same code revoked and later
    // reissued -- but they all decode to the same plaintext, so any of them
    // answers the question this column asks.
    const [badge] = await this.db
      .select({ badgeCode: schema.employeeBadges.badgeCode })
      .from(schema.employeeBadges)
      .where(
        and(
          eq(schema.employeeBadges.tenantId, tenantId),
          eq(schema.employeeBadges.badgeHash, await this.badgeHashFor(tenantId, presented.digest)),
        ),
      );
    return badge?.badgeCode ?? presented.digest;
  }

  private async resolveWriteoffReasonId(
    tenantId: string,
    dto: CreateOrderDto,
  ): Promise<string | null> {
    if (dto.reason !== "writeoff") return null;
    if (!dto.writeoffReasonId) {
      throw new BadRequestException("writeoffReasonId is required when reason is writeoff");
    }
    const [reason] = await this.db
      .select({ id: schema.pickupOrderReasons.id })
      .from(schema.pickupOrderReasons)
      .where(
        and(
          eq(schema.pickupOrderReasons.tenantId, tenantId),
          eq(schema.pickupOrderReasons.id, dto.writeoffReasonId),
          eq(schema.pickupOrderReasons.archived, false),
        ),
      );
    if (!reason) throw new BadRequestException("Unknown or archived writeoff reason");
    return reason.id;
  }

  /** Classifies every scan, resolves it against this kiosk's allowlist, and dedups within the request. */
  private async resolveItems(
    tenantId: string,
    kioskId: string,
    items: CreateOrderDto["items"],
  ): Promise<{ conflicts: OrderConflict[]; candidates: ResolvedItem[] }> {
    const parsed: ParsedItem[] = items.map((item) => {
      const result = validatePickupKm(item.rawKm);
      if (result.status === "not_km" || result.status === "incomplete") {
        return { rawKm: item.rawKm, ok: false, conflictReason: result.status };
      }
      return {
        rawKm: item.rawKm,
        ok: true,
        gtin14: result.km.gtin14,
        serial: result.km.serial,
        key: result.key,
      };
    });

    const allowlist = await this.kioskAllowlist(tenantId, kioskId);
    const gtinsToCheck = new Set<string>();
    for (const p of parsed) {
      if (p.ok && !allowlist.has(p.gtin14)) gtinsToCheck.add(p.gtin14);
    }
    const existingGtins =
      gtinsToCheck.size > 0
        ? await this.existingProductGtins(tenantId, Array.from(gtinsToCheck))
        : new Set<string>();

    const conflicts: OrderConflict[] = [];
    const seenKeys = new Set<string>();
    const candidates: ResolvedItem[] = [];
    for (const p of parsed) {
      if (!p.ok) {
        conflicts.push({ rawKm: p.rawKm, reason: p.conflictReason });
        continue;
      }
      const allowed = allowlist.get(p.gtin14);
      if (!allowed) {
        conflicts.push({
          rawKm: p.rawKm,
          reason: existingGtins.has(p.gtin14) ? "not_allowed" : "unknown_product",
        });
        continue;
      }
      if (seenKeys.has(p.key)) {
        conflicts.push({ rawKm: p.rawKm, reason: "duplicate" });
        continue;
      }
      seenKeys.add(p.key);
      candidates.push({
        rawKm: p.rawKm,
        productId: allowed.productId,
        gtin14: p.gtin14,
        serial: p.serial,
        kmKey: p.key,
        unitPrice: allowed.unitPrice,
      });
    }
    return { conflicts, candidates };
  }

  private async kioskAllowlist(
    tenantId: string,
    kioskId: string,
  ): Promise<Map<string, { productId: string; unitPrice: string | null }>> {
    const rows = await this.db
      .select({
        productId: schema.products.id,
        gtin14: schema.products.gtin14,
        unitPrice: schema.products.unitPrice,
      })
      .from(schema.kioskProducts)
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.kioskProducts.tenantId),
          eq(schema.products.id, schema.kioskProducts.productId),
        ),
      )
      .where(
        and(eq(schema.kioskProducts.tenantId, tenantId), eq(schema.kioskProducts.kioskId, kioskId)),
      );
    const map = new Map<string, { productId: string; unitPrice: string | null }>();
    for (const r of rows) map.set(r.gtin14, { productId: r.productId, unitPrice: r.unitPrice });
    return map;
  }

  private async existingProductGtins(tenantId: string, gtins: string[]): Promise<Set<string>> {
    if (gtins.length === 0) return new Set();
    const rows = await this.db
      .select({ gtin14: schema.products.gtin14 })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), inArray(schema.products.gtin14, gtins)));
    return new Set(rows.map((r) => r.gtin14));
  }

  /**
   * Settles the one timestamp that dates an order: honours the device's
   * `createdAt` only while it is plausible, otherwise falls back to server
   * time.
   *
   * `createdAt` exists so an offline-queued order replays with its original
   * scan time instead of the sync moment — a real requirement, so it cannot
   * simply be ignored. But the value also decides which UTC day the order
   * counts against for `applyDayLimit`, which makes an authoritative limit
   * hinge on the least trustworthy clock in the system: an unattended tablet
   * at a factory gate. Left unbounded, moving that tablet's date forward
   * grants its worker a fresh daily allowance, repeatedly, and it works just
   * as well online as offline.
   *
   * So bound it (see the two tolerances above) and clamp OUT of range to
   * server time rather than rejecting the request: the device is offline-first
   * and retries, so a 400 would strand a genuine scan in its sync queue
   * forever over a clock the worker cannot fix. Filing it under server time
   * is the conservative outcome — the order is kept, and the allowance it
   * spends is today's.
   */
  private resolveScanTime(createdAt: string | undefined, kioskId: string): Date {
    const now = new Date();
    if (!createdAt) return now;

    const claimed = new Date(createdAt);
    const skewMs = claimed.getTime() - now.getTime();
    // NaN is unreachable through the HTTP DTO (`z.string().datetime()` has
    // already parsed it) but reachable via direct service calls, and NaN
    // compares false against every bound — so test it explicitly rather than
    // letting an Invalid Date through as "in range".
    const implausible =
      Number.isNaN(claimed.getTime()) ||
      skewMs > CLIENT_CLOCK_AHEAD_TOLERANCE_MS ||
      -skewMs > CLIENT_CLOCK_BEHIND_TOLERANCE_MS;
    if (!implausible) return claimed;

    this.logger.warn(
      `kiosk ${kioskId}: refusing implausible client createdAt ${createdAt} ` +
        `(${Math.round(skewMs / 60_000)} min from server time); filing the order under server time. ` +
        `Check the device's clock.`,
    );
    return now;
  }

  /**
   * Per employee, how much of today's allowance they spent at EVERY KIOSK
   * EXCEPT `kioskId` — the half of the day count the asking kiosk cannot see.
   *
   * WHY IT EXCLUDES THIS KIOSK, since a future reader will be tempted to
   * "fix" it into a total: the device counts its own kiosk's contribution
   * itself, off its journal and its unsynced queue, and adds the two. Split by
   * SOURCE like this, the two halves cannot overlap — no watermark, no
   * timestamp comparison, nothing that can be slightly wrong. A total would be
   * added to a number that already contains it, and double-counting refuses a
   * worker product they are entitled to at a machine with nobody to overrule
   * it. (Under-counting, the other direction, merely defers the refusal to
   * `POST /kiosk/orders`, which remains the authority.) See
   * `KioskBootstrapDto.employees[].takenTodayElsewhere`.
   *
   * The predicates are `applyDayLimit`'s, deliberately identical, so what a
   * device plans with and what the server enforces cannot drift: accepted
   * (non-voided) items, on non-cancelled orders, whose order's
   * `(created_at at time zone 'utc')::date` is `when`'s UTC day.
   *
   * ONE query for the whole roster — grouped, not looped: every paired kiosk
   * bootstraps every five minutes, so a per-employee query here would multiply
   * that by the size of the tenant's roster.
   */
  private async takenTodayElsewhereByEmployee(
    tenantId: string,
    kioskId: string,
    when: Date,
  ): Promise<Map<string, number>> {
    const dateStr = when.toISOString().slice(0, 10);
    const rows = await this.db
      .select({
        employeeId: schema.pickupOrders.employeeId,
        // `::int` because Postgres `count()` is bigint, which node-postgres
        // hands back as a STRING — and a string here would be JSON-encoded as
        // one and silently fail the device's numeric guard, reading as zero.
        taken: sql<number>`count(*)::int`,
      })
      .from(schema.pickupOrderItems)
      .innerJoin(
        schema.pickupOrders,
        and(
          eq(schema.pickupOrders.tenantId, schema.pickupOrderItems.tenantId),
          eq(schema.pickupOrders.id, schema.pickupOrderItems.orderId),
        ),
      )
      .where(
        and(
          eq(schema.pickupOrderItems.tenantId, tenantId),
          ne(schema.pickupOrders.kioskId, kioskId),
          ne(schema.pickupOrders.status, "cancelled"),
          eq(schema.pickupOrderItems.voided, false),
          sql`(${schema.pickupOrders.createdAt} at time zone 'utc')::date = ${dateStr}`,
        ),
      )
      .groupBy(schema.pickupOrders.employeeId);

    return new Map(rows.map((row) => [row.employeeId, row.taken]));
  }

  /** Accepts up to `dayLimitPerEmployee` items for today (UTC), flagging the rest `over_limit`. */
  private async applyDayLimit(
    tenantId: string,
    kioskId: string,
    employeeId: string,
    when: Date,
    candidates: ResolvedItem[],
  ): Promise<{ accepted: ResolvedItem[]; overflowConflicts: OrderConflict[] }> {
    const [kiosk] = await this.db
      .select({ dayLimitPerEmployee: schema.kiosks.dayLimitPerEmployee })
      .from(schema.kiosks)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId)));
    const dayLimit = kiosk?.dayLimitPerEmployee ?? 0;

    const dateStr = when.toISOString().slice(0, 10);
    const existingRows = await this.db
      .select({ id: schema.pickupOrderItems.id })
      .from(schema.pickupOrderItems)
      .innerJoin(
        schema.pickupOrders,
        and(
          eq(schema.pickupOrders.tenantId, schema.pickupOrderItems.tenantId),
          eq(schema.pickupOrders.id, schema.pickupOrderItems.orderId),
        ),
      )
      .where(
        and(
          eq(schema.pickupOrderItems.tenantId, tenantId),
          eq(schema.pickupOrders.employeeId, employeeId),
          ne(schema.pickupOrders.status, "cancelled"),
          eq(schema.pickupOrderItems.voided, false),
          sql`(${schema.pickupOrders.createdAt} at time zone 'utc')::date = ${dateStr}`,
        ),
      );
    let count = existingRows.length;

    const accepted: ResolvedItem[] = [];
    const overflowConflicts: OrderConflict[] = [];
    for (const c of candidates) {
      if (count < dayLimit) {
        accepted.push(c);
        count++;
      } else {
        overflowConflicts.push({ rawKm: c.rawKm, reason: "over_limit" });
      }
    }
    return { accepted, overflowConflicts };
  }

  /**
   * Inserts the order + accepted items in a transaction. If insertion loses a race against
   * another open order for the same kmKey (23505 on pickup_order_items_tenant_kmkey_open_uq),
   * converts every now-conflicting item to a `duplicate` conflict and retries without them.
   *
   * A separate race is possible on (tenantId, kioskId, deviceSeq) itself: two truly-concurrent
   * POSTs with the same idempotency key both pass the pre-SELECT in `createFromKiosk` (TOCTOU),
   * so the loser's INSERT hits `pickup_orders_kiosk_device_seq_uq` (23505). That is NOT a
   * conflict to surface — it means another request already created the order this one wants;
   * re-fetch and return the winner's outcome instead of erroring or creating a duplicate order.
   */
  private async insertOrderWithRetry(
    tenantId: string,
    kioskId: string,
    employeeId: string,
    reason: "buy" | "writeoff",
    writeoffReasonId: string | null,
    deviceSeq: number,
    when: Date,
    items: ResolvedItem[],
    conflicts: OrderConflict[],
  ): Promise<{ orderNo: string; itemCount: number; conflicts?: OrderConflict[] }> {
    let remaining = items;
    for (;;) {
      try {
        return await this.db.transaction(async (tx) => {
          // Lock the kiosk row before inserting. `PairingService.attemptRedeem`
          // takes this SAME row lock before it computes nextDeviceSeq during a
          // re-pair, so the two paths can never interleave: a device that is
          // already past `KioskDeviceGuard` and mid-flight here, inserting its
          // own order, must be accounted for by that MAX(device_seq) read, not
          // raced by it. See the comment at that call site for the full
          // failure this closes -- a replacement device silently losing its
          // first genuine order to a false idempotency-key replay. Scoped to
          // just this one row, for only the remainder of this transaction.
          await tx
            .select({ id: schema.kiosks.id })
            .from(schema.kiosks)
            .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId)))
            .for("update");

          // nextOrderNo's `tx` param is deliberately loosely typed (Task 7) so it
          // doesn't have to import drizzle's transaction type; adapt the real
          // transaction handle's `execute` to that shape at the call site instead
          // of widening `order-number.ts`'s own signature.
          const orderNo = await nextOrderNo(
            { execute: (q) => tx.execute<{ seq: number }>(q as Parameters<typeof tx.execute>[0]) },
            tenantId,
            when,
          );
          const [order] = await tx
            .insert(schema.pickupOrders)
            .values({
              tenantId,
              orderNo,
              kioskId,
              employeeId,
              reason,
              writeoffReasonId,
              status: "pending",
              itemCount: remaining.length,
              totalPrice: computeTotalPrice(remaining),
              deviceSeq,
              createdAt: when,
              syncConflicts: conflicts.length > 0 ? conflicts : null,
            })
            .returning();
          if (!order) throw new Error("Failed to insert pickup order");
          if (remaining.length > 0) {
            await tx.insert(schema.pickupOrderItems).values(
              remaining.map((item) => ({
                tenantId,
                orderId: order.id,
                productId: item.productId,
                gtin14: item.gtin14,
                serial: item.serial,
                rawKm: item.rawKm,
                kmKey: item.kmKey,
                unitPrice: item.unitPrice,
                scannedAt: when,
              })),
            );
          }
          // Same transaction as the order on purpose: the kmKey-race retry
          // below rolls this back with it, so a rejection row can never
          // outlive the order attempt that produced it. `conflicts` is
          // mutated by that retry before it loops, so on the attempt that
          // finally commits it holds the complete set.
          if (conflicts.length > 0) {
            await this.recordScanRejection(tx, {
              tenantId,
              kioskId,
              employeeId,
              badgeCode: null,
              orderId: order.id,
              deviceSeq,
              codes: conflicts,
              scannedAt: when,
            });
          }
          return { orderNo: order.orderNo, itemCount: order.itemCount };
        });
      } catch (error) {
        if (this.isDeviceSeqRace(error)) {
          const [winner] = await this.db
            .select()
            .from(schema.pickupOrders)
            .where(
              and(
                eq(schema.pickupOrders.tenantId, tenantId),
                eq(schema.pickupOrders.kioskId, kioskId),
                eq(schema.pickupOrders.deviceSeq, deviceSeq),
              ),
            );
          if (!winner) throw error; // shouldn't happen, but avoid looping forever
          return { orderNo: winner.orderNo, itemCount: winner.itemCount, conflicts: [] };
        }

        if (!this.isKmKeyRace(error) || remaining.length === 0) throw error;

        const keys = remaining.map((i) => i.kmKey);
        const openRows = await this.db
          .select({ kmKey: schema.pickupOrderItems.kmKey })
          .from(schema.pickupOrderItems)
          .where(
            and(
              eq(schema.pickupOrderItems.tenantId, tenantId),
              eq(schema.pickupOrderItems.voided, false),
              inArray(schema.pickupOrderItems.kmKey, keys),
            ),
          );
        const conflictingKeys = new Set(openRows.map((r) => r.kmKey));
        if (conflictingKeys.size === 0) throw error; // shouldn't happen, but avoid looping forever

        const stillOk: ResolvedItem[] = [];
        for (const item of remaining) {
          if (conflictingKeys.has(item.kmKey)) {
            conflicts.push({ rawKm: item.rawKm, reason: "duplicate" });
          } else {
            stillOk.push(item);
          }
        }
        remaining = stillOk;
        // NOTE: when `remaining` empties here we deliberately fall through and
        // let the next iteration attempt an (item-less) insert. That insert is
        // what reliably distinguishes a genuine all-conflict scan from a
        // concurrent same-deviceSeq duplicate: the latter hits
        // `pickup_orders_kiosk_device_seq_uq` and returns the winner via
        // `isDeviceSeqRace` above. A post-hoc SELECT here cannot make that
        // distinction race-free (the twin's commit may not yet be visible), so
        // the empty-order guard stays at classification time (createFromKiosk's
        // step 5b), which covers the common case without breaking idempotency.
      }
    }
  }

  /** 23505 on pickup_order_items_tenant_kmkey_open_uq -> the code is already open in another order. */
  private isKmKeyRace(error: unknown): boolean {
    const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; constraint?: string } | undefined;
    const code = err?.code || cause?.code;
    const constraint = err?.constraint || cause?.constraint;
    return code === "23505" && constraint === "pickup_order_items_tenant_kmkey_open_uq";
  }

  /** 23505 on pickup_orders_kiosk_device_seq_uq -> lost the idempotency race to a concurrent identical POST. */
  private isDeviceSeqRace(error: unknown): boolean {
    const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; constraint?: string } | undefined;
    const code = err?.code || cause?.code;
    const constraint = err?.constraint || cause?.constraint;
    return code === "23505" && constraint === "pickup_orders_kiosk_device_seq_uq";
  }
}
