import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import {
  platformDeviceLicensingContracts,
  platformTenantIdSchema,
  platformUuidSchema,
  type CancelDeviceReservation,
  type DeviceReservationReceipt,
  type WorkingDevicePool,
} from "@markiro/platform-contracts";

import {
  RequirePlatformCapabilities,
  type PlatformPrincipal,
} from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { DeviceLicensingService } from "./device-licensing.service";

function requirePrincipal(request: RequestWithPlatformPrincipal): PlatformPrincipal {
  if (!request.platformPrincipal) throw new UnauthorizedException();
  return request.platformPrincipal;
}

@ApiTags("platform-device-licensing")
@Controller("platform/tenants/:tenantId/device-licensing")
export class PlatformDeviceLicensingController {
  constructor(private readonly licensing: DeviceLicensingService) {}

  @Get()
  @ApiOperation({ summary: "Inspect a tenant's working-device license assignments" })
  @PlatformApiProtectedOk({ response: platformDeviceLicensingContracts.inspect.response })
  @RequirePlatformCapabilities("tenants.read")
  async inspect(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
  ): Promise<WorkingDevicePool> {
    return parsePlatformResponse(
      platformDeviceLicensingContracts.inspect.response,
      await this.licensing.inspect(tenantId, {
        domain: "platform",
        principal: requirePrincipal(request),
      }),
    );
  }

  @Post(":deviceId/cancel-reservation")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel a tenant's never-paired working-device reservation" })
  @ApiParam({ name: "tenantId", description: "Opaque tenant identifier" })
  @ApiParam({ name: "deviceId", format: "uuid" })
  @PlatformApiProtectedOk({
    body: platformDeviceLicensingContracts.cancelReservation.body,
    response: platformDeviceLicensingContracts.cancelReservation.response,
  })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  async cancelReservation(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("deviceId", new ZodValidationPipe(platformUuidSchema)) deviceId: string,
    @Body(new ZodValidationPipe(platformDeviceLicensingContracts.cancelReservation.body))
    body: CancelDeviceReservation,
  ): Promise<DeviceReservationReceipt> {
    return parsePlatformResponse(
      platformDeviceLicensingContracts.cancelReservation.response,
      await this.licensing.cancel(tenantId, deviceId, body, {
        domain: "platform",
        principal: requirePrincipal(request),
      }),
    );
  }
}
