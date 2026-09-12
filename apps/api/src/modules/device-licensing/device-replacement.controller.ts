import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  cabinetDeviceReplacementContracts,
  platformUuidSchema,
  type DeviceReplacementPreviewRequest,
  type DeviceReplacementConfirm,
  type DeviceReplacementCancel,
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
import { DeviceReplacementService } from "./device-replacement.service";
function actor(request: RequestWithTenant) {
  return { domain: "cabinet" as const, id: request.userId! };
}
@ApiTags("device-licensing")
@ApiCabinetAuth()
@Controller("device-licensing")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
@AllowSubscriptionLicensing("inspect")
export class DeviceReplacementController {
  constructor(private readonly replacements: DeviceReplacementService) {}
  @Get("replacements")
  @ApiOperation({ summary: "List device replacement preparation" })
  @ApiZodResponse({ status: 200, schema: cabinetDeviceReplacementContracts.list.response })
  @ApiHttpErrors(401, 403, 404, 409)
  async list(@Req() request: RequestWithTenant) {
    return cabinetDeviceReplacementContracts.list.response.parse(
      await this.replacements.list(request.tenantId!, actor(request)),
    );
  }
  @Post(":deviceId/replacements/preview")
  @HttpCode(200)
  @ApiOperation({ summary: "Preview device replacement preparation" })
  @ApiParam({ name: "deviceId", format: "uuid" })
  @AllowSubscriptionLicensing("replacement_preview")
  @ApiZodBody(cabinetDeviceReplacementContracts.preview.body)
  @ApiZodValidationError()
  @ApiZodResponse({ status: 200, schema: cabinetDeviceReplacementContracts.preview.response })
  @ApiHttpErrors(401, 403, 404, 409)
  async preview(
    @Req() request: RequestWithTenant,
    @Param("deviceId", new ZodValidationPipe(platformUuidSchema)) deviceId: string,
    @Body(new ZodValidationPipe(cabinetDeviceReplacementContracts.preview.body))
    body: DeviceReplacementPreviewRequest,
  ) {
    return cabinetDeviceReplacementContracts.preview.response.parse(
      await this.replacements.preview(request.tenantId!, deviceId, body, actor(request)),
    );
  }
  @Post(":deviceId/replacements/confirm")
  @HttpCode(200)
  @ApiOperation({ summary: "Confirm device replacement preparation" })
  @ApiParam({ name: "deviceId", format: "uuid" })
  @AllowSubscriptionLicensing("replacement_confirm")
  @ApiZodBody(cabinetDeviceReplacementContracts.confirm.body)
  @ApiZodValidationError()
  @ApiZodResponse({ status: 200, schema: cabinetDeviceReplacementContracts.confirm.response })
  @ApiHttpErrors(401, 403, 404, 409)
  async confirm(
    @Req() request: RequestWithTenant,
    @Param("deviceId", new ZodValidationPipe(platformUuidSchema)) deviceId: string,
    @Body(new ZodValidationPipe(cabinetDeviceReplacementContracts.confirm.body))
    body: DeviceReplacementConfirm,
  ) {
    return cabinetDeviceReplacementContracts.confirm.response.parse(
      await this.replacements.confirm(request.tenantId!, deviceId, body, actor(request)),
    );
  }
  @Post("replacements/:preparationId/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel device replacement preparation" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @AllowSubscriptionLicensing("replacement_cancel")
  @ApiZodBody(cabinetDeviceReplacementContracts.cancel.body)
  @ApiZodValidationError()
  @ApiZodResponse({ status: 200, schema: cabinetDeviceReplacementContracts.cancel.response })
  @ApiHttpErrors(401, 403, 404, 409)
  async cancel(
    @Req() request: RequestWithTenant,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(cabinetDeviceReplacementContracts.cancel.body))
    body: DeviceReplacementCancel,
  ) {
    return cabinetDeviceReplacementContracts.cancel.response.parse(
      await this.replacements.cancel(request.tenantId!, preparationId, body, actor(request)),
    );
  }
}
