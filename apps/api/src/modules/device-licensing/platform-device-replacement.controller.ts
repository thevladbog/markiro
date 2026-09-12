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
  platformDeviceReplacementContracts,
  platformTenantIdSchema,
  platformUuidSchema,
  type DeviceReplacementPreviewRequest,
  type DeviceReplacementConfirm,
  type DeviceReplacementCancel,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import { DeviceReplacementService } from "./device-replacement.service";
function actor(request: RequestWithPlatformPrincipal) {
  if (!request.platformPrincipal) throw new UnauthorizedException();
  return { domain: "platform" as const, principal: request.platformPrincipal };
}
@ApiTags("platform-device-licensing")
@Controller("platform/tenants/:tenantId/device-licensing")
export class PlatformDeviceReplacementController {
  constructor(private readonly replacements: DeviceReplacementService) {}
  @Get("replacements")
  @ApiOperation({ summary: "List device replacement preparation" })
  @RequirePlatformCapabilities("tenants.read")
  @PlatformApiProtectedOk({ response: platformDeviceReplacementContracts.list.response })
  async list(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
  ) {
    return platformDeviceReplacementContracts.list.response.parse(
      await this.replacements.list(tenantId, actor(request)),
    );
  }
  @Post(":deviceId/replacements/preview")
  @HttpCode(200)
  @ApiOperation({ summary: "Preview device replacement preparation" })
  @ApiParam({ name: "deviceId", format: "uuid" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceReplacementContracts.preview.response,
    body: platformDeviceReplacementContracts.preview.body,
  })
  async preview(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("deviceId", new ZodValidationPipe(platformUuidSchema)) deviceId: string,
    @Body(new ZodValidationPipe(platformDeviceReplacementContracts.preview.body))
    body: DeviceReplacementPreviewRequest,
  ) {
    return platformDeviceReplacementContracts.preview.response.parse(
      await this.replacements.preview(tenantId, deviceId, body, actor(request)),
    );
  }
  @Post(":deviceId/replacements/confirm")
  @HttpCode(200)
  @ApiOperation({ summary: "Confirm device replacement preparation" })
  @ApiParam({ name: "deviceId", format: "uuid" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceReplacementContracts.confirm.response,
    body: platformDeviceReplacementContracts.confirm.body,
  })
  async confirm(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("deviceId", new ZodValidationPipe(platformUuidSchema)) deviceId: string,
    @Body(new ZodValidationPipe(platformDeviceReplacementContracts.confirm.body))
    body: DeviceReplacementConfirm,
  ) {
    return platformDeviceReplacementContracts.confirm.response.parse(
      await this.replacements.confirm(tenantId, deviceId, body, actor(request)),
    );
  }
  @Post("replacements/:preparationId/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel device replacement preparation" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceReplacementContracts.cancel.response,
    body: platformDeviceReplacementContracts.cancel.body,
  })
  async cancel(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(platformDeviceReplacementContracts.cancel.body))
    body: DeviceReplacementCancel,
  ) {
    return platformDeviceReplacementContracts.cancel.response.parse(
      await this.replacements.cancel(tenantId, preparationId, body, actor(request)),
    );
  }
}
