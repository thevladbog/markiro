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
import { ApiTags } from "@nestjs/swagger";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { AllowSubscriptionRecovery } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import {
  stationConflictStatusSchema,
  syncBatchSchema,
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
export class StationScansController {
  constructor(private readonly service: StationScansService) {}

  @Post("conflicts/status")
  @HttpCode(200)
  @AllowSubscriptionRecovery("station")
  async conflictStatus(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(stationConflictStatusSchema)) body: StationConflictStatusDto,
  ): Promise<StationConflictStatusResponseDto> {
    if (!req.deviceId) {
      throw new ForbiddenException("Station device authentication required");
    }
    return this.service.reviewedConflictHashes(req.tenantId!, req.deviceId, body.codeHashes);
  }

  @Post("scans")
  @AllowSubscriptionRecovery("station")
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
