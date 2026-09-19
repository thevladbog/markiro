import { randomUUID } from "node:crypto";
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import {
  buildChzKmOrderBody,
  chzUnitTemplateIdFor,
  kmOrderIssueFileName,
  serializeKmCodesCsv,
  serializeKmCodesTxt,
} from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import { SecurityAuditService } from "../../authorization/security-audit.service";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import { CHZ_CHANNEL_TYPE } from "../signer-agents/chz-constants";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import { ChzOmsTokenService } from "./chz-oms-token.service";
import {
  CHZ_KM_ISSUE_INCONSISTENT_CODE,
  CHZ_KM_ISSUE_NOT_EXPORT_CODE,
  CHZ_KM_ISSUE_TOO_MANY_CODE,
  CHZ_KM_ORDER_NOT_COMPLETED_CODE,
  CHZ_KM_ORDER_NOT_FAILED_CODE,
  CHZ_KM_ORDER_PREFLIGHT_FAILED_CODE,
  type ChzKmIssueCodeDto,
  type ChzKmIssueCodesDto,
  type ChzKmIssueDto,
  type ChzKmIssueFileDto,
  type ChzKmOrderDto,
  type ChzKmOrderListItemDto,
  type ChzKmOrderPreflightCode,
  type CreateChzKmOrderDto,
  type IssueChzKmCodesDto,
} from "./dto";

/** A signer task can take a while to sign, and the tenant's agent may be offline; 48h mirrors the export runner's own horizon before an order is abandoned as failed. */
export const ORDER_DEADLINE_MS = 48 * 3600_000;

/**
 * The narrow interface `ChzKmOrdersService` needs to hand an order off to the
 * background runner. `PgBossService.enqueueChzKmOrder` (Task 10) is its real
 * implementation; this indirection exists only to avoid a circular import
 * between this module and `JobsModule` (`PgBossService`'s own worker will
 * need this module's runner, the same shape `ChzExportsModule` already
 * avoids for `run-chz-export`).
 */
export const CHZ_KM_ORDER_QUEUE = "CHZ_KM_ORDER_QUEUE";
export interface ChzKmOrderQueue {
  enqueueChzKmOrder(tenantId: string, orderId: string): Promise<string | null>;
}

interface OrderProduct {
  id: string;
  name: string;
  gtin14: string;
  groupCode: number;
  groupAlias: string;
  templateId: number;
}

interface OrderSettings {
  omsId?: string | undefined;
  omsConnection?: string | undefined;
  omsContactPerson?: string | undefined;
}

