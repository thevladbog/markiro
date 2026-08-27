import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodValidationError,
} from "../../lib/openapi";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createReasonSchema,
  disaggregationReasonOpenApiSchema,
  listDisaggregationReasonsOpenApiSchema,
  updateReasonSchema,
  type CreateReasonDto,
  type ListReasonsResponseDto,
  type ReasonDto,
  type UpdateReasonDto,
} from "./dto";
import { DisaggregationReasonsService } from "./disaggregation-reasons.service";

// Cabinet-only: the kiosk device talks to /kiosk/* behind KioskDeviceGuard and
// never needs this module, so no device key — station or kiosk — should reach
// it (see docs/device-key-surface.md).
@ApiTags("disaggregation-reasons")
@ApiCabinetAuth()
@Controller("disaggregation-reasons")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class DisaggregationReasonsController {
  constructor(private readonly disaggregationReasonsService: DisaggregationReasonsService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "List disaggregation reasons",
    description: "Non-archived reasons only, ordered by sortOrder then name.",
  })
  @ApiOkResponse({ schema: listDisaggregationReasonsOpenApiSchema })
  @ApiHttpErrors(401, 403)
  async listReasons(@Req() req: RequestWithTenant): Promise<ListReasonsResponseDto> {
    return this.disaggregationReasonsService.listReasons(req.tenantId!);
  }

  @Post()
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Create a disaggregation reason" })
  @ApiZodBody(createReasonSchema)
  @ApiCreatedResponse({ schema: disaggregationReasonOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  async createReason(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createReasonSchema)) body: CreateReasonDto,
  ): Promise<ReasonDto> {
    return this.disaggregationReasonsService.createReason(req.tenantId!, body);
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Update a disaggregation reason" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(updateReasonSchema)
  @ApiOkResponse({ schema: disaggregationReasonOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  async updateReason(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateReasonSchema)) body: UpdateReasonDto,
  ): Promise<ReasonDto> {
    return this.disaggregationReasonsService.updateReason(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({
    summary: "Archive a disaggregation reason",
    description:
      "Soft-archive: documents keep referencing the reason, but it disappears from the list.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "Reason archived." })
  @ApiHttpErrors(401, 403, 404)
  async archiveReason(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.disaggregationReasonsService.archiveReason(req.tenantId!, id);
  }
}
