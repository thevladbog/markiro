import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  cabinetDeviceLicensingContracts,
  platformUuidSchema,
  type CancelDeviceReservation,
  type DeviceReservationReceipt,
  type WorkingDevicePool,
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
import { DeviceLicensingService } from "./device-licensing.service";

@ApiTags("device-licensing")
@ApiCabinetAuth()
@Controller("device-licensing")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
@AllowSubscriptionLicensing("inspect")
export class DeviceLicensingController {
  constructor(private readonly licensing: DeviceLicensingService) {}

  @Get()
  @ApiOperation({ summary: "Inspect working-device license assignments" })
  @ApiZodResponse({ status: 200, schema: cabinetDeviceLicensingContracts.inspect.response })
  @ApiHttpErrors(401, 403)
  async inspect(@Req() request: RequestWithTenant): Promise<WorkingDevicePool> {
    return cabinetDeviceLicensingContracts.inspect.response.parse(
      await this.licensing.inspect(request.tenantId!, {
        domain: "cabinet",
        id: request.userId!,
      }),
    );
  }

  @Post(":deviceId/cancel-reservation")
  @HttpCode(200)
  @AllowSubscriptionLicensing("cancel_reservation")
  @ApiOperation({ summary: "Cancel a never-paired working-device reservation" })
  @ApiParam({ name: "deviceId", format: "uuid" })
  @ApiZodBody(cabinetDeviceLicensingContracts.cancelReservation.body)
  @ApiZodResponse({
    status: 200,
    schema: cabinetDeviceLicensingContracts.cancelReservation.response,
  })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  async cancelReservation(
    @Req() request: RequestWithTenant,
    @Param("deviceId", new ZodValidationPipe(platformUuidSchema)) deviceId: string,
    @Body(new ZodValidationPipe(cabinetDeviceLicensingContracts.cancelReservation.body))
    body: CancelDeviceReservation,
  ): Promise<DeviceReservationReceipt> {
    return cabinetDeviceLicensingContracts.cancelReservation.response.parse(
      await this.licensing.cancel(request.tenantId!, deviceId, body, {
        domain: "cabinet",
        id: request.userId!,
      }),
    );
  }
}
