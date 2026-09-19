import { randomUUID } from "node:crypto";
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, desc, eq } from "drizzle-orm";
import { buildChzKmOrderBody, chzUnitTemplateIdFor } from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import { CHZ_CHANNEL_TYPE } from "../signer-agents/chz-constants";
import { ChzOmsTokenService } from "./chz-oms-token.service";
import {
  CHZ_KM_ORDER_NOT_FAILED_CODE,
  CHZ_KM_ORDER_PREFLIGHT_FAILED_CODE,
  type ChzKmIssueDto,
  type ChzKmOrderDto,
  type ChzKmOrderListItemDto,
  type ChzKmOrderPreflightCode,
  type CreateChzKmOrderDto,
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
   */
  async retry(tenantId: string, id: string): Promise<ChzKmOrderDto> {
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
    await this.queue.enqueueChzKmOrder(tenantId, id);
    return this.get(tenantId, id);
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
