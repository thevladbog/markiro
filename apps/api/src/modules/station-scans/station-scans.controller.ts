import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  ApiHttpErrors,
  ApiStationAuth,
  ApiZodBody,
  ApiZodValidationError,
} from "../../lib/openapi";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { AllowSubscriptionRecovery } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import {
  stationCodeReleasesResponseOpenApiSchema,
  stationCodeReleasesSchema,
  stationConflictStatusResponseOpenApiSchema,
  stationConflictStatusSchema,
  syncBatchResponseOpenApiSchema,
  syncBatchSchema,
  type StationCodeReleasesDto,
  type StationCodeReleasesResponseDto,
  type StationConflictStatusDto,
  type StationConflictStatusResponseDto,
  type SyncBatchDto,
  type SyncBatchResponseDto,
} from "./dto";
import { StationScansService } from "./station-scans.service";

/**
 * Station scan ingest. Delivering scans is the device's entire purpose, and
 * making this session-only would silently strand every station's data on its
 * own disk. Recorded in docs/device-key-surface.md and pinned by a positive
 * e2e regression test.
 */
@ApiTags("station")
@Controller("station")
@UseGuards(TenantGuard, StationOnlyGuard, SubscriptionAccessGuard)
@ApiStationAuth()
export class StationScansController {
  constructor(private readonly service: StationScansService) {}

  @Post("conflicts/status")
  @HttpCode(200)
  @AllowSubscriptionRecovery("station")
  @ApiOperation({
    summary: "Filter conflict hashes down to the reviewed ones",
    description:
      "Returns the subset of the submitted code hashes whose conflicts an admin has already reviewed.",
  })
  @ApiZodBody(stationConflictStatusSchema)
  @ApiOkResponse({ schema: stationConflictStatusResponseOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 429)
  async conflictStatus(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(stationConflictStatusSchema)) body: StationConflictStatusDto,
  ): Promise<StationConflictStatusResponseDto> {
    if (!req.deviceId) {
      throw new ForbiddenException("Station device authentication required");
    }
    return this.service.reviewedConflictHashes(req.tenantId!, req.deviceId, body.codeHashes);
  }

  @Post("codes/releases")
  @HttpCode(200)
  @AllowSubscriptionRecovery("station")
  @ApiOperation({
    summary: "List released code hashes",
    description:
      "Pages through code releases after `since`; follow-up pages resend the returned `until` with `nextCursor`.",
  })
  @ApiZodBody(stationCodeReleasesSchema)
  @ApiOkResponse({ schema: stationCodeReleasesResponseOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 429)
  async codeReleases(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(stationCodeReleasesSchema)) body: StationCodeReleasesDto,
  ): Promise<StationCodeReleasesResponseDto> {
    if (!req.deviceId) {
      throw new ForbiddenException("Station device authentication required");
    }
    return this.service.codeReleases(req.tenantId!, body);
  }

  @Post("scans")
  @AllowSubscriptionRecovery("station")
  @ApiOperation({
    summary: "Record a station scan batch",
    description:
      "Idempotent by `batchId`: a resend of an already-applied batch acknowledges without reapplying. `denied` is returned only when the x-station-capabilities header includes station-recovery-v1.",
  })
  @ApiZodBody(syncBatchSchema)
  @ApiCreatedResponse({ schema: syncBatchResponseOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 409, 429)
  async ingest(
    @Req() req: RequestWithTenant,
    @Headers("x-station-capabilities") capabilities: string | undefined,
    @Body(new ZodValidationPipe(syncBatchSchema)) body: SyncBatchDto,
  ): Promise<SyncBatchResponseDto> {
    if (!req.deviceId) {
      throw new ForbiddenException("Station device authentication required");
    }
    const result = await this.service.applyBatch(req.tenantId!, body, req.deviceId);
    if (
      capabilities
        ?.split(",")
        .map((value) => value.trim())
        .includes("station-recovery-v1")
    ) {
      return result;
    }
    return {
      applied: result.applied,
      alreadyApplied: result.alreadyApplied,
      conflicts: result.conflicts,
    };
  }
}
