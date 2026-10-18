import { WarehouseUnifiedService } from "./unified.service";
import {
  UNIFIED_REPRINT_PROTOCOL,
  unifiedLookupRequestSchema,
  unifiedLookupResultSchema,
  palletDataBatchSchema,
  palletDataReceiptSchema,
  palletRenderingsV3BatchSchema,
  palletRenderingsV3ReceiptSchema,
  palletEventsV3BatchSchema,
  palletEventsV3ReceiptSchema,
} from "@markiro/domain";
import { WarehousePalletRenderingsService } from "./pallet-renderings.service";
import { WarehousePalletResolutionsService } from "./pallet-resolutions.service";
import {
  PALLET_REPRINT_V2_PROTOCOL,
  PALLET_PRODUCTION_RESOLUTION_PROTOCOL,
  palletTemplateCatalogV2Schema,
  palletLookupV2RequestSchema,
  palletLookupV2ResultSchema,
  palletRenderingsV2BatchSchema,
  palletRenderingsV2ReceiptSchema,
  palletEventsV2BatchSchema,
  palletEventsV2ReceiptSchema,
  palletProductionResolutionsSchema,
  palletProductionResolutionsReceiptSchema,
} from "@markiro/domain";
import { WarehousePalletService } from "./pallet.service";
import {
  PALLET_REPRINT_PROTOCOL,
  PALLET_PRODUCTION_DELIVERY_PROTOCOL,
  palletLookupRequestSchema,
  palletLookupResultSchema,
  palletSourcesBatchSchema,
  palletSourcesReceiptSchema,
  palletEventsBatchSchema,
  palletEventsReceiptSchema,
} from "@markiro/domain";
import { WarehouseLabelFactsService } from "./label-facts.service";
import {
  LABEL_FACTS_PROTOCOL,
  labelFactsBatchSchema,
  labelFactsReceiptSchema,
} from "@markiro/domain";
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
    private readonly labelFacts: WarehouseLabelFactsService,
    private readonly pallets: WarehousePalletService,
    private readonly renderings: WarehousePalletRenderingsService,
    private readonly resolutions: WarehousePalletResolutionsService,
    private readonly unified: WarehouseUnifiedService,
  ) {}
  @Get("source-capabilities")
  @ApiOperation({ summary: "Read supported durable label source protocols" })
  @ApiZodResponse({ status: 200, schema: z.strictObject({ protocols: z.array(z.string()) }) })
  @ApiHttpErrors(401, 403)
  sourceCapabilities() {
    return {
      protocols: [
        UNIFIED_REPRINT_PROTOCOL,
        LABEL_FACTS_PROTOCOL,
        PALLET_REPRINT_PROTOCOL,
        PALLET_PRODUCTION_DELIVERY_PROTOCOL,
        PALLET_REPRINT_V2_PROTOCOL,
        PALLET_PRODUCTION_RESOLUTION_PROTOCOL,
      ],
    };
  }
  @Post("lookup-v3")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiZodBody(unifiedLookupRequestSchema)
  @ApiZodResponse({ status: 200, schema: unifiedLookupResultSchema })
  @ApiHttpErrors(400, 401, 403)
  unifiedLookup(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(unifiedLookupRequestSchema))
    input: z.infer<typeof unifiedLookupRequestSchema>,
  ) {
    const { tenantId, deviceId } = scope(req);
    return this.unified.lookup(tenantId, deviceId, input.operatorId, input.raw);
  }
  @Post("pallet-data-v3")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiZodBody(palletDataBatchSchema)
  @ApiZodResponse({ status: 200, schema: palletDataReceiptSchema })
  @ApiHttpErrors(400, 401, 403)
  palletDataV3(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(palletDataBatchSchema))
    input: z.infer<typeof palletDataBatchSchema>,
  ) {
    const { tenantId, deviceId } = scope(req);
    return this.unified.receiveData(tenantId, deviceId, input);
  }
  @Post("pallet-renderings-v3")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiZodBody(palletRenderingsV3BatchSchema)
  @ApiZodResponse({ status: 200, schema: palletRenderingsV3ReceiptSchema })
  @ApiHttpErrors(400, 401, 403)
  palletRenderingsV3(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(palletRenderingsV3BatchSchema))
    input: z.infer<typeof palletRenderingsV3BatchSchema>,
  ) {
    const { tenantId, deviceId } = scope(req);
    return this.unified.receiveRenderings(tenantId, deviceId, input);
  }
  @Post("pallet-events-v3")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiZodBody(palletEventsV3BatchSchema)
  @ApiZodResponse({ status: 200, schema: palletEventsV3ReceiptSchema })
  @ApiHttpErrors(400, 401, 403)
  palletEventsV3(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(palletEventsV3BatchSchema))
    input: z.infer<typeof palletEventsV3BatchSchema>,
  ) {
    const { tenantId, deviceId } = scope(req);
    return this.pallets.events(tenantId, deviceId, input.entries, UNIFIED_REPRINT_PROTOCOL);
  }
  @Get("pallet-templates-v2")
  @ApiZodResponse({ status: 200, schema: palletTemplateCatalogV2Schema })
  @ApiHttpErrors(401, 403, 413)
  palletTemplatesV2(@Req() req: RequestWithTenant) {
    const { tenantId, deviceId } = scope(req);
    return this.renderings.templates(tenantId, deviceId);
  }
  @Post("pallet-lookup-v2")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiZodBody(palletLookupV2RequestSchema)
  @ApiZodResponse({ status: 200, schema: palletLookupV2ResultSchema })
  @ApiHttpErrors(400, 401, 403)
  palletLookupV2(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(palletLookupV2RequestSchema))
    input: z.infer<typeof palletLookupV2RequestSchema>,
  ) {
    const { tenantId, deviceId } = scope(req);
    return this.renderings.lookup(tenantId, deviceId, input.operatorId, input.raw);
  }
  @Post("pallet-renderings-v2")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiZodBody(palletRenderingsV2BatchSchema)
  @ApiZodResponse({ status: 200, schema: palletRenderingsV2ReceiptSchema })
  @ApiHttpErrors(400, 401, 403)
  palletRenderingsV2(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(palletRenderingsV2BatchSchema))
    input: z.infer<typeof palletRenderingsV2BatchSchema>,
  ) {
    const { tenantId, deviceId } = scope(req);
    return this.renderings.receive(tenantId, deviceId, input.entries);
  }
  @Post("pallet-events-v2")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiZodBody(palletEventsV2BatchSchema)
  @ApiZodResponse({ status: 200, schema: palletEventsV2ReceiptSchema })
  @ApiHttpErrors(400, 401, 403)
  palletEventsV2(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(palletEventsV2BatchSchema))
    input: z.infer<typeof palletEventsV2BatchSchema>,
  ) {
    const { tenantId, deviceId } = scope(req);
    return this.pallets.events(tenantId, deviceId, input.entries, PALLET_REPRINT_V2_PROTOCOL);
  }
  @Post("pallet-production-resolutions")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiZodBody(palletProductionResolutionsSchema)
  @ApiZodResponse({ status: 200, schema: palletProductionResolutionsReceiptSchema })
  @ApiHttpErrors(400, 401, 403)
  palletProductionResolutions(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(palletProductionResolutionsSchema))
    input: z.infer<typeof palletProductionResolutionsSchema>,
  ) {
    const { tenantId, deviceId } = scope(req);
    return this.resolutions.receive(tenantId, deviceId, input.entries);
  }
  @Post("pallet-sources")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiZodBody(palletSourcesBatchSchema)
  @ApiZodResponse({ status: 200, schema: palletSourcesReceiptSchema })
  @ApiHttpErrors(400, 401, 403)
  palletSources(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(palletSourcesBatchSchema))
    input: z.infer<typeof palletSourcesBatchSchema>,
  ) {
    const { tenantId, deviceId } = scope(req);
    return this.pallets.receive(tenantId, deviceId, input.entries, input.productionDelivery);
  }
  @Post("pallet-lookup")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiZodBody(palletLookupRequestSchema)
  @ApiZodResponse({ status: 200, schema: palletLookupResultSchema })
  @ApiHttpErrors(400, 401, 403)
  palletLookup(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(palletLookupRequestSchema))
    input: z.infer<typeof palletLookupRequestSchema>,
  ) {
    const { tenantId, deviceId } = scope(req);
    return this.pallets.lookup(tenantId, deviceId, input.operatorId, input.raw);
  }
  @Post("pallet-events")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiZodBody(palletEventsBatchSchema)
  @ApiZodResponse({ status: 200, schema: palletEventsReceiptSchema })
  @ApiHttpErrors(400, 401, 403)
  palletEvents(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(palletEventsBatchSchema))
    input: z.infer<typeof palletEventsBatchSchema>,
  ) {
    const { tenantId, deviceId } = scope(req);
    return this.pallets.events(tenantId, deviceId, input.entries);
  }
  @Post("label-facts")
  @AllowSubscriptionRecovery("station")
  @HttpCode(200)
  @ApiOperation({ summary: "Receive immutable facts of accepted production labels" })
  @ApiZodBody(labelFactsBatchSchema)
  @ApiZodResponse({ status: 200, schema: labelFactsReceiptSchema })
  @ApiHttpErrors(400, 401, 403)
  receiveFacts(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(labelFactsBatchSchema))
    input: z.infer<typeof labelFactsBatchSchema>,
  ) {
    const { tenantId, deviceId } = scope(req);
    return this.labelFacts.receive(tenantId, deviceId, input.operatorId, input.entries);
  }
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
    return this.templatesService.templates(
      tenantId,
      deviceId,
      query.ids,
      req.get("x-station-capabilities"),
    );
  }
}
