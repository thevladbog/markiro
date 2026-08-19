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
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
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
@Controller("disaggregation-reasons")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class DisaggregationReasonsController {
  constructor(private readonly disaggregationReasonsService: DisaggregationReasonsService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async listReasons(@Req() req: RequestWithTenant): Promise<ListReasonsResponseDto> {
    return this.disaggregationReasonsService.listReasons(req.tenantId!);
  }

  @Post()
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async createReason(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createReasonSchema)) body: CreateReasonDto,
  ): Promise<ReasonDto> {
    return this.disaggregationReasonsService.createReason(req.tenantId!, body);
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async updateReason(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateReasonSchema)) body: UpdateReasonDto,
  ): Promise<ReasonDto> {
    return this.disaggregationReasonsService.updateReason(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async archiveReason(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.disaggregationReasonsService.archiveReason(req.tenantId!, id);
  }
}
