import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";

import { INVENTORY_PROGRESS_CURSOR_PATTERN } from "@markiro/domain";

import { ApiHttpErrors, ApiStationAuth, ApiZodValidationError } from "../../lib/openapi";
import { AllowSubscriptionRecovery } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { inventoryIdSchema } from "./dto";
import { StationInventoryAccessService } from "./station-inventory-access.service";
import { StationInventoryBundleService } from "./station-inventory-bundle.service";
import {
  joinStationInventoryOpenApiSchema,
  joinStationInventorySchema,
  leaveStationInventoryOpenApiSchema,
  leaveStationInventoryResponseOpenApiSchema,
  leaveStationInventorySchema,
  resolveStationInventoryBarcodeOpenApiSchema,
  resolveStationInventoryBarcodeResponseOpenApiSchema,
  resolveStationInventoryBarcodeSchema,
  stationInventoryBundleCodesOpenApiSchema,
  stationInventoryBundleCodesQuerySchema,
  stationInventoryBundleManifestOpenApiSchema,
  stationInventoryEventBatchOpenApiSchema,
  stationInventoryEventBatchResponseOpenApiSchema,
  stationInventoryEventBatchSchema,
  stationInventoryProgressOpenApiSchema,
  stationInventoryProgressQuerySchema,
  stationInventoryTaskListOpenApiSchema,
  type JoinStationInventoryDto,
  type LeaveStationInventoryDto,
  type LeaveStationInventoryResponseDto,
  type ResolveStationInventoryBarcodeDto,
  type ResolveStationInventoryBarcodeResponseDto,
  type StationInventoryBundleCodesDto,
  type StationInventoryBundleCodesQueryDto,
  type StationInventoryBundleManifestDto,
  type StationInventoryEventBatchDto,
  type StationInventoryEventBatchResponseDto,
  type StationInventoryProgressDto,
  type StationInventoryProgressQueryDto,
  type StationInventoryTaskListDto,
} from "./station-inventory.dto";
import { StationInventorySyncService } from "./station-inventory-sync.service";

@ApiTags("station-inventories")
@ApiStationAuth()
@Controller("station")
@UseGuards(TenantGuard, StationOnlyGuard, SubscriptionAccessGuard)
@AllowSubscriptionRecovery("station")
export class StationInventoriesController {
  constructor(
    private readonly access: StationInventoryAccessService,
    private readonly bundles: StationInventoryBundleService,
    private readonly sync: StationInventorySyncService,
  ) {}

  @Get("inventory-tasks")
  @ApiOperation({
    summary: "List available inventory tasks",
    description:
      "Running inventories on the station's assigned production line; empty when the device has no line.",
  })
  @ApiOkResponse({ schema: stationInventoryTaskListOpenApiSchema })
  @ApiHttpErrors(401, 403)
  list(@Req() req: RequestWithTenant): Promise<StationInventoryTaskListDto> {
    return this.access.list(req.tenantId!, req.deviceLineId ?? null);
  }

  @Post("inventory-tasks/resolve-barcode")
  @HttpCode(200)
  @AllowSubscriptionRecovery("station")
  @ApiOperation({
    summary: "Resolve a scanned barcode to an inventory task",
    description:
      "Flags when the task belongs to a different production line so the station can ask for confirmation.",
  })
  @ApiBody({ schema: resolveStationInventoryBarcodeOpenApiSchema })
  @ApiOkResponse({ schema: resolveStationInventoryBarcodeResponseOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  resolveBarcode(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(resolveStationInventoryBarcodeSchema))
    body: ResolveStationInventoryBarcodeDto,
  ): Promise<ResolveStationInventoryBarcodeResponseDto> {
    return this.access.resolveBarcode(req.tenantId!, req.deviceLineId ?? null, body.barcode);
  }

  @Post("inventories/:id/join")
  @HttpCode(200)
  @AllowSubscriptionRecovery("station")
  @ApiOperation({
    summary: "Join an inventory",
    description: "Registers the device as a participant and returns the offline bundle manifest.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: joinStationInventoryOpenApiSchema })
  @ApiOkResponse({ schema: stationInventoryBundleManifestOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  join(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(joinStationInventorySchema)) body: JoinStationInventoryDto,
  ): Promise<StationInventoryBundleManifestDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.access.join(req.tenantId!, req.deviceId, req.deviceLineId ?? null, id, body);
  }

  @Get("inventories/:id/bundle/manifest")
  @ApiOperation({ summary: "Get the inventory bundle manifest" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: stationInventoryBundleManifestOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  manifest(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
  ): Promise<StationInventoryBundleManifestDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.bundles.getManifest(req.tenantId!, id, req.deviceId);
  }

  @Get("inventories/:id/bundle/codes")
  @ApiOperation({
    summary: "List inventory bundle codes",
    description:
      "Cursor-paginated chunks of the expected-code bundle for offline verification on the station.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiQuery({
    name: "cursor",
    required: false,
    schema: { type: "string", pattern: "^[0-9a-f]{64}$" },
  })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 200, default: 200 },
  })
  @ApiOkResponse({ schema: stationInventoryBundleCodesOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  codes(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Query(new ZodValidationPipe(stationInventoryBundleCodesQuerySchema))
    query: StationInventoryBundleCodesQueryDto,
  ): Promise<StationInventoryBundleCodesDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.bundles.getCodes(req.tenantId!, id, req.deviceId, query);
  }

  @Post("inventories/:id/event-batches")
  @HttpCode(200)
  @AllowSubscriptionRecovery("station")
  @ApiOperation({ summary: "Submit an inventory scan event batch" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: stationInventoryEventBatchOpenApiSchema })
  @ApiOkResponse({ schema: stationInventoryEventBatchResponseOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  eventBatch(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(stationInventoryEventBatchSchema))
    body: StationInventoryEventBatchDto,
  ): Promise<StationInventoryEventBatchResponseDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.sync.ingest(req.tenantId!, req.deviceId, id, body);
  }

  @Get("inventories/:id/progress")
  @ApiOperation({
    summary: "Get incremental inventory progress",
    description: "Cursor-based feed of progress updates for station polling.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiQuery({
    name: "cursor",
    required: false,
    schema: { type: "string", pattern: INVENTORY_PROGRESS_CURSOR_PATTERN },
  })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 200, default: 200 },
  })
  @ApiOkResponse({ schema: stationInventoryProgressOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  progress(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Query(new ZodValidationPipe(stationInventoryProgressQuerySchema))
    query: StationInventoryProgressQueryDto,
  ): Promise<StationInventoryProgressDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.sync.progress(req.tenantId!, req.deviceId, id, query);
  }

  @Post("inventories/:id/leave")
  @HttpCode(200)
  @AllowSubscriptionRecovery("station")
  @ApiOperation({ summary: "Leave an inventory" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: leaveStationInventoryOpenApiSchema })
  @ApiOkResponse({ schema: leaveStationInventoryResponseOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  leave(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(inventoryIdSchema)) id: string,
    @Body(new ZodValidationPipe(leaveStationInventorySchema)) body: LeaveStationInventoryDto,
  ): Promise<LeaveStationInventoryResponseDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.sync.leave(req.tenantId!, req.deviceId, id, body);
  }
}
