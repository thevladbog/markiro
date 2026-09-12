import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  cabinetDeviceRetentionContracts,
  type DeviceRetentionPreviewRequest,
  type DeviceRetentionConfirm,
} from "@markiro/platform-contracts";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodResponse,
  ApiZodValidationError,
} from "../../lib/openapi";
import { AllowSubscriptionLicensing } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { DeviceRetentionService } from "./device-retention.service";
function actor(request: RequestWithTenant) {
  return { domain: "cabinet" as const, id: request.userId! };
}
@ApiTags("device-licensing")
@ApiCabinetAuth()
@Controller("device-licensing")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
@AllowSubscriptionLicensing("inspect")
export class DeviceRetentionController {
  constructor(private readonly retentions: DeviceRetentionService) {}
  @Get("retention")
  @ApiOperation({ summary: "List device retention preparation" })
  @ApiZodResponse({ status: 200, schema: cabinetDeviceRetentionContracts.inspect.response })
  @ApiHttpErrors(401, 403, 404, 409)
  async inspect(@Req() request: RequestWithTenant) {
    return cabinetDeviceRetentionContracts.inspect.response.parse(
      await this.retentions.inspect(request.tenantId!, actor(request)),
    );
  }
  @Post("retention/preview")
  @HttpCode(200)
  @RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE, CABINET_CAPABILITY.BILLING_REQUEST)
  @ApiOperation({ summary: "Preview device retention preparation" })
  @AllowSubscriptionLicensing("retention_preview")
  @ApiZodBody(cabinetDeviceRetentionContracts.preview.body)
  @ApiZodValidationError()
  @ApiZodResponse({ status: 200, schema: cabinetDeviceRetentionContracts.preview.response })
  @ApiHttpErrors(401, 403, 404, 409)
  async preview(
    @Req() request: RequestWithTenant,
    @Body(new ZodValidationPipe(cabinetDeviceRetentionContracts.preview.body))
    body: DeviceRetentionPreviewRequest,
  ) {
    return cabinetDeviceRetentionContracts.preview.response.parse(
      await this.retentions.preview(request.tenantId!, body, actor(request)),
    );
  }
  @Post("retention/confirm")
  @HttpCode(200)
  @RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE, CABINET_CAPABILITY.BILLING_REQUEST)
  @ApiOperation({ summary: "Confirm device retention preparation" })
  @AllowSubscriptionLicensing("retention_confirm")
  @ApiZodBody(cabinetDeviceRetentionContracts.confirm.body)
  @ApiZodValidationError()
  @ApiZodResponse({ status: 200, schema: cabinetDeviceRetentionContracts.confirm.response })
  @ApiHttpErrors(401, 403, 404, 409)
  async confirm(
    @Req() request: RequestWithTenant,
    @Body(new ZodValidationPipe(cabinetDeviceRetentionContracts.confirm.body))
    body: DeviceRetentionConfirm,
  ) {
    return cabinetDeviceRetentionContracts.confirm.response.parse(
      await this.retentions.confirm(request.tenantId!, body, actor(request)),
    );
  }
}
