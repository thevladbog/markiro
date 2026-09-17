import { DeviceReplacementTargetPairingService } from "./device-replacement-target-pairing.service";
import { DeviceReplacementRecoveryService } from "./device-replacement-recovery.service";
import { DeviceReplacementExecutionService } from "./device-replacement-execution.service";
import { DeviceReplacementReadinessService } from "./device-replacement-readiness.service";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Header,
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
  type DeviceReplacementRecoveryCodeRequest,
  type DeviceReplacementRecoveryCloseRequest,
  type DeviceReplacementPreviewRequest,
  type DeviceReplacementConfirm,
  type DeviceReplacementCancel,
  type DeviceReplacementDrainRequest,
  type DeviceReplacementExecutionPreviewRequest,
  type DeviceReplacementExecuteRequest,
  type DeviceReplacementEmergencyPreviewRequest,
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
  constructor(
    private readonly replacements: DeviceReplacementService,
    private readonly readiness: DeviceReplacementReadinessService,
    private readonly execution: DeviceReplacementExecutionService,
    private readonly recovery: DeviceReplacementRecoveryService,
    private readonly targetPairing: DeviceReplacementTargetPairingService,
  ) {}
  @Post("replacements/:preparationId/target/code")
  @Header("Cache-Control", "no-store")
  @HttpCode(200)
  @ApiOperation({ summary: "issueReplacementTargetCode" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceReplacementContracts.targetCode.response,
    body: platformDeviceReplacementContracts.targetCode.body,
  })
  targetCode(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(platformDeviceReplacementContracts.targetCode.body))
    body: DeviceReplacementRecoveryCodeRequest,
  ) {
    return this.targetPairing.issueCode(tenantId, preparationId, body, actor(request));
  }
  @Post("replacements/:preparationId/recovery/code")
  @Header("Cache-Control", "no-store")
  @HttpCode(200)
  @ApiOperation({ summary: "issueReplacementRecoveryCode" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceReplacementContracts.recoveryCode.response,
    body: platformDeviceReplacementContracts.recoveryCode.body,
  })
  recoveryCode(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(platformDeviceReplacementContracts.recoveryCode.body))
    body: DeviceReplacementRecoveryCodeRequest,
  ) {
    return this.recovery.issueReplacementRecoveryCode(
      tenantId,
      preparationId,
      body,
      actor(request),
    );
  }
  @Post("replacements/:preparationId/recovery/close")
  @HttpCode(200)
  @ApiOperation({ summary: "closeReplacementRecovery" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceReplacementContracts.recoveryClose.response,
    body: platformDeviceReplacementContracts.recoveryClose.body,
  })
  recoveryClose(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(platformDeviceReplacementContracts.recoveryClose.body))
    body: DeviceReplacementRecoveryCloseRequest,
  ) {
    return this.recovery.closeReplacementRecovery(tenantId, preparationId, body, actor(request));
  }
  @Post("replacements/:preparationId/execution/preview")
  @HttpCode(200)
  @ApiOperation({ summary: "previewExecution working device replacement" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceReplacementContracts.executionPreview.response,
    body: platformDeviceReplacementContracts.executionPreview.body,
  })
  executionPreview(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(platformDeviceReplacementContracts.executionPreview.body))
    body: DeviceReplacementExecutionPreviewRequest,
  ) {
    return this.execution.previewExecution(tenantId, preparationId, body, actor(request));
  }
  @Post("replacements/:preparationId/execute")
  @HttpCode(200)
  @ApiOperation({ summary: "executeNormal working device replacement" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceReplacementContracts.execute.response,
    body: platformDeviceReplacementContracts.execute.body,
  })
  execute(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(platformDeviceReplacementContracts.execute.body))
    body: DeviceReplacementExecuteRequest,
  ) {
    return this.execution.executeNormal(tenantId, preparationId, body, actor(request));
  }
  @Post("replacements/:preparationId/emergency/preview")
  @HttpCode(200)
  @ApiOperation({ summary: "previewEmergency working device replacement" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceReplacementContracts.emergencyPreview.response,
    body: platformDeviceReplacementContracts.emergencyPreview.body,
  })
  emergencyPreview(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(platformDeviceReplacementContracts.emergencyPreview.body))
    body: DeviceReplacementEmergencyPreviewRequest,
  ) {
    return this.execution.previewEmergency(tenantId, preparationId, body, actor(request));
  }
  @Post("replacements/:preparationId/emergency/execute")
  @HttpCode(200)
  @ApiOperation({ summary: "executeEmergency working device replacement" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceReplacementContracts.emergencyExecute.response,
    body: platformDeviceReplacementContracts.emergencyExecute.body,
  })
  emergencyExecute(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(platformDeviceReplacementContracts.emergencyExecute.body))
    body: DeviceReplacementExecuteRequest,
  ) {
    return this.execution.executeEmergency(tenantId, preparationId, body, actor(request));
  }
  @Post("replacements/:preparationId/drain")
  @HttpCode(200)
  @ApiOperation({ summary: "Request source device drain readiness" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @PlatformApiProtectedOk({
    response: platformDeviceReplacementContracts.drain.response,
    body: platformDeviceReplacementContracts.drain.body,
  })
  drain(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", new ZodValidationPipe(platformTenantIdSchema)) tenantId: string,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(platformDeviceReplacementContracts.drain.body))
    body: DeviceReplacementDrainRequest,
  ) {
    return this.readiness.requestDrain(tenantId, preparationId, body, actor(request));
  }
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