@Injectable()
export class ChzKmOrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly omsTokens: ChzOmsTokenService,
    private readonly crypto: ChzCryptoService,
    private readonly audit: SecurityAuditService,
    @Inject(CHZ_KM_ORDER_QUEUE) private readonly queue: ChzKmOrderQueue,
  ) {}

  /**
   * Every blocking condition is reported together, not the first one, so an
   * administrator fixes everything in one pass instead of discovering the
   * next problem after each fix -- the same trade-off
   * `ChzExportsService.preflight` makes for exports.
   */
  async preflight(
    tenantId: string,
    productId: string,
  ): Promise<{ blockedBy: ChzKmOrderPreflightCode[]; product: OrderProduct | null }> {
    const blocked: ChzKmOrderPreflightCode[] = [];
    const settings = await this.loadSettings(tenantId);
    if (!settings.omsId || !settings.omsConnection) blocked.push("OMS_SETTINGS_MISSING");

    const [agent] = await this.db
      .select({ id: schema.chzSignerAgents.id })
      .from(schema.chzSignerAgents)
      .where(
        and(
          eq(schema.chzSignerAgents.tenantId, tenantId),
          eq(schema.chzSignerAgents.status, "active"),
        ),
      )
      .limit(1);
    if (!agent) blocked.push("AGENT_NOT_PAIRED");

    if (!(await this.omsTokens.hasUsableToken(tenantId))) blocked.push("OMS_TOKEN_UNAVAILABLE");

    const [product] = await this.db
      .select({
        id: schema.products.id,
        name: schema.products.name,
        gtin14: schema.products.gtin14,
        archived: schema.products.archived,
        groupCode: schema.products.chzProductGroupCode,
        groupAlias: schema.chzProductGroups.alias,
      })
      .from(schema.products)
      .leftJoin(
        schema.chzProductGroups,
        eq(schema.chzProductGroups.code, schema.products.chzProductGroupCode),
      )
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
    if (!product) return { blockedBy: [...blocked, "PRODUCT_NOT_FOUND"], product: null };

    if (product.archived) blocked.push("PRODUCT_ARCHIVED");
    if (!product.gtin14) blocked.push("PRODUCT_GTIN_MISSING");

    let templateId: number | null = null;
    if (product.groupCode === null || product.groupAlias === null) {
      blocked.push("PRODUCT_GROUP_MISSING");
    } else {
      templateId = chzUnitTemplateIdFor(product.groupAlias);
      if (templateId === null) blocked.push("PRODUCT_GROUP_UNSUPPORTED");
    }

    const resolved =
      templateId === null ||
      !product.gtin14 ||
      product.groupCode === null ||
      product.groupAlias === null
        ? null
        : {
            id: product.id,
            name: product.name,
            gtin14: product.gtin14,
            groupCode: product.groupCode,
            groupAlias: product.groupAlias,
            templateId,
          };
    return { blockedBy: blocked, product: resolved };
  }

  async create(
    tenantId: string,
    actorUserId: string,
    input: CreateChzKmOrderDto,
  ): Promise<ChzKmOrderDto> {
    const { blockedBy, product } = await this.preflight(tenantId, input.productId);
    if (blockedBy.length > 0 || product === null) {
      throw new UnprocessableEntityException({
        code: CHZ_KM_ORDER_PREFLIGHT_FAILED_CODE,
        blockedBy,
      });
    }
    const settings = await this.loadSettings(tenantId);
    const id = randomUUID();
    const requestBody = buildChzKmOrderBody({
      productGroupAlias: product.groupAlias,
      gtin14: product.gtin14,
      quantity: input.quantity,
      templateId: product.templateId,
      contactPerson: input.contactPerson ?? settings.omsContactPerson,
      productionOrderId: id,
    });
    await this.db.insert(schema.chzKmOrders).values({
      id,
      tenantId,
      productId: product.id,
      gtin14: product.gtin14,
      productGroupAlias: product.groupAlias,
      productGroupCode: product.groupCode,
      templateId: product.templateId,
      quantity: input.quantity,
      requestBody,
      createdByUserId: actorUserId,
      deadlineAt: new Date(Date.now() + ORDER_DEADLINE_MS),
    });
    // Ordering codes spends the tenant's СУЗ buffer, so the spec audits it
    // alongside retry and each issue. The row's `created_by_user_id` says the
    // same thing durably; this is the security trail's own copy.
    this.audit.credentialMutation({
      tenantId,
      userId: actorUserId,
      action: "chz_km_order.create",
      resourceId: id,
      outcome: "succeeded",
    });
    await this.queue.enqueueChzKmOrder(tenantId, id);
    return this.get(tenantId, id);
  }

  async list(tenantId: string): Promise<{ orders: ChzKmOrderListItemDto[] }> {
    const rows = await this.db
      .select({
        order: schema.chzKmOrders,
        productName: schema.products.name,
        createdByName: schema.user.name,
      })
      .from(schema.chzKmOrders)
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.chzKmOrders.tenantId),
          eq(schema.products.id, schema.chzKmOrders.productId),
        ),
      )
      .innerJoin(schema.user, eq(schema.user.id, schema.chzKmOrders.createdByUserId))
      .where(eq(schema.chzKmOrders.tenantId, tenantId))
      .orderBy(desc(schema.chzKmOrders.createdAt))
      .limit(200);
    return {
      orders: rows.map((row) => toListItemDto(row.order, row.productName, row.createdByName)),
    };
  }

  async get(tenantId: string, id: string): Promise<ChzKmOrderDto> {
    const [row] = await this.db
      .select({
        order: schema.chzKmOrders,
        productName: schema.products.name,
        createdByName: schema.user.name,
      })
      .from(schema.chzKmOrders)
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.chzKmOrders.tenantId),
          eq(schema.products.id, schema.chzKmOrders.productId),
        ),
      )
      .innerJoin(schema.user, eq(schema.user.id, schema.chzKmOrders.createdByUserId))
      .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, id)));
    if (!row) throw new NotFoundException();

    const issueRows = await this.db
      .select({
        issue: schema.chzKmIssues,
        createdByName: schema.user.name,
      })
      .from(schema.chzKmIssues)
      .innerJoin(schema.user, eq(schema.user.id, schema.chzKmIssues.createdByUserId))
      .where(and(eq(schema.chzKmIssues.tenantId, tenantId), eq(schema.chzKmIssues.orderId, id)))
      .orderBy(desc(schema.chzKmIssues.createdAt));

    return {
      ...toListItemDto(row.order, row.productName, row.createdByName),
      issues: issueRows.map((issueRow) => toIssueDto(issueRow.issue, issueRow.createdByName)),
    };
  }

  /**
   * Retry is only meaningful from `failed`: a `rejected` order is Chestny
   * ZNAK's own verdict on the request, not a transient failure, so the
   * administrator fixes the product and orders again rather than resending
   * the same rejected body. The conditional `UPDATE` is the single point of
   * truth for that rule -- `0` rows updated means the order was not
   * `failed`, not a separate read-then-write race.
   *
   * `omsOrderId` is reset to `null` alongside `errorCode`/`signerTaskId`
   * because the `created` state's own CHECK constraint
   * (`chz_km_orders_state_consistency_check`) requires both to be null: an
   * order that failed after being submitted to СУЗ (so it carries a real
   * `omsOrderId`) must not be written back to `created` with that id still
   * attached, or the update itself would violate the constraint.
   *
   * `attempts` is reset for the same reason as `deadlineAt`: it is a budget
   * for this attempt at the order, not a lifetime counter.
   * `ChzKmOrderRunnerService.startSigning` fails an order whose `attempts`
   * has reached `MAX_SIGN_ATTEMPTS`, and a signer agent that was offline --
   * the ordinary way an order burns that budget -- is exactly the failure an
   * operator presses «Повторить» after fixing. Leaving the counter at five
   * made the retry return 200 and then fail the order again on its very next
   * pass, permanently: the codes could only be had by paying for a new order.
   */
  async retry(tenantId: string, actorUserId: string, id: string): Promise<ChzKmOrderDto> {
    const now = new Date();
    const updated = await this.db
      .update(schema.chzKmOrders)
      .set({
        state: "created",
        omsOrderId: null,
        errorCode: null,
        errorMessage: null,
        signerTaskId: null,
        claimedAt: null,
        attempts: 0,
        deadlineAt: new Date(now.getTime() + ORDER_DEADLINE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.chzKmOrders.tenantId, tenantId),
          eq(schema.chzKmOrders.id, id),
          eq(schema.chzKmOrders.state, "failed"),
        ),
      )
      .returning({ id: schema.chzKmOrders.id });
    if (updated.length === 0) {
      const [existing] = await this.db
        .select({ id: schema.chzKmOrders.id })
        .from(schema.chzKmOrders)
        .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, id)));
      if (!existing) throw new NotFoundException();
      throw new ConflictException({ code: CHZ_KM_ORDER_NOT_FAILED_CODE });
    }
    // Audited here rather than in the controller because this is the one
    // place that knows the order really was re-sent: the conditional UPDATE
    // above refuses an order that is not `failed`. Nothing durable records
    // who retried -- `created_by_user_id` stays the original author -- so
    // this log line is the whole answer to "who re-sent this order", with the
    // order id as the pointer (`SecurityAuditService` carries no metadata).
    this.audit.credentialMutation({
      tenantId,
      userId: actorUserId,
      action: "chz_km_order.retry",
      resourceId: id,
      outcome: "succeeded",
    });
    await this.queue.enqueueChzKmOrder(tenantId, id);
    return this.get(tenantId, id);
  }

  /**
   * Hands the office a contiguous range of the lowest still-available codes.
   *
   * An issue is a permanent record of which codes left the system, so two
   * issues must never contain the same code: a code printed twice becomes two
   * physical units claiming one identity, and the tenant finds out at a
   * Chestny ZNAK reconciliation. `for("update")` on the order row is what
   * makes that true -- a second issue for the same order cannot read
   * `issued_count` until the first has committed its new value -- and the
   * `marked.length` check is the backstop: anything other than exactly `count`
   * still-available rows in the range rolls the whole transaction back rather
   * than hand out a short or overlapping batch.
   */
  async issue(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    input: IssueChzKmCodesDto,
  ): Promise<ChzKmIssueDto> {
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(schema.chzKmOrders)
        .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, orderId)))
        .for("update");
      if (!order) throw new NotFoundException();
      if (order.state !== "completed") {
        throw new ConflictException({ code: CHZ_KM_ORDER_NOT_COMPLETED_CODE });
      }
      const available = order.fetchedCount - order.issuedCount;
      if (input.count > available) {
        throw new ConflictException({ code: CHZ_KM_ISSUE_TOO_MANY_CODE, available });
      }

      // The issue records who released the codes, so the actor's name is read
      // inside the same transaction. `created_by_user_id` references `user.id`,
      // so a missing row here is a broken invariant, not a client's 404.
      const [actor] = await tx
        .select({ name: schema.user.name })
        .from(schema.user)
        .where(eq(schema.user.id, actorUserId));
      if (!actor) throw new Error(`Issuing user ${actorUserId} has no user row`);

      const fromSeq = order.issuedCount + 1;
      const toSeq = order.issuedCount + input.count;
      const [issue] = await tx
        .insert(schema.chzKmIssues)
        .values({
          tenantId,
          orderId,
          kind: input.kind,
          format: input.kind === "export" ? input.format : null,
          fromSeq,
          toSeq,
          count: input.count,
          createdByUserId: actorUserId,
        })
        .returning();
      if (!issue) throw new Error("Expected the inserted chz_km_issues row to be returned");

      const marked = await tx
        .update(schema.chzKmCodes)
        .set({ status: "issued", issueId: issue.id })
        .where(
          and(
            eq(schema.chzKmCodes.tenantId, tenantId),
            eq(schema.chzKmCodes.orderId, orderId),
            eq(schema.chzKmCodes.status, "available"),
            gte(schema.chzKmCodes.seq, fromSeq),
            lte(schema.chzKmCodes.seq, toSeq),
          ),
        )
        .returning({ seq: schema.chzKmCodes.seq });
      if (marked.length !== input.count) {
        // Not CHZ_KM_ISSUE_TOO_MANY: `available` was computed from
        // `issued_count` before this update, and reaching here means that
        // counter disagrees with the codes' statuses, so the number would be
        // fiction. Asking for fewer cannot clear it either -- the already
        // issued sequence number sits below every future range's start.
        throw new ConflictException({ code: CHZ_KM_ISSUE_INCONSISTENT_CODE });
      }

      await tx
        .update(schema.chzKmOrders)
        .set({ issuedCount: toSeq, updatedAt: new Date() })
        .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, orderId)));
      return toIssueDto(issue, actor.name);
    });
  }

  /** The list a browser print page renders. Raw codes, so never logged or journalled. */
  async issueCodes(
    tenantId: string,
    orderId: string,
    issueId: string,
  ): Promise<ChzKmIssueCodesDto> {
    const { issue } = await this.loadIssue(tenantId, orderId, issueId);
    return { codes: await this.decryptIssueCodes(tenantId, orderId, issue) };
  }

  /**
   * The same codes as `issueCodes`, serialised by `@markiro/domain` so the
   * download and any other consumer of an export cannot drift apart. A print
   * issue has no `format` and therefore no file -- 409 rather than inventing
   * one, because the office asked for the wrong artifact, not a missing one.
   */
  async issueFile(tenantId: string, orderId: string, issueId: string): Promise<ChzKmIssueFileDto> {
    const { issue, gtin14 } = await this.loadIssue(tenantId, orderId, issueId);
    const format = issue.format;
    if (issue.kind !== "export" || (format !== "txt" && format !== "csv")) {
      throw new ConflictException({ code: CHZ_KM_ISSUE_NOT_EXPORT_CODE });
    }
    const codes = (await this.decryptIssueCodes(tenantId, orderId, issue)).map(
      (entry) => entry.code,
    );
    return {
      fileName: kmOrderIssueFileName(gtin14, issue.fromSeq, issue.toSeq, format),
      contentType: format === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8",
      bytes: format === "csv" ? serializeKmCodesCsv(codes) : serializeKmCodesTxt(codes),
    };
  }

  /**
   * 404, not 403, for another tenant's issue: possession of an issue id is not
   * authorization, and confirming the id exists would itself leak. The order
   * join also supplies the GTIN the export file is named after.
   */
  private async loadIssue(
    tenantId: string,
    orderId: string,
    issueId: string,
  ): Promise<{ issue: typeof schema.chzKmIssues.$inferSelect; gtin14: string }> {
    const [row] = await this.db
      .select({ issue: schema.chzKmIssues, gtin14: schema.chzKmOrders.gtin14 })
      .from(schema.chzKmIssues)
      .innerJoin(
        schema.chzKmOrders,
        and(
          eq(schema.chzKmOrders.tenantId, schema.chzKmIssues.tenantId),
          eq(schema.chzKmOrders.id, schema.chzKmIssues.orderId),
        ),
      )
      .where(
        and(
          eq(schema.chzKmIssues.tenantId, tenantId),
          eq(schema.chzKmIssues.orderId, orderId),
          eq(schema.chzKmIssues.id, issueId),
        ),
      );
    if (!row) throw new NotFoundException();
    return row;
  }

  /**
   * The AAD has to be byte-identical to the one the runner sealed each code
   * with (`tenantId/orderId/seq`); a mismatch surfaces as a decryption
   * failure, not as wrong data.
   */
  private async decryptIssueCodes(
    tenantId: string,
    orderId: string,
    issue: typeof schema.chzKmIssues.$inferSelect,
  ): Promise<ChzKmIssueCodeDto[]> {
    const issueId = issue.id;
    const rows = await this.db
      .select({
        seq: schema.chzKmCodes.seq,
        encryptedCode: schema.chzKmCodes.encryptedCode,
        codeNonce: schema.chzKmCodes.codeNonce,
        codeTag: schema.chzKmCodes.codeTag,
      })
      .from(schema.chzKmCodes)
      .where(
        and(
          eq(schema.chzKmCodes.tenantId, tenantId),
          eq(schema.chzKmCodes.orderId, orderId),
          eq(schema.chzKmCodes.issueId, issueId),
        ),
      )
      .orderBy(asc(schema.chzKmCodes.seq));
    // The write side makes a short read impossible, so this is the read path
    // refusing to trust that promise: a file named for a range of 500 must
    // never be served with 499 lines, because the difference becomes physical
    // labels that no later check can tell apart.
    if (rows.length !== issue.count) {
      throw new ConflictException({ code: CHZ_KM_ISSUE_INCONSISTENT_CODE });
    }
    return rows.map((row) => ({
      seq: row.seq,
      code: this.crypto.decryptWithAad(`${tenantId}/${orderId}/${row.seq}`, {
        encryptedToken: row.encryptedCode,
        tokenNonce: row.codeNonce,
        tokenTag: row.codeTag,
      }),
    }));
  }

  /**
   * Best-effort parse: an unconfigured or malformed `chestny_znak` channel
   * simply reports every field as absent, which `preflight` turns into
   * `OMS_SETTINGS_MISSING` rather than a 500.
   */
  private async loadSettings(tenantId: string): Promise<OrderSettings> {
    const [channel] = await this.db
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, CHZ_CHANNEL_TYPE),
        ),
      );
    const parsed = chzSignerSettingsSchema.safeParse(channel?.settings ?? {});
    if (!parsed.success) return {};
    return {
      omsId: parsed.data.omsId,
      omsConnection: parsed.data.omsConnection,
      omsContactPerson: parsed.data.omsContactPerson,
    };
  }
}

