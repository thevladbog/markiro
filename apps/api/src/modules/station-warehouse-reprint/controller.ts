import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import {
  warehouseEventBatchSchema,
  warehouseReceiptSchema,
  type WarehouseReprintEvent,
  type WarehouseReprintReceipt,
  warehouseLookupRequestSchema,
  warehouseLookupResultSchema,
  warehouseTemplateCatalogSchema,
  type WarehouseLookupRequest,
  type WarehouseLookupResult,
  type WarehouseTemplateCatalog,
} from "@markiro/domain";
import {
  ApiHttpErrors,
  ApiStationAuth,
  ApiZodBody,
  ApiZodQuery,
  ApiZodResponse,
} from "../../lib/openapi";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { AllowSubscriptionRecovery } from "../../subscriptions/subscription-access-policy";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { WarehouseEventsService } from "./events.service";
import { WarehouseLookupService } from "./lookup.service";
import { WarehouseTemplatesService } from "./templates.service";

export const warehouseTemplateIdsQuerySchema = z.strictObject({
  ids: z
    .string()
    .max(739)
    .describe("Optional comma-separated list of up to 20 template UUIDs to refresh")
    .transform((value) => value.split(","))
    .pipe(z.array(z.uuid().toLowerCase()).min(1).max(20))
    .transform((ids) => [...new Set(ids)])
    .optional(),
});

function scope(req: RequestWithTenant): { tenantId: string; deviceId: string } {
  if (!req.tenantId || !req.deviceId || req.deviceKind !== "station")
    throw new ForbiddenException({ code: "WAREHOUSE_DEVICE_DENIED" });
  return { tenantId: req.tenantId, deviceId: req.deviceId };
}
@ApiTags("station-warehouse-reprint")
@ApiStationAuth()
@Controller("station/warehouse-reprint")
@UseGuards(TenantGuard, StationOnlyGuard, SubscriptionAccessGuard)
@AllowSubscriptionRecovery("station")
export class StationWarehouseReprintController {
  constructor(
    private readonly lookupService: WarehouseLookupService,
    private readonly templatesService: WarehouseTemplatesService,
    private readonly events: WarehouseEventsService,
  ) {}
  @Post("lookup")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiOperation({ summary: "Resolve an existing product or box for label reprint" })
  @ApiZodBody(warehouseLookupRequestSchema)
  @ApiZodResponse({ status: 200, schema: warehouseLookupResultSchema })
  @ApiHttpErrors(400, 401, 403)
  lookup(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(warehouseLookupRequestSchema)) input: WarehouseLookupRequest,
  ): Promise<WarehouseLookupResult> {
    const { tenantId, deviceId } = scope(req);
    return this.lookupService.lookup(tenantId, deviceId, input);
  }
  @Post("event-batches")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiOperation({ summary: "Receive durable warehouse label recovery events" })
  @ApiZodBody(warehouseEventBatchSchema)
  @ApiZodResponse({ status: 200, schema: warehouseReceiptSchema })
  @ApiHttpErrors(400, 401, 403, 409)
  receive(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(warehouseEventBatchSchema))
    input: { protocol: "warehouse-label-reprint-v1"; events: WarehouseReprintEvent[] },
  ): Promise<WarehouseReprintReceipt> {
    const { tenantId, deviceId } = scope(req);
    return this.events.receive(tenantId, deviceId, input.events);
  }
  @Get("templates")
  @ApiOperation({ summary: "Read enabled warehouse reprint templates for the device organisation" })
  @ApiZodQuery(warehouseTemplateIdsQuerySchema)
  @ApiZodResponse({ status: 200, schema: warehouseTemplateCatalogSchema })
  @ApiHttpErrors(400, 401, 403, 413)
  templates(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(warehouseTemplateIdsQuerySchema))
    query: z.infer<typeof warehouseTemplateIdsQuerySchema>,
  ): Promise<WarehouseTemplateCatalog> {
    const { tenantId, deviceId } = scope(req);
    return this.templatesService.templates(tenantId, deviceId, query.ids);
  }
}
