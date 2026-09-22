import { DeviceReplacementRecoveryService } from "./device-replacement-recovery.service";
import { DeviceReplacementExecutionService } from "./device-replacement-execution.service";
import { DeviceReplacementReadinessService } from "./device-replacement-readiness.service";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  cabinetDeviceReplacementContracts,
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
  constructor(
    private readonly replacements: DeviceReplacementService,
    private readonly readiness: DeviceReplacementReadinessService,
    private readonly execution: DeviceReplacementExecutionService,
    private readonly recovery: DeviceReplacementRecoveryService,
  ) {}
  @Post("replacements/:preparationId/recovery/code")
  @Header("Cache-Control", "no-store")
  @HttpCode(200)
  @ApiOperation({ summary: "issueReplacementRecoveryCode" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @AllowSubscriptionLicensing("replacement_recovery")
  @ApiZodBody(cabinetDeviceReplacementContracts.recoveryCode.body)
  @ApiZodResponse({ status: 200, schema: cabinetDeviceReplacementContracts.recoveryCode.response })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  recoveryCode(
    @Req() request: RequestWithTenant,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(cabinetDeviceReplacementContracts.recoveryCode.body))
    body: DeviceReplacementRecoveryCodeRequest,
  ) {
    return this.recovery.issueReplacementRecoveryCode(
      request.tenantId!,
      preparationId,
      body,
      actor(request),
    );
  }
  @Post("replacements/:preparationId/recovery/close")
  @HttpCode(200)
  @ApiOperation({ summary: "closeReplacementRecovery" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @AllowSubscriptionLicensing("replacement_recovery")
  @ApiZodBody(cabinetDeviceReplacementContracts.recoveryClose.body)
  @ApiZodResponse({ status: 200, schema: cabinetDeviceReplacementContracts.recoveryClose.response })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  recoveryClose(
    @Req() request: RequestWithTenant,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(cabinetDeviceReplacementContracts.recoveryClose.body))
    body: DeviceReplacementRecoveryCloseRequest,
  ) {
    return this.recovery.closeReplacementRecovery(
      request.tenantId!,
      preparationId,
      body,
      actor(request),
    );
  }
  @Post("replacements/:preparationId/execution/preview")
  @HttpCode(200)
  @ApiOperation({ summary: "previewExecution working device replacement" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @AllowSubscriptionLicensing("replacement_execute")
  @ApiZodBody(cabinetDeviceReplacementContracts.executionPreview.body)
  @ApiZodValidationError()
  @ApiZodResponse({
    status: 200,
    schema: cabinetDeviceReplacementContracts.executionPreview.response,
  })
  @ApiHttpErrors(401, 403, 404, 409)
  executionPreview(
    @Req() request: RequestWithTenant,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(cabinetDeviceReplacementContracts.executionPreview.body))
    body: DeviceReplacementExecutionPreviewRequest,
  ) {
    return this.execution.previewExecution(request.tenantId!, preparationId, body, actor(request));
  }
  @Post("replacements/:preparationId/execute")
  @HttpCode(200)
  @ApiOperation({ summary: "executeNormal working device replacement" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @AllowSubscriptionLicensing("replacement_execute")
  @ApiZodBody(cabinetDeviceReplacementContracts.execute.body)
  @ApiZodValidationError()
  @ApiZodResponse({ status: 200, schema: cabinetDeviceReplacementContracts.execute.response })
  @ApiHttpErrors(401, 403, 404, 409)
  execute(
    @Req() request: RequestWithTenant,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(cabinetDeviceReplacementContracts.execute.body))
    body: DeviceReplacementExecuteRequest,
  ) {
    return this.execution.executeNormal(request.tenantId!, preparationId, body, actor(request));
  }
  @Post("replacements/:preparationId/emergency/preview")
  @HttpCode(200)
  @ApiOperation({ summary: "previewEmergency working device replacement" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @AllowSubscriptionLicensing("replacement_execute")
  @ApiZodBody(cabinetDeviceReplacementContracts.emergencyPreview.body)
  @ApiZodValidationError()
  @ApiZodResponse({
    status: 200,
    schema: cabinetDeviceReplacementContracts.emergencyPreview.response,
  })
  @ApiHttpErrors(401, 403, 404, 409)
  emergencyPreview(
    @Req() request: RequestWithTenant,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(cabinetDeviceReplacementContracts.emergencyPreview.body))
    body: DeviceReplacementEmergencyPreviewRequest,
  ) {
    return this.execution.previewEmergency(request.tenantId!, preparationId, body, actor(request));
  }
  @Post("replacements/:preparationId/emergency/execute")
  @HttpCode(200)
  @ApiOperation({ summary: "executeEmergency working device replacement" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @AllowSubscriptionLicensing("replacement_execute")
  @ApiZodBody(cabinetDeviceReplacementContracts.emergencyExecute.body)
  @ApiZodValidationError()
  @ApiZodResponse({
    status: 200,
    schema: cabinetDeviceReplacementContracts.emergencyExecute.response,
  })
  @ApiHttpErrors(401, 403, 404, 409)
  emergencyExecute(
    @Req() request: RequestWithTenant,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(cabinetDeviceReplacementContracts.emergencyExecute.body))
    body: DeviceReplacementExecuteRequest,
  ) {
    return this.execution.executeEmergency(request.tenantId!, preparationId, body, actor(request));
  }
  @Post("replacements/:preparationId/drain")
  @HttpCode(200)
  @ApiOperation({ summary: "Request source device drain readiness" })
  @ApiParam({ name: "preparationId", format: "uuid" })
  @AllowSubscriptionLicensing("replacement_drain")
  @ApiZodBody(cabinetDeviceReplacementContracts.drain.body)
  @ApiZodValidationError()
  @ApiZodResponse({ status: 200, schema: cabinetDeviceReplacementContracts.drain.response })
  @ApiHttpErrors(401, 403, 404, 409)
  drain(
    @Req() request: RequestWithTenant,
    @Param("preparationId", new ZodValidationPipe(platformUuidSchema)) preparationId: string,
    @Body(new ZodValidationPipe(cabinetDeviceReplacementContracts.drain.body))
    body: DeviceReplacementDrainRequest,
  ) {
    return this.readiness.requestDrain(request.tenantId!, preparationId, body, actor(request));
  }
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
