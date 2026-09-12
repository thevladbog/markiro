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
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  platformDeviceRetentionContracts,
  platformTenantIdSchema,
  type DeviceRetentionPreviewRequest,
  type DeviceRetentionConfirm,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import { DeviceRetentionService } from "./device-retention.service";
function actor(request: RequestWithPlatformPrincipal) {
  if (!request.platformPrincipal) throw new UnauthorizedException();
  return { domain: "platform" as const, principal: request.platformPrincipal };
}
@ApiTags("platform-device-licensing")
@Controller("platform/tenants/:tenantId/device-licensing")
export class PlatformDeviceRetentionController {
  constructor(private readonly retentions: DeviceRetentionService) {}
  @Get("retention")
  @ApiOperation({ summary: "List device retention preparation" })
  @RequirePlatformCapabilities("tenants.read")
  @PlatformApiProtectedOk({ response: platformDeviceRetentionContracts.inspect.response })
  async inspect(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
  ) {
    return platformDeviceRetentionContracts.inspect.response.parse(
      await this.retentions.inspect(tenantId, actor(request)),
    );
  }
  @Post("retention/preview")
  @HttpCode(200)
  @ApiOperation({ summary: "Preview device retention preparation" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceRetentionContracts.preview.response,
    body: platformDeviceRetentionContracts.preview.body,
  })
  async preview(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(platformDeviceRetentionContracts.preview.body))
    body: DeviceRetentionPreviewRequest,
  ) {
    return platformDeviceRetentionContracts.preview.response.parse(
      await this.retentions.preview(tenantId, body, actor(request)),
    );
  }
  @Post("retention/confirm")
  @HttpCode(200)
  @ApiOperation({ summary: "Confirm device retention preparation" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceRetentionContracts.confirm.response,
    body: platformDeviceRetentionContracts.confirm.body,
  })
  async confirm(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(platformDeviceRetentionContracts.confirm.body))
    body: DeviceRetentionConfirm,
  ) {
    return platformDeviceRetentionContracts.confirm.response.parse(
      await this.retentions.confirm(tenantId, body, actor(request)),
    );
  }
}