function toListItemDto(
  order: typeof schema.chzKmOrders.$inferSelect,
  productName: string,
  createdByName: string,
): ChzKmOrderListItemDto {
  return {
    id: order.id,
    productId: order.productId,
    productName,
    gtin14: order.gtin14,
    productGroupAlias: order.productGroupAlias,
    templateId: order.templateId,
    quantity: order.quantity,
    state: order.state,
    omsOrderId: order.omsOrderId,
    bufferStatus: order.bufferStatus,
    bufferExpiresAt: order.bufferExpiresAt ? order.bufferExpiresAt.toISOString() : null,
    availableCodes: order.availableCodes,
    fetchedCount: order.fetchedCount,
    issuedCount: order.issuedCount,
    availableForIssue: order.fetchedCount - order.issuedCount,
    rejectionReason: order.rejectionReason,
    errorCode: order.errorCode,
    errorMessage: order.errorMessage,
    attempts: order.attempts,
    createdBy: { id: order.createdByUserId, name: createdByName },
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

function toIssueDto(
  issue: typeof schema.chzKmIssues.$inferSelect,
  createdByName: string,
): ChzKmIssueDto {
  return {
    id: issue.id,
    kind: issue.kind as ChzKmIssueDto["kind"],
    format: issue.format as ChzKmIssueDto["format"],
    fromSeq: issue.fromSeq,
    toSeq: issue.toSeq,
    count: issue.count,
    createdBy: { id: issue.createdByUserId, name: createdByName },
    createdAt: issue.createdAt.toISOString(),
  };
}
