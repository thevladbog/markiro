import { GrantEvidenceNativeService } from "./grant-evidence-native.service";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Param,
  ParseUUIDPipe,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  grantEvidenceEnvelopeSchema,
  grantEvidenceReceiptSchema,
  type GrantEvidenceEnvelope,
  deviceGrantRequestSchema,
  taskGrantRequestSchema,
  grantIssueResultSchema,
  grantKeysetResultSchema,
  grantConfigurationSchema,
  type DeviceGrantRequest,
  type TaskGrantRequest,
} from "@markiro/platform-contracts";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import {
  AllowSubscriptionReadOnly,
  AllowSubscriptionRecovery,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { ApiHttpErrors, ApiStationAuth, ApiZodBody, zodApiSchema } from "../../lib/openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import { GrantIssuerService } from "./grant-issuer.service";
import type { GrantCredentialIdentity } from "./credential-epoch";
function identity(req: RequestWithTenant): GrantCredentialIdentity {
  if (
    req.authKind !== "station" ||
    !req.deviceKind ||
    !req.deviceId ||
    !req.tenantId ||
    !req.deviceApiKeyId
  )
    throw new UnauthorizedException();
  return {
    tenantId: req.tenantId,
    deviceId: req.deviceId,
    kind: req.deviceKind,
    apiKeyId: req.deviceApiKeyId,
  };
}
@ApiTags("station")
@Controller("station/grants/v1")
@UseGuards(TenantGuard, StationOnlyGuard, SubscriptionAccessGuard)
@ApiStationAuth()
export class DeviceGrantsController {
  constructor(
    private readonly issuer: GrantIssuerService,
    private readonly evidence: GrantEvidenceNativeService,
  ) {}
  @ApiOperation({ summary: "Issue a signed offline device grant" })
  @Post("device")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @ApiZodBody(deviceGrantRequestSchema)
  @ApiOkResponse({ schema: zodApiSchema(grantIssueResultSchema) })
  @ApiHttpErrors(400, 401, 403, 409, 429)
  device(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(deviceGrantRequestSchema)) body: DeviceGrantRequest,
  ) {
    return this.issuer.issueDevice(identity(req), body.requestId);
  }
  @ApiOperation({ summary: "Issue a signed grant for an authenticated frozen task" })
  @Post("tasks")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @ApiZodBody(taskGrantRequestSchema)
  @ApiOkResponse({ schema: zodApiSchema(grantIssueResultSchema) })
  @ApiHttpErrors(400, 401, 403, 409, 429)
  tasks(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(taskGrantRequestSchema)) body: TaskGrantRequest,
  ) {
    return this.issuer.issueTask(
      identity(req),
      { taskKind: body.taskKind, taskId: body.taskId },
      body.requestId,
    );
  }
  @ApiOperation({ summary: "Refresh authenticated offline grant configuration" })
  @Post("configuration")
  @HttpCode(200)
  @AllowSubscriptionReadOnly("read")
  @ApiZodBody(deviceGrantRequestSchema)
  @ApiOkResponse({ schema: zodApiSchema(grantConfigurationSchema) })
  @ApiHttpErrors(400, 401, 403, 429)
  configuration(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(deviceGrantRequestSchema)) _body: DeviceGrantRequest,
  ) {
    return this.issuer.configuration(identity(req));
  }
  @ApiOperation({ summary: "Read the authenticated offline grant verifier keyset" })
  @Get("keyset")
  @AllowSubscriptionReadOnly("read")
  @ApiOkResponse({ schema: zodApiSchema(grantKeysetResultSchema) })
  @ApiHttpErrors(401, 403, 429)
  keyset(@Req() req: RequestWithTenant) {
    return this.issuer.keyset(identity(req));
  }
  @Post("evidence/scans")
  @HttpCode(200)
  @AllowSubscriptionRecovery("station")
  @ApiOperation({ summary: "Retain negotiated offline evidence and return durable reconciliation" })
  @ApiZodBody(grantEvidenceEnvelopeSchema)
  @ApiOkResponse({ schema: zodApiSchema(grantEvidenceReceiptSchema) })
  @ApiHttpErrors(400, 401, 403, 409, 413, 429)
  evidenceScans(
    @Req() req: RequestWithTenant & { rawBody?: Buffer },
    @Headers("x-station-capabilities") capabilities: string | undefined,
    @Body(new ZodValidationPipe(grantEvidenceEnvelopeSchema)) body: GrantEvidenceEnvelope,
  ) {
    return this.evidence.scanBatch(identity(req), body, req.rawBody, capabilities);
  }
  @Post("evidence/shift-closures")
  @HttpCode(200)
  @AllowSubscriptionRecovery("station")
  @ApiOperation({ summary: "Retain negotiated offline evidence and return durable reconciliation" })
  @ApiZodBody(grantEvidenceEnvelopeSchema)
  @ApiOkResponse({ schema: zodApiSchema(grantEvidenceReceiptSchema) })
  @ApiHttpErrors(400, 401, 403, 409, 413, 429)
  evidenceShiftClose(
    @Req() req: RequestWithTenant & { rawBody?: Buffer },
    @Body(new ZodValidationPipe(grantEvidenceEnvelopeSchema)) body: GrantEvidenceEnvelope,
  ) {
    return this.evidence.shiftClose(identity(req), body, req.rawBody);
  }
  @Post("evidence/inventories/:id/event-batches")
  @HttpCode(200)
  @AllowSubscriptionRecovery("station")
  @ApiOperation({ summary: "Retain negotiated offline evidence and return durable reconciliation" })
  @ApiZodBody(grantEvidenceEnvelopeSchema)
  @ApiOkResponse({ schema: zodApiSchema(grantEvidenceReceiptSchema) })
  @ApiHttpErrors(400, 401, 403, 409, 413, 429)
  evidenceInventoryEvents(
    @Req() req: RequestWithTenant & { rawBody?: Buffer },
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(grantEvidenceEnvelopeSchema)) body: GrantEvidenceEnvelope,
  ) {
    return this.evidence.inventoryEvents(identity(req), id, body, req.rawBody);
  }
  @Post("evidence/inventories/:id/leave")
  @HttpCode(200)
  @AllowSubscriptionRecovery("station")
  @ApiOperation({ summary: "Retain negotiated offline evidence and return durable reconciliation" })
  @ApiZodBody(grantEvidenceEnvelopeSchema)
  @ApiOkResponse({ schema: zodApiSchema(grantEvidenceReceiptSchema) })
  @ApiHttpErrors(400, 401, 403, 409, 413, 429)
  evidenceInventoryLeave(
    @Req() req: RequestWithTenant & { rawBody?: Buffer },
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(grantEvidenceEnvelopeSchema)) body: GrantEvidenceEnvelope,
  ) {
    return this.evidence.inventoryLeave(identity(req), id, body, req.rawBody);
  }
}
