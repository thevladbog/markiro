import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { ApiHttpErrors, ApiStationAuth, ApiZodValidationError } from "../../lib/openapi";
import { AllowStationOrPermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  BOX_REGISTRY_REVISION_PATTERN,
  boxRegistryQuerySchema,
  type BoxRegistryQueryDto,
  type KioskBoxRegistryPage,
} from "../kiosk/box-registry.dto";
import { BoxRegistryService } from "../kiosk/box-registry.service";
import type { CreateOrderResultDto } from "../pickup-orders/dto";
import {
  stationWriteoffBootstrapOpenApiSchema,
  stationWriteoffOpenApiSchema,
  stationWriteoffResultOpenApiSchema,
  stationWriteoffSchema,
  type StationWriteoffBootstrapDto,
  type StationWriteoffDto,
} from "./dto";
import { StationWriteoffsService } from "./station-writeoffs.service";

@ApiTags("station-writeoffs")
@Controller()
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class StationWriteoffsController {
  constructor(
    private readonly service: StationWriteoffsService,
    private readonly boxRegistryService: BoxRegistryService,
  ) {}

  @Post("station/writeoffs")
  @UseGuards(StationOnlyGuard)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "File a write-off from a handheld",
    description:
      "Idempotent on (device, deviceSeq): a replayed sync returns the original document instead of filing a second act. `reason` is fixed to `writeoff` server-side, and the operator the body asserts is re-checked against `can_writeoff`.",
  })
  @ApiStationAuth()
  @ApiBody({ schema: stationWriteoffOpenApiSchema })
  @ApiCreatedResponse({ schema: stationWriteoffResultOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 422, 429)
  create(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(stationWriteoffSchema)) body: StationWriteoffDto,
  ): Promise<CreateOrderResultDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.service.create(req.tenantId!, req.deviceId, body);
  }

  @Get("station/writeoff-bootstrap")
  @UseGuards(StationOnlyGuard)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Get the handheld write-off bootstrap",
    description:
      "Reason dictionary, tenant catalogue as GTIN to name, and per-operator write-off permission. Readable while a subscription is read-only: reading the dictionary is not filing work.",
  })
  @ApiStationAuth()
  @ApiOkResponse({ schema: stationWriteoffBootstrapOpenApiSchema })
  @ApiHttpErrors(401, 403, 429)
  bootstrap(@Req() req: RequestWithTenant): Promise<StationWriteoffBootstrapDto> {
    return this.service.bootstrap(req.tenantId!);
  }

  @Get("station/box-registry")
  @UseGuards(StationOnlyGuard)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Sync the handheld box registry",
    description:
      "Revision-bounded, cursor-paged snapshot or delta of the tenant's closed-box registry. Same service and contract as the kiosk route: the registry was always tenant-scoped, never kiosk-scoped.",
  })
  @ApiStationAuth()
  @ApiQuery({
    name: "since",
    required: false,
    schema: { type: "string", pattern: BOX_REGISTRY_REVISION_PATTERN },
    description: "Exclusive tenant registry revision. Omit for a full snapshot.",
  })
  @ApiQuery({
    name: "until",
    required: false,
    schema: { type: "string", pattern: BOX_REGISTRY_REVISION_PATTERN },
    description: "Server-assigned inclusive revision; required unchanged with cursor pages.",
  })
  @ApiQuery({
    name: "cursor",
    required: false,
    schema: { type: "string", maxLength: 1024 },
    description: "Opaque versioned cursor bound to since and until revisions.",
  })
  @ApiHttpErrors(401, 403, 429)
  boxRegistry(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(boxRegistryQuerySchema)) query: BoxRegistryQueryDto,
  ): Promise<KioskBoxRegistryPage> {
    return this.boxRegistryService.list(req.tenantId!, query);
  }
}
