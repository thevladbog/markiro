import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
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
  max,
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
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import { SubscriptionReadOnlyException } from "../../subscriptions/subscription-errors";
import { OrgProfileService } from "../org-profile/org-profile.service";
import type { ProductImageDescriptor } from "../products/dto";
import {
  applyOrderLineLimit,
  classifyResolvedBoxConflicts,
  reclassifyOrderKmKeyRace,
  resolveOrderBoxes,
  type ResolvedOrderBox,
} from "./box-order-resolver";
import { lockPickupOrderTransaction } from "./pickup-order-locks";
import {
  issueOpaqueKioskAdmissionToken,
  kioskAdmissionTokenHash,
  kioskOrderPayloadDigest,
  kioskOrderProcessingLines,
  kioskOrderRequestMarker,
  admissionSequenceWithinWindow,
  findSerializedKioskWinner,
  type KioskRejectionTerminalReason,
} from "./kiosk-admission-proof";
import {
  type CreateOrderAdmissionDto,
  type CreateOrderAdmissionResultDto,
  type CreateOrderDto,
  type CreateOrderResultDto,
  type AcceptedBox,
  type BoxConflict,
  type KioskBootstrapDto,
  type ListPickupOrdersQueryDto,
  type ListPickupOrdersResponseDto,
  type OrderConflict,
  type PickupOrderDetailDto,
  type PickupOrderRowDto,
  type PickupOrderStatus,
  type ResolvePickupOrderDto,
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

type StoredOrderConflict =
  | { rawKm: string; reason: string }
  | {
      source: "box";
      sscc: string;
      bottleCount: number | null;
      reason: string;
    }
  | {
      source: "request";
      version: 2;
      terminalReason: string;
    };
type StoredLineConflict = Exclude<StoredOrderConflict, { source: "request" }>;

interface KioskOrderOutcome {
  orderNo: string;
  itemCount: number;
  conflicts: OrderConflict[];
  boxConflicts: BoxConflict[];
  acceptedBoxes: AcceptedBox[];
  rejected?: true;
  terminalReason?: KioskRejectionTerminalReason;
  writeoffForbidden?: true;
}

export function orderRejectedResponse(input: {
  conflicts: readonly OrderConflict[];
  boxConflicts: readonly BoxConflict[];
}): {
  code: "order_rejected";
  message: string;
  conflicts: readonly OrderConflict[];
  boxConflicts: readonly BoxConflict[];
  acceptedBoxes: [];
} {
  return {
    code: "order_rejected",
    message: "No submitted order lines were accepted",
    conflicts: input.conflicts,
    boxConflicts: input.boxConflicts,
    acceptedBoxes: [],
  };
}

interface EffectivePickupPolicy {
  limited: boolean;
  dayLimit: number;
  canWriteoff: boolean;
}

interface ActiveEmployee {
  id: string;
  pickupPolicy: EffectivePickupPolicy;
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
    employeeId: string;
    employeeName: string;
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
    private readonly entitlements: EntitlementsService,
    private readonly orgProfiles: OrgProfileService,
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
    const processing = kioskOrderProcessingLines(dto);
    // 1. Idempotency: a replayed sync for the same device sequence returns the same order, unchanged.
    const existing = await this.findKioskOrderOutcome(tenantId, kioskId, dto.deviceSeq);
    if (existing) {
      // The order is already durable, so any reservation left behind for this
      // idempotency key has served its only purpose. This also repairs the
      // crash window where the order committed but an older deployment did
      // not consume its admission row.
      await this.consumeKioskAdmission(this.db, tenantId, kioskId, dto.deviceSeq);
      return { ...existing, status: "pending" };
    }
    if (processing.vNext) {
      const rejection = await this.findKioskRejectionOutcome(tenantId, kioskId, dto.deviceSeq);
      if (rejection) this.throwPersistedKioskRejection(rejection);
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
    const serverNow = new Date();
    const access = await this.entitlements.resolveRecovery(tenantId, this.db, serverNow);
    let when: Date;
    if (access.access === "read_only") {
      const claimedAt = dto.createdAt ? new Date(dto.createdAt) : null;
      if (!access.subscription || !claimedAt || !dto.admissionProof) {
        throw new SubscriptionReadOnlyException();
      }
      const [admission] = await this.db
        .select({ claimedAt: schema.kioskOrderAdmissions.claimedAt })
        .from(schema.kioskOrderAdmissions)
        .where(
          and(
            eq(schema.kioskOrderAdmissions.tenantId, tenantId),
            eq(schema.kioskOrderAdmissions.kioskId, kioskId),
            eq(schema.kioskOrderAdmissions.deviceSeq, dto.deviceSeq),
            // The admission row's tenant-scoped FK is the authoritative
            // subscription binding. A later pending renewal may now be the
            // resolver's read-only snapshot, but must not invalidate work
            // reserved under the subscription that was active at issuance.
            eq(schema.kioskOrderAdmissions.tokenHash, kioskAdmissionTokenHash(dto.admissionProof)),
            eq(schema.kioskOrderAdmissions.payloadDigest, kioskOrderPayloadDigest(dto)),
            eq(schema.kioskOrderAdmissions.claimedAt, claimedAt),
          ),
        );
      if (!admission) throw new SubscriptionReadOnlyException();
      when = admission.claimedAt;
    } else {
      when = this.resolveScanTime(dto.createdAt, kioskId, serverNow);
    }

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
    const employee = await this.resolveActiveEmployee(tenantId, dto);
    if (!employee) {
      // An offline sync lands hours after the scan, so the badge may have
      // been revoked in between -- and this 422 fires before a single item
      // is examined, so without this the codes the worker walked off with
      // leave no trace at all. Codes only: an item-less badge heartbeat
      // lost nothing and must not add noise here.
      const hasLines = processing.items.length + processing.boxes.length > 0;
      const badgeCode = hasLines ? await this.auditBadgeValue(tenantId, dto) : null;
      const row = {
        tenantId,
        kioskId,
        employeeId: null,
        badgeCode,
        orderId: null,
        deviceSeq: dto.deviceSeq,
        codes: this.auditSubmittedLines(dto, "unknown_badge"),
        scannedAt: when,
      };
      const winner = processing.vNext
        ? await this.persistSerializedEarlyRejection(row, hasLines)
        : await this.persistLegacyEarlyRejection(row, hasLines);
      if (winner) return this.kioskResultFromOutcome(winner);
      throw new UnprocessableEntityException("Unknown or inactive badge");
    }
    const employeeId = employee.id;

    if (dto.reason === "writeoff" && !employee.pickupPolicy.canWriteoff) {
      const row = {
        tenantId,
        kioskId,
        employeeId,
        badgeCode: null,
        orderId: null,
        deviceSeq: dto.deviceSeq,
        codes: this.auditSubmittedLines(dto, "writeoff_forbidden"),
        scannedAt: when,
      };
      const winner = processing.vNext
        ? await this.persistSerializedEarlyRejection(row, true)
        : await this.persistLegacyEarlyRejection(row, true);
      if (winner) return this.kioskResultFromOutcome(winner);
      throw new UnprocessableEntityException({
        code: "writeoff_forbidden",
        message: "Employee is not allowed to create writeoffs",
      });
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
      const row = {
        tenantId,
        kioskId,
        employeeId,
        badgeCode: null,
        orderId: null,
        deviceSeq: dto.deviceSeq,
        codes: this.auditSubmittedLines(
          dto,
          dto.writeoffReasonId ? "unknown_reason" : "writeoff_reason_required",
        ),
        scannedAt: when,
      };
      const winner = processing.vNext
        ? await this.persistSerializedEarlyRejection(row, true)
        : await this.persistLegacyEarlyRejection(row, true);
      if (winner) return this.kioskResultFromOutcome(winner);
      throw error;
    }

    // 4. Per-item KM validation, allowlist resolution and in-request dedup.
    const { conflicts, candidates } = await this.resolveItems(tenantId, kioskId, processing.items);

    // 5-6. The live employee policy, UTC-day count, allowance decision and
    // insert are one serialized transaction. A kmKey race against another
    // open order converts that item to a duplicate conflict and retries the
    // whole decision against the new committed state.
    const order = await this.insertOrderWithRetry(
      tenantId,
      kioskId,
      employeeId,
      dto.reason,
      writeoffReasonId,
      dto.deviceSeq,
      when,
      candidates,
      conflicts,
      processing.items,
      processing.boxes,
      processing.vNext,
    );

    if (order.writeoffForbidden) {
      throw new UnprocessableEntityException({
        code: "writeoff_forbidden",
        message: "Employee is not allowed to create writeoffs",
      });
    }
    if (order.rejected) this.throwPersistedKioskRejection(order);

    // 7. Outcome. (A device-seq race outcome carries its own `conflicts: []`, mirroring the
    // sequential idempotent path — this request's own conflicts belong to a duplicate submission.)
    return {
      orderNo: order.orderNo,
      status: "pending",
      itemCount: order.itemCount,
      conflicts: order.conflicts,
      boxConflicts: order.boxConflicts,
      acceptedBoxes: order.acceptedBoxes,
    };
  }

  /**
   * Reserves one exact order while write access is still live. The returned
   * bearer is opaque and only its hash is persisted; retrying the same device
   * sequence replaces the prior reservation instead of consuming a finite
   * bootstrap window.
   */
  async attestKioskOrder(
    tenantId: string,
    kioskId: string,
    dto: CreateOrderAdmissionDto,
  ): Promise<CreateOrderAdmissionResultDto> {
    return this.db.transaction(async (tx) => {
      const claimedAt = new Date();
      const requestedToken = dto.admissionNonce;
      if (requestedToken) {
        const [existing] = await tx
          .select({ claimedAt: schema.kioskOrderAdmissions.claimedAt })
          .from(schema.kioskOrderAdmissions)
          .where(
            and(
              eq(schema.kioskOrderAdmissions.tenantId, tenantId),
              eq(schema.kioskOrderAdmissions.kioskId, kioskId),
              eq(schema.kioskOrderAdmissions.deviceSeq, dto.deviceSeq),
              eq(schema.kioskOrderAdmissions.tokenHash, kioskAdmissionTokenHash(requestedToken)),
              eq(schema.kioskOrderAdmissions.payloadDigest, kioskOrderPayloadDigest(dto)),
            ),
          );
        if (existing) {
          return { claimedAt: existing.claimedAt.toISOString(), admissionProof: requestedToken };
        }
      }
      const access = await this.entitlements.assertWriteAccess(tenantId, tx, claimedAt);
      const subscription = access.subscription;
      if (!subscription?.endsAt || claimedAt >= subscription.endsAt) {
        throw new ConflictException({ code: "kiosk_admission_not_required" });
      }
      const token = requestedToken ?? issueOpaqueKioskAdmissionToken();
      // Serialize reservations for this authenticated device. One deviceSeq
      // owns one constant-sized row (the request body itself is not stored),
      // while distinct offline records are bounded by the per-kiosk outstanding
      // cap: a kiosk that queued a genuine backlog can drain it record-by-record.
      await tx
        .select({ id: schema.kiosks.id })
        .from(schema.kiosks)
        .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId)))
        .for("update");
      const durableRow = (
        await tx
          .select({ maxDurableSeq: max(schema.pickupOrders.deviceSeq) })
          .from(schema.pickupOrders)
          .where(
            and(
              eq(schema.pickupOrders.tenantId, tenantId),
              eq(schema.pickupOrders.kioskId, kioskId),
            ),
          )
      )[0];
      const admissionRow = (
        await tx
          .select({
            maxAdmissionSeq: max(schema.kioskOrderAdmissions.deviceSeq),
            outstandingCount: sql<number>`count(*)`,
          })
          .from(schema.kioskOrderAdmissions)
          .where(
            and(
              eq(schema.kioskOrderAdmissions.tenantId, tenantId),
              eq(schema.kioskOrderAdmissions.kioskId, kioskId),
            ),
          )
      )[0];
      const durable = Math.max(
        Number(durableRow?.maxDurableSeq ?? 0),
        Number(admissionRow?.maxAdmissionSeq ?? 0),
      );
      if (
        !admissionSequenceWithinWindow({
          maxDurableSeq: durable,
          outstandingCount: Number(admissionRow?.outstandingCount ?? 0),
          candidate: dto.deviceSeq,
        })
      ) {
        throw new ConflictException({ code: "kiosk_admission_sequence_gap" });
      }
      await tx
        .insert(schema.kioskOrderAdmissions)
        .values({
          tenantId,
          kioskId,
          deviceSeq: dto.deviceSeq,
          subscriptionId: subscription.id,
          tokenHash: kioskAdmissionTokenHash(token),
          payloadDigest: kioskOrderPayloadDigest(dto),
          claimedAt,
          notAfter: subscription.endsAt,
        })
        .onConflictDoUpdate({
          target: [
            schema.kioskOrderAdmissions.tenantId,
            schema.kioskOrderAdmissions.kioskId,
            schema.kioskOrderAdmissions.deviceSeq,
          ],
          set: {
            subscriptionId: subscription.id,
            tokenHash: kioskAdmissionTokenHash(token),
            payloadDigest: kioskOrderPayloadDigest(dto),
            claimedAt,
            notAfter: subscription.endsAt,
            issuedAt: claimedAt,
          },
        });
      return { claimedAt: claimedAt.toISOString(), admissionProof: token };
    });
  }

  /** Offline-cache payload: everything a kiosk needs to operate without a round-trip per scan. */
  async bootstrap(tenantId: string, kioskId: string): Promise<KioskBootstrapDto> {
    // ONE reading of the clock for the whole payload, so `generatedAt` and the
    // UTC day the per-employee counts below are taken over can never straddle
    // a midnight between two `new Date()` calls.
    const generatedAt = new Date();
    const resolvedSubscription = await this.db.transaction((tx) =>
      this.entitlements.resolveRecovery(tenantId, tx, generatedAt),
    );
    const subscription = this.entitlements.snapshotFrom(resolvedSubscription);

    const [[kiosk], [pickupPolicy], branding] = await Promise.all([
      this.db
        .select({
          dayLimitPerEmployee: schema.kiosks.dayLimitPerEmployee,
          showPrices: schema.kiosks.showPrices,
          printEmployeeQrOnSlip: schema.kiosks.printEmployeeQrOnSlip,
        })
        .from(schema.kiosks)
        .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId))),
      this.db
        .select({ limitsEnabled: schema.pickupTenantPolicies.limitsEnabled })
        .from(schema.pickupTenantPolicies)
        .where(eq(schema.pickupTenantPolicies.tenantId, tenantId)),
      this.orgProfiles.getKioskBranding(tenantId),
    ]);
    if (!pickupPolicy) {
      throw new InternalServerErrorException("Tenant pickup policy is not configured");
    }

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
        imageChecksum: schema.mediaAssets.checksum,
        imageByteSize: schema.mediaAssets.byteSize,
        imageWidth: schema.mediaAssets.width,
        imageHeight: schema.mediaAssets.height,
      })
      .from(schema.kioskProducts)
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.kioskProducts.tenantId),
          eq(schema.products.id, schema.kioskProducts.productId),
          // An assignment may predate archiving; the join (not the allowlist
          // table) is where an archived product drops off the kiosk.
          eq(schema.products.archived, false),
        ),
      )
      .leftJoin(
        schema.productImages,
        and(
          eq(schema.productImages.tenantId, schema.kioskProducts.tenantId),
          eq(schema.productImages.productId, schema.kioskProducts.productId),
        ),
      )
      .leftJoin(
        schema.mediaAssets,
        and(
          eq(schema.mediaAssets.id, schema.productImages.assetId),
          eq(schema.mediaAssets.ownerTenantId, tenantId),
          eq(schema.mediaAssets.status, "active"),
        ),
      )
      .where(
        and(eq(schema.kioskProducts.tenantId, tenantId), eq(schema.kioskProducts.kioskId, kioskId)),
      );

    const badgeSalt = await getOrCreateBadgeSalt(this.db, tenantId);

    const employeeRows = await this.db
      .select({ employee: schema.employees, pickupPolicy: schema.employeePickupPolicies })
      .from(schema.employees)
      .leftJoin(
        schema.employeePickupPolicies,
        and(
          eq(schema.employeePickupPolicies.tenantId, schema.employees.tenantId),
          eq(schema.employeePickupPolicies.employeeId, schema.employees.id),
        ),
      )
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.status, "active")))
      .orderBy(asc(schema.employees.fullName));
    if (employeeRows.some((row) => !row.pickupPolicy)) {
      throw new InternalServerErrorException("Employee pickup policy is not configured");
    }

    // Reuses the roster builder's hashing/backfill path, so kiosk and station
    // can never drift on how a badge verifier is produced.
    const badgeHashes = await this.operatorsService.badgeHashesFor(
      tenantId,
      employeeRows.map((row) => row.employee.id),
    );
    const operators = await this.operatorsService.buildRoster(tenantId);

    // ONE grouped query for the entire roster, never one per employee: this
    // runs on every bootstrap and every paired kiosk pulls one every five
    // minutes.
    const takenElsewhere = await this.takenTodayElsewhereByEmployee(tenantId, kioskId, generatedAt);

    return {
      generatedAt: generatedAt.toISOString(),
      subscription,
      branding,
      pickupPolicy,
      config: {
        dayLimitPerEmployee: kiosk?.dayLimitPerEmployee ?? 0,
        showPrices: kiosk?.showPrices ?? true,
        printEmployeeQrOnSlip: kiosk?.printEmployeeQrOnSlip ?? false,
      },
      badgeSalt,
      reasons,
      products: products.map((product) => ({
        id: product.id,
        gtin14: product.gtin14,
        name: product.name,
        unitPrice: product.unitPrice,
        egaisCode: product.egaisCode,
        image:
          product.imageChecksum &&
          product.imageByteSize !== null &&
          product.imageWidth !== null &&
          product.imageHeight !== null
            ? ({
                checksum: product.imageChecksum,
                contentType: "image/webp",
                byteSize: product.imageByteSize,
                width: product.imageWidth,
                height: product.imageHeight,
              } satisfies ProductImageDescriptor)
            : null,
      })),
      employees: employeeRows.map(({ employee, pickupPolicy: employeePolicy }) => {
        if (!employeePolicy) {
          throw new InternalServerErrorException("Employee pickup policy is not configured");
        }
        return {
          id: employee.id,
          fullName: employee.fullName,
          role: employee.role,
          badgeHash: badgeHashes.get(employee.id) ?? null,
          limitMode: employeePolicy.limitMode,
          dayLimit: employeePolicy.dayLimit,
          canWriteoff: employeePolicy.canWriteoff,
          // Absent from the grouped result means this employee took nothing at
          // another kiosk today, which is `0` and not a missing field: the device
          // reads this per employee and adds it to its own count.
          takenTodayElsewhere: takenElsewhere.get(employee.id) ?? 0,
        };
      }),
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

  /** Allowlist- and checksum-protected private image read for a paired kiosk. */
  async getKioskImageRead(
    tenantId: string,
    kioskId: string,
    productId: string,
    checksum: string,
  ): Promise<string> {
    const [asset] = await this.db
      .select({ objectKey: schema.mediaAssets.objectKey })
      .from(schema.kioskProducts)
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.kioskProducts.tenantId),
          eq(schema.products.id, schema.kioskProducts.productId),
        ),
      )
      .innerJoin(
        schema.productImages,
        and(
          eq(schema.productImages.tenantId, schema.products.tenantId),
          eq(schema.productImages.productId, schema.products.id),
        ),
      )
      .innerJoin(
        schema.mediaAssets,
        and(
          eq(schema.mediaAssets.id, schema.productImages.assetId),
          eq(schema.mediaAssets.ownerTenantId, schema.products.tenantId),
          eq(schema.mediaAssets.status, "active"),
          eq(schema.mediaAssets.checksum, checksum),
        ),
      )
      .where(
        and(
          eq(schema.kioskProducts.tenantId, tenantId),
          eq(schema.kioskProducts.kioskId, kioskId),
          eq(schema.kioskProducts.productId, productId),
        ),
      )
      .limit(1);
    if (!asset) throw new NotFoundException();
    return asset.objectKey;
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
        employeeId: schema.pickupOrders.employeeId,
        employeeName: schema.employees.fullName,
        totalPrice: schema.pickupOrders.totalPrice,
      })
      .from(schema.pickupOrders)
      .leftJoin(
        schema.pickupOrderReasons,
        eq(schema.pickupOrderReasons.id, schema.pickupOrders.writeoffReasonId),
      )
      // Inner join can't drop rows: employee_id is NOT NULL with a composite
      // (tenant_id, employee_id) FK, matched here on both columns.
      .innerJoin(
        schema.employees,
        and(
          eq(schema.employees.tenantId, schema.pickupOrders.tenantId),
          eq(schema.employees.id, schema.pickupOrders.employeeId),
        ),
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

    const [commercemlChannel] = await this.db
      .select({ credentialHash: schema.integrationChannels.credentialHash })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, "commerceml"),
        ),
      );
    const commercemlConfigured =
      commercemlChannel?.credentialHash !== null && commercemlChannel !== undefined;

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
      syncConflicts: this.splitStoredConflicts(row.syncConflicts).conflicts,
      boxConflicts: this.splitStoredConflicts(row.syncConflicts).boxConflicts,
      exportHeldProductNames: commercemlConfigured ? exportHeldProductNames : [],
      commercemlConfigured,
    };
  }

  /**
   * Gathers everything `renderPickupSlipHtml` needs for the printed A4 slip:
   * the order + its (non-voided) items joined with product names, the
   * employee's currently-active badge (may be none), and this tenant's
   * `organization` name + `orgProfiles` INN (the profile row may not exist
   * yet — org comes back null in that case, not a 404).
   */
  async slipData(tenantId: string, id: string, printedByUserId: string): Promise<PickupSlipData> {
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
        kioskPrintEmployeeQrOnSlip: schema.kiosks.printEmployeeQrOnSlip,
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
      .select({
        name: schema.organization.name,
        inn: schema.orgProfiles.inn,
        logo: schema.organization.logo,
      })
      .from(schema.organization)
      .leftJoin(schema.orgProfiles, eq(schema.orgProfiles.tenantId, schema.organization.id))
      .where(eq(schema.organization.id, tenantId));

    // The cabinet user who opened the slip — their name pre-fills the
    // "Администратор" signature.
    const [printedBy] = await this.db
      .select({ name: schema.user.name })
      .from(schema.user)
      .where(eq(schema.user.id, printedByUserId));

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
      org: org ? { name: org.name, inn: org.inn, logo: org.logo } : null,
      employee: {
        id: row.employeeId,
        fullName: row.employeeFullName ?? "",
        role: row.employeeRole,
        badgeCode: badge?.badgeCode ?? null,
      },
      kioskName: row.kioskName ?? "",
      reason: row.reason,
      writeoffReasonName: row.writeoffReasonName,
      printEmployeeQrOnSlip: row.kioskPrintEmployeeQrOnSlip ?? false,
      // Derived FROM the (non-voided) items rendered below, not from the stored
      // `pickupOrders.totalPrice` passthrough — that column isn't recomputed by
      // `cancel()` when it voids items, so it would go stale (non-zero total
      // next to an empty table) for a cancelled order. This keeps "Итого"
      // consistent with the table for every status.
      total: computeTotalPrice(itemRows),
      printedByName: printedBy?.name ?? null,
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
    syncConflicts: StoredOrderConflict[] | null;
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
      codes: StoredOrderConflict[];
      scannedAt: Date;
    },
  ): Promise<void> {
    await db.insert(schema.pickupScanRejections).values(row).onConflictDoNothing();
  }

  private async persistLegacyEarlyRejection(
    row: Parameters<PickupOrdersService["recordScanRejection"]>[1],
    hasLines: boolean,
  ): Promise<null> {
    await this.db.transaction(async (tx) => {
      if (hasLines) await this.recordScanRejection(tx, row);
      await this.consumeKioskAdmission(tx, row.tenantId, row.kioskId, row.deviceSeq);
    });
    return null;
  }

  /**
   * vNext early failures join the kiosk-row serialization used by normal
   * order creation. This prevents an order and a rejection from both winning
   * the same device sequence while badge/policy/reason state changes.
   * This path takes no employee lock before or after the kiosk lock, so it
   * does not add a reverse edge to registry -> employee/day -> kiosk.
   */
  private async persistSerializedEarlyRejection(
    row: Parameters<PickupOrdersService["recordScanRejection"]>[1],
    hasLines: boolean,
  ): Promise<KioskOrderOutcome | null> {
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.kiosks.id })
        .from(schema.kiosks)
        .where(and(eq(schema.kiosks.tenantId, row.tenantId), eq(schema.kiosks.id, row.kioskId)))
        .for("update");
      const order = await this.findKioskOrderOutcome(row.tenantId, row.kioskId, row.deviceSeq, tx);
      if (order) {
        await this.consumeKioskAdmission(tx, row.tenantId, row.kioskId, row.deviceSeq);
        return order;
      }
      const rejection = await this.findKioskRejectionOutcome(
        row.tenantId,
        row.kioskId,
        row.deviceSeq,
        tx,
      );
      if (rejection) {
        await this.consumeKioskAdmission(tx, row.tenantId, row.kioskId, row.deviceSeq);
        return rejection;
      }
      if (hasLines) await this.recordScanRejection(tx, row);
      await this.consumeKioskAdmission(tx, row.tenantId, row.kioskId, row.deviceSeq);
      return null;
    });
  }

  private kioskResultFromOutcome(outcome: KioskOrderOutcome): CreateOrderResultDto {
    if (outcome.rejected) this.throwPersistedKioskRejection(outcome);
    return {
      orderNo: outcome.orderNo,
      status: "pending",
      itemCount: outcome.itemCount,
      conflicts: outcome.conflicts,
      boxConflicts: outcome.boxConflicts,
      acceptedBoxes: outcome.acceptedBoxes,
    };
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
  private async resolveActiveEmployee(
    tenantId: string,
    dto: CreateOrderDto,
  ): Promise<ActiveEmployee | undefined> {
    const presented = this.presentedBadge(dto);
    const match =
      "digest" in presented
        ? eq(schema.employeeBadges.badgeHash, await this.badgeHashFor(tenantId, presented.digest))
        : eq(schema.employeeBadges.badgeCode, presented.code);

    const [badge] = await this.db
      .select({
        employeeId: schema.employeeBadges.employeeId,
        limitMode: schema.employeePickupPolicies.limitMode,
        dayLimit: schema.employeePickupPolicies.dayLimit,
        canWriteoff: schema.employeePickupPolicies.canWriteoff,
        limitsEnabled: schema.pickupTenantPolicies.limitsEnabled,
      })
      .from(schema.employeeBadges)
      .innerJoin(
        schema.employees,
        and(
          eq(schema.employees.tenantId, schema.employeeBadges.tenantId),
          eq(schema.employees.id, schema.employeeBadges.employeeId),
        ),
      )
      .leftJoin(
        schema.employeePickupPolicies,
        and(
          eq(schema.employeePickupPolicies.tenantId, schema.employees.tenantId),
          eq(schema.employeePickupPolicies.employeeId, schema.employees.id),
        ),
      )
      .leftJoin(
        schema.pickupTenantPolicies,
        eq(schema.pickupTenantPolicies.tenantId, schema.employeeBadges.tenantId),
      )
      .where(
        and(
          eq(schema.employeeBadges.tenantId, tenantId),
          match,
          isNull(schema.employeeBadges.revokedAt),
          eq(schema.employees.status, "active"),
        ),
      );
    if (!badge) return undefined;
    if (badge.limitMode === null || badge.dayLimit === null || badge.canWriteoff === null) {
      throw new InternalServerErrorException("Employee pickup policy is not configured");
    }
    if (badge.limitsEnabled === null) {
      throw new InternalServerErrorException("Tenant pickup policy is not configured");
    }
    return {
      id: badge.employeeId,
      pickupPolicy: {
        limited: badge.limitsEnabled && badge.limitMode === "limited",
        dayLimit: badge.dayLimit,
        canWriteoff: badge.canWriteoff,
      },
    };
  }

  /**
   * Re-reads and pins the policy rows used by the authoritative allowance
   * decision. The badge lookup happens before product resolution so invalid
   * badges can retain their existing rejection semantics; this second read is
   * deliberately inside the serialized order transaction, after its
   * employee/day advisory lock, so a request that waited behind another kiosk
   * never decides from the stale policy snapshot it brought into the wait.
   */
  private async resolveLivePickupPolicy(
    db: Pick<Db, "select">,
    tenantId: string,
    employeeId: string,
  ): Promise<EffectivePickupPolicy> {
    const [employeePolicy] = await db
      .select({
        limitMode: schema.employeePickupPolicies.limitMode,
        dayLimit: schema.employeePickupPolicies.dayLimit,
        canWriteoff: schema.employeePickupPolicies.canWriteoff,
      })
      .from(schema.employeePickupPolicies)
      .where(
        and(
          eq(schema.employeePickupPolicies.tenantId, tenantId),
          eq(schema.employeePickupPolicies.employeeId, employeeId),
        ),
      )
      .for("share");
    if (!employeePolicy) {
      throw new InternalServerErrorException("Employee pickup policy is not configured");
    }

    const [tenantPolicy] = await db
      .select({ limitsEnabled: schema.pickupTenantPolicies.limitsEnabled })
      .from(schema.pickupTenantPolicies)
      .where(eq(schema.pickupTenantPolicies.tenantId, tenantId))
      .for("share");
    if (!tenantPolicy) {
      throw new InternalServerErrorException("Tenant pickup policy is not configured");
    }

    return {
      limited: tenantPolicy.limitsEnabled && employeePolicy.limitMode === "limited",
      dayLimit: employeePolicy.dayLimit,
      canWriteoff: employeePolicy.canWriteoff,
    };
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
          // Mirrors the bootstrap join above: scanned codes of an archived
          // product must stop being admitted into orders, not just vanish
          // from the product list.
          eq(schema.products.archived, false),
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
  private resolveScanTime(createdAt: string | undefined, kioskId: string, now = new Date()): Date {
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

  /** Applies the employee's effective tenant-aware limit for today (UTC). */
  private async countTakenToday(
    db: Pick<Db, "select">,
    tenantId: string,
    employeeId: string,
    when: Date,
  ): Promise<number> {
    const dateStr = when.toISOString().slice(0, 10);
    const existingRows = await db
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
    return existingRows.length;
  }

  /**
   * Serializes one employee's UTC-day allowance across every kiosk, then
   * resolves the live policy, counts accepted items, decides the split and
   * inserts the order inside that same transaction. The advisory key is
   * narrower than a tenant or kiosk lock: only this tenant + employee + UTC
   * date contend, while every other employee and date continues independently.
   *
   * If insertion loses a race against another open kmKey, the failed
   * transaction is rolled back, the newly-conflicting item becomes a
   * `duplicate`, and the complete policy/count/insert decision is retried.
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
    rawItems: CreateOrderDto["items"],
    requestedBoxes: NonNullable<CreateOrderDto["boxes"]>,
    vNext: boolean,
  ): Promise<KioskOrderOutcome> {
    let remaining = [...items];
    const accumulatedConflicts = [...conflicts];
    let remainingBoxes = [...requestedBoxes];
    const accumulatedBoxConflicts: BoxConflict[] = [];
    const maxAttempts = items.length + requestedBoxes.length + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let attemptedAccepted: ResolvedItem[] = [];
      let attemptedBoxes: ResolvedOrderBox[] = [];
      try {
        return await this.db.transaction(async (tx) => {
          const utcDay = when.toISOString().slice(0, 10);
          await lockPickupOrderTransaction(tx, {
            tenantId,
            employeeId,
            utcDay,
          });

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

          // The optimistic lookup at createFromKiosk's entry keeps ordinary
          // replays cheap. This second lookup is the race-free one: it runs
          // after both locks, so a concurrent winner is committed and visible
          // before this request makes any policy or allowance decision.
          const serializedWinner = await findSerializedKioskWinner({
            findOrder: () => this.findKioskOrderOutcome(tenantId, kioskId, deviceSeq, tx),
            ...(vNext
              ? {
                  findRejection: () =>
                    this.findKioskRejectionOutcome(tenantId, kioskId, deviceSeq, tx),
                }
              : {}),
          });
          if (serializedWinner) {
            await this.consumeKioskAdmission(tx, tenantId, kioskId, deviceSeq);
            return serializedWinner;
          }

          const policy = await this.resolveLivePickupPolicy(tx, tenantId, employeeId);
          if (reason === "writeoff" && !policy.canWriteoff) {
            if (rawItems.length + requestedBoxes.length > 0) {
              await this.recordScanRejection(tx, {
                tenantId,
                kioskId,
                employeeId,
                badgeCode: null,
                orderId: null,
                deviceSeq,
                codes: [
                  ...rawItems.map((item) => ({
                    rawKm: item.rawKm,
                    reason: "writeoff_forbidden",
                  })),
                  ...requestedBoxes.map((box) => ({
                    source: "box" as const,
                    sscc: box.sscc,
                    bottleCount: null,
                    reason: "writeoff_forbidden",
                  })),
                  ...(vNext
                    ? [kioskOrderRequestMarker({ boxes: requestedBoxes }, "writeoff_forbidden")!]
                    : []),
                ],
                scannedAt: when,
              });
            }
            await this.consumeKioskAdmission(tx, tenantId, kioskId, deviceSeq);
            return {
              orderNo: "",
              itemCount: 0,
              conflicts: [],
              boxConflicts: [],
              acceptedBoxes: [],
              writeoffForbidden: true as const,
            };
          }

          const resolved = await resolveOrderBoxes(tx, tenantId, remainingBoxes);
          const allMemberKeys = resolved.boxes.flatMap((box) =>
            box.members.map((member) => member.kmKey),
          );
          const keysToCheck = [
            ...new Set([...remaining.map((item) => item.kmKey), ...allMemberKeys]),
          ];
          const usedRows =
            keysToCheck.length === 0
              ? []
              : await tx
                  .select({ kmKey: schema.pickupOrderItems.kmKey })
                  .from(schema.pickupOrderItems)
                  .where(
                    and(
                      eq(schema.pickupOrderItems.tenantId, tenantId),
                      eq(schema.pickupOrderItems.voided, false),
                      inArray(schema.pickupOrderItems.kmKey, keysToCheck),
                    ),
                  );
          const usedKeys = new Set(usedRows.map((row) => row.kmKey));
          const duplicateLooseConflicts: OrderConflict[] = [];
          const uniqueLoose = remaining.filter((item) => {
            if (!usedKeys.has(item.kmKey)) return true;
            duplicateLooseConflicts.push({ rawKm: item.rawKm, reason: "duplicate" });
            return false;
          });
          const boxDedup = classifyResolvedBoxConflicts({
            boxes: resolved.boxes,
            looseKeys: new Set(uniqueLoose.map((item) => item.kmKey)),
            usedKeys,
          });
          const existingCount = await this.countTakenToday(tx, tenantId, employeeId, when);
          const limited = applyOrderLineLimit({
            existingCount,
            dayLimit: policy.dayLimit,
            limited: policy.limited,
            loose: uniqueLoose,
            boxes: boxDedup.accepted,
            looseConflict: (item) => ({ rawKm: item.rawKm, reason: "over_limit" }),
          });
          attemptedAccepted = limited.acceptedLoose;
          attemptedBoxes = limited.acceptedBoxes;
          const attemptConflicts = [
            ...accumulatedConflicts,
            ...duplicateLooseConflicts,
            ...limited.looseConflicts,
          ];
          const attemptBoxConflicts = [
            ...accumulatedBoxConflicts,
            ...resolved.conflicts,
            ...boxDedup.conflicts,
            ...limited.boxConflicts,
          ];
          const storedConflicts = this.joinStoredConflicts(attemptConflicts, attemptBoxConflicts);
          const acceptedBottleCount =
            limited.acceptedLoose.length +
            limited.acceptedBoxes.reduce((total, box) => total + box.bottleCount, 0);

          // A non-empty scan that produced only conflicts must not create an
          // empty pending order. The rejection and admission consumption are
          // committed under the same employee/day lock as the decision.
          if (acceptedBottleCount === 0 && rawItems.length + requestedBoxes.length > 0) {
            await this.recordScanRejection(tx, {
              tenantId,
              kioskId,
              employeeId,
              badgeCode: null,
              orderId: null,
              deviceSeq,
              codes: [
                ...storedConflicts,
                ...(vNext
                  ? [kioskOrderRequestMarker({ boxes: requestedBoxes }, "order_rejected")!]
                  : []),
              ],
              scannedAt: when,
            });
            await this.consumeKioskAdmission(tx, tenantId, kioskId, deviceSeq);
            this.logger.warn(
              `kiosk ${kioskId}: all ${rawItems.length + requestedBoxes.length} submitted line(s) refused for employee ${employeeId} — ${storedConflicts.map((conflict) => conflict.reason).join(", ")}`,
            );
            return {
              orderNo: "",
              itemCount: 0,
              conflicts: attemptConflicts,
              boxConflicts: attemptBoxConflicts,
              acceptedBoxes: [],
              ...(vNext ? { rejected: true as const } : {}),
            };
          }

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
              itemCount: acceptedBottleCount,
              totalPrice: computeTotalPrice([
                ...limited.acceptedLoose,
                ...limited.acceptedBoxes.flatMap((box) =>
                  box.members.map(() => ({ unitPrice: box.unitPrice })),
                ),
              ]),
              deviceSeq,
              createdAt: when,
              syncConflicts: storedConflicts.length > 0 ? storedConflicts : null,
            })
            .returning();
          if (!order) throw new Error("Failed to insert pickup order");
          const orderBoxIds = new Map<string, string>();
          if (limited.acceptedBoxes.length > 0) {
            const insertedBoxes = await tx
              .insert(schema.pickupOrderBoxes)
              .values(
                limited.acceptedBoxes.map((box) => ({
                  tenantId,
                  orderId: order.id,
                  boxId: box.boxId,
                  sscc: box.sscc,
                  productId: box.productId,
                  bottleCount: box.bottleCount,
                  unitPrice: box.unitPrice,
                })),
              )
              .returning({ id: schema.pickupOrderBoxes.id, boxId: schema.pickupOrderBoxes.boxId });
            for (const box of insertedBoxes) orderBoxIds.set(box.boxId, box.id);
            for (const box of limited.acceptedBoxes) {
              if (!orderBoxIds.has(box.boxId)) {
                throw new Error("Failed to persist pickup order box provenance");
              }
            }
          }
          if (acceptedBottleCount > 0) {
            await tx.insert(schema.pickupOrderItems).values([
              ...limited.acceptedLoose.map((item) => ({
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
              ...limited.acceptedBoxes.flatMap((box) => {
                const orderBoxId = orderBoxIds.get(box.boxId);
                if (!orderBoxId) throw new Error("Missing pickup order box provenance");
                return box.members.map((member) => ({
                  tenantId,
                  orderId: order.id,
                  orderBoxId,
                  productId: box.productId,
                  gtin14: member.gtin14,
                  serial: member.serial,
                  rawKm: member.rawKm,
                  kmKey: member.kmKey,
                  unitPrice: box.unitPrice,
                  scannedAt: when,
                }));
              }),
            ]);
          }
          // Same transaction as the order on purpose: the kmKey-race retry
          // below rolls this back with it, so a rejection row can never
          // outlive the order attempt that produced it.
          if (storedConflicts.length > 0) {
            await this.recordScanRejection(tx, {
              tenantId,
              kioskId,
              employeeId,
              badgeCode: null,
              orderId: order.id,
              deviceSeq,
              codes: storedConflicts,
              scannedAt: when,
            });
          }
          await this.consumeKioskAdmission(tx, tenantId, kioskId, deviceSeq);
          return {
            orderNo: order.orderNo,
            itemCount: order.itemCount,
            conflicts: attemptConflicts,
            boxConflicts: attemptBoxConflicts,
            acceptedBoxes: limited.acceptedBoxes
              .map((box) => ({ sscc: box.sscc, bottleCount: box.bottleCount }))
              .toSorted((left, right) => left.sscc.localeCompare(right.sscc)),
          };
        });
      } catch (error) {
        if (this.isDeviceSeqRace(error)) {
          const winner = await this.findKioskOrderOutcome(tenantId, kioskId, deviceSeq);
          if (!winner) throw error; // shouldn't happen, but avoid looping forever
          await this.consumeKioskAdmission(this.db, tenantId, kioskId, deviceSeq);
          return winner;
        }

        if (
          !this.isKmKeyRace(error) ||
          (attemptedAccepted.length === 0 && attemptedBoxes.length === 0)
        )
          throw error;

        const keys = [
          ...attemptedAccepted.map((item) => item.kmKey),
          ...attemptedBoxes.flatMap((box) => box.members.map((member) => member.kmKey)),
        ];
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

        const reclassified = reclassifyOrderKmKeyRace({
          loose: remaining,
          requestedBoxes: remainingBoxes,
          attemptedBoxes,
          conflictingKeys,
        });
        remaining = reclassified.loose;
        accumulatedConflicts.push(...reclassified.looseConflicts);
        remainingBoxes = reclassified.requestedBoxes;
        accumulatedBoxConflicts.push(...reclassified.boxConflicts);
      }
    }
    throw new ConflictException({ code: "pickup_order_retry_exhausted" });
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

  private splitStoredConflicts(stored: readonly StoredOrderConflict[] | null | undefined): {
    conflicts: OrderConflict[];
    boxConflicts: BoxConflict[];
  } {
    const conflicts: OrderConflict[] = [];
    const boxConflicts: BoxConflict[] = [];
    for (const conflict of stored ?? []) {
      if ("source" in conflict) {
        if (conflict.source === "box" && this.isBoxConflictReason(conflict.reason)) {
          boxConflicts.push({
            sscc: conflict.sscc,
            bottleCount: conflict.bottleCount,
            reason: conflict.reason,
          });
        }
        continue;
      }
      if (this.isOrderConflictReason(conflict.reason)) {
        conflicts.push({ rawKm: conflict.rawKm, reason: conflict.reason });
      }
    }
    return { conflicts, boxConflicts };
  }

  private isOrderConflictReason(reason: string): reason is OrderConflict["reason"] {
    return [
      "not_km",
      "incomplete",
      "unknown_product",
      "not_allowed",
      "duplicate",
      "over_limit",
    ].includes(reason);
  }

  private isBoxConflictReason(reason: string): reason is BoxConflict["reason"] {
    return [
      "unknown_box",
      "box_not_closed",
      "box_disassembled",
      "box_contents_changed",
      "mixed_product_box",
      "duplicate",
      "over_limit",
    ].includes(reason);
  }

  private joinStoredConflicts(
    conflicts: readonly OrderConflict[],
    boxConflicts: readonly BoxConflict[],
  ): StoredLineConflict[] {
    return [
      ...conflicts,
      ...boxConflicts.map((conflict) => ({ source: "box" as const, ...conflict })),
    ];
  }

  private auditSubmittedLines(dto: CreateOrderDto, reason: string): StoredOrderConflict[] {
    const processing = kioskOrderProcessingLines(dto);
    const marker = this.isKioskRejectionTerminalReason(reason)
      ? kioskOrderRequestMarker(dto, reason)
      : null;
    return [
      ...processing.items.map((item) => ({ rawKm: item.rawKm, reason })),
      ...processing.boxes.map((box) => ({
        source: "box" as const,
        sscc: box.sscc,
        bottleCount: null,
        reason,
      })),
      ...(marker ? [marker] : []),
    ];
  }

  private async findKioskOrderOutcome(
    tenantId: string,
    kioskId: string,
    deviceSeq: number,
    db: Pick<Db, "select"> = this.db,
  ): Promise<KioskOrderOutcome | null> {
    const [order] = await db
      .select({
        id: schema.pickupOrders.id,
        orderNo: schema.pickupOrders.orderNo,
        itemCount: schema.pickupOrders.itemCount,
        syncConflicts: schema.pickupOrders.syncConflicts,
      })
      .from(schema.pickupOrders)
      .where(
        and(
          eq(schema.pickupOrders.tenantId, tenantId),
          eq(schema.pickupOrders.kioskId, kioskId),
          eq(schema.pickupOrders.deviceSeq, deviceSeq),
        ),
      );
    if (!order) return null;
    const boxes = await db
      .select({
        sscc: schema.pickupOrderBoxes.sscc,
        bottleCount: schema.pickupOrderBoxes.bottleCount,
      })
      .from(schema.pickupOrderBoxes)
      .where(
        and(
          eq(schema.pickupOrderBoxes.tenantId, tenantId),
          eq(schema.pickupOrderBoxes.orderId, order.id),
        ),
      )
      .orderBy(asc(schema.pickupOrderBoxes.createdAt), asc(schema.pickupOrderBoxes.id));
    return {
      orderNo: order.orderNo,
      itemCount: order.itemCount,
      ...this.splitStoredConflicts(order.syncConflicts),
      acceptedBoxes: boxes.toSorted((left, right) => left.sscc.localeCompare(right.sscc)),
    };
  }

  private async findKioskRejectionOutcome(
    tenantId: string,
    kioskId: string,
    deviceSeq: number,
    db: Pick<Db, "select"> = this.db,
  ): Promise<KioskOrderOutcome | null> {
    const [rejection] = await db
      .select({ codes: schema.pickupScanRejections.codes })
      .from(schema.pickupScanRejections)
      .where(
        and(
          eq(schema.pickupScanRejections.tenantId, tenantId),
          eq(schema.pickupScanRejections.kioskId, kioskId),
          eq(schema.pickupScanRejections.deviceSeq, deviceSeq),
        ),
      );
    if (!rejection) return null;
    const stored = rejection.codes as StoredOrderConflict[];
    const marker = stored.find(
      (code): code is Extract<StoredOrderConflict, { source: "request" }> =>
        "source" in code &&
        code.source === "request" &&
        code.version === 2 &&
        this.isKioskRejectionTerminalReason(code.terminalReason),
    );
    const storedBox = stored.find(
      (code): code is Extract<StoredOrderConflict, { source: "box" }> =>
        "source" in code && code.source === "box",
    );
    // Rows written by the first SSCC release predate the request marker but
    // can still be replayed safely when they contain a box discriminator.
    const markerReason =
      marker && this.isKioskRejectionTerminalReason(marker.terminalReason)
        ? marker.terminalReason
        : null;
    const terminalReason = markerReason ?? this.legacyBoxTerminalReason(storedBox?.reason);
    if (!terminalReason) return null;
    return {
      orderNo: "",
      itemCount: 0,
      ...this.splitStoredConflicts(stored),
      acceptedBoxes: [],
      rejected: true,
      terminalReason,
    };
  }

  private isKioskRejectionTerminalReason(reason: string): reason is KioskRejectionTerminalReason {
    return [
      "order_rejected",
      "unknown_badge",
      "writeoff_forbidden",
      "writeoff_reason_required",
      "unknown_reason",
    ].includes(reason);
  }

  private legacyBoxTerminalReason(reason: string | undefined): KioskRejectionTerminalReason | null {
    if (!reason) return null;
    if (this.isKioskRejectionTerminalReason(reason) && reason !== "order_rejected") return reason;
    return this.isBoxConflictReason(reason) ? "order_rejected" : null;
  }

  private throwPersistedKioskRejection(outcome: KioskOrderOutcome): never {
    if (outcome.terminalReason === "unknown_badge") {
      throw new UnprocessableEntityException("Unknown or inactive badge");
    }
    if (outcome.terminalReason === "writeoff_forbidden") {
      throw new UnprocessableEntityException({
        code: "writeoff_forbidden",
        message: "Employee is not allowed to create writeoffs",
      });
    }
    if (outcome.terminalReason === "writeoff_reason_required") {
      throw new BadRequestException("writeoffReasonId is required when reason is writeoff");
    }
    if (outcome.terminalReason === "unknown_reason") {
      throw new BadRequestException("Unknown or archived writeoff reason");
    }
    this.throwRejectedOrder(outcome);
  }

  private throwRejectedOrder(outcome: KioskOrderOutcome): never {
    throw new UnprocessableEntityException(orderRejectedResponse(outcome));
  }

  private async consumeKioskAdmission(
    db: Pick<Db, "delete">,
    tenantId: string,
    kioskId: string,
    deviceSeq: number,
  ): Promise<void> {
    await db
      .delete(schema.kioskOrderAdmissions)
      .where(
        and(
          eq(schema.kioskOrderAdmissions.tenantId, tenantId),
          eq(schema.kioskOrderAdmissions.kioskId, kioskId),
          eq(schema.kioskOrderAdmissions.deviceSeq, deviceSeq),
        ),
      );
  }
}
