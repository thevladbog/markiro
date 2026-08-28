import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodQuery,
  ApiZodValidationError,
} from "../../lib/openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  listPickupRejectionsOpenApiSchema,
  listPickupRejectionsQuerySchema,
  pickupScanRejectionRowOpenApiSchema,
  type ListPickupRejectionsQueryDto,
  type ListPickupRejectionsResponseDto,
  type PickupScanRejectionRowDto,
} from "./dto";
import { PickupRejectionsService } from "./pickup-rejections.service";

// Cabinet-only: the kiosk device talks to /kiosk/* behind KioskDeviceGuard and
// never needs this module, so no device key — station or kiosk — should reach
// it (see docs/device-key-surface.md).
@ApiTags("pickup-rejections")
@ApiCabinetAuth()
@Controller("pickup-rejections")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class PickupRejectionsController {
  constructor(private readonly pickupRejectionsService: PickupRejectionsService) {}

  @Get()
  @ApiOperation({
    summary: "List pickup scan rejections",
    description:
      "`from`/`to` filter on `syncedAt` (when the server learned), inclusive whole days.",
  })
  @ApiZodQuery(listPickupRejectionsQuerySchema)
  @ApiResponse({
    status: 200,
    schema: listPickupRejectionsOpenApiSchema,
    description: "Rejections, newest sync first.",
  })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async list(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listPickupRejectionsQuerySchema))
    query: ListPickupRejectionsQueryDto,
  ): Promise<ListPickupRejectionsResponseDto> {
    return this.pickupRejectionsService.list(req.tenantId!, query);
  }

  @Post(":id/acknowledge")
  @HttpCode(200)
  @ApiOperation({ summary: "Acknowledge a pickup scan rejection" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 200, schema: pickupScanRejectionRowOpenApiSchema })
  @ApiHttpErrors(400, 401, 403, 404)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async acknowledge(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<PickupScanRejectionRowDto> {
    return this.pickupRejectionsService.acknowledge(req.tenantId!, id, req.userId!);
  }
}
