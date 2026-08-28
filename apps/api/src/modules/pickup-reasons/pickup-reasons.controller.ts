import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
  ApiZodBody,
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
  createReasonSchema,
  listReasonsOpenApiSchema,
  reasonOpenApiSchema,
  updateReasonSchema,
  type CreateReasonDto,
  type ListReasonsResponseDto,
  type ReasonDto,
  type UpdateReasonDto,
} from "./dto";
import { PickupReasonsService } from "./pickup-reasons.service";

// Cabinet-only: the kiosk device talks to /kiosk/* behind KioskDeviceGuard and
// never needs this module, so no device key — station or kiosk — should reach
// it (see docs/device-key-surface.md).
@ApiTags("pickup-reasons")
@ApiCabinetAuth()
@Controller("pickup-reasons")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class PickupReasonsController {
  constructor(private readonly pickupReasonsService: PickupReasonsService) {}

  @Get()
  @ApiOperation({ summary: "List pickup write-off reasons" })
  @ApiResponse({
    status: 200,
    schema: listReasonsOpenApiSchema,
    description: "Non-archived reasons ordered by sortOrder, then name.",
  })
  @ApiHttpErrors(401, 403)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async listReasons(@Req() req: RequestWithTenant): Promise<ListReasonsResponseDto> {
    return this.pickupReasonsService.listReasons(req.tenantId!);
  }

  @Post()
  @ApiOperation({ summary: "Create a pickup write-off reason" })
  @ApiZodBody(createReasonSchema)
  @ApiResponse({ status: 201, schema: reasonOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async createReason(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createReasonSchema)) body: CreateReasonDto,
  ): Promise<ReasonDto> {
    return this.pickupReasonsService.createReason(req.tenantId!, body);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a pickup write-off reason" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(updateReasonSchema)
  @ApiResponse({ status: 200, schema: reasonOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async updateReason(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateReasonSchema)) body: UpdateReasonDto,
  ): Promise<ReasonDto> {
    return this.pickupReasonsService.updateReason(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({
    summary: "Archive a pickup write-off reason",
    description:
      "Soft-archive: pickup orders reference reasons by FK, so a reason is never hard-deleted.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "The reason was archived." })
  @ApiHttpErrors(401, 403, 404)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async archiveReason(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.pickupReasonsService.archiveReason(req.tenantId!, id);
  }
}
