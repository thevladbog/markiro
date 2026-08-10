import { Body, Controller, ForbiddenException, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { AllowSubscriptionRecovery } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { syncBatchSchema, type SyncBatchDto, type SyncBatchResponseDto } from "./dto";
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

  @Post("scans")
  @AllowSubscriptionRecovery("station")
  async ingest(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(syncBatchSchema)) body: SyncBatchDto,
  ): Promise<SyncBatchResponseDto> {
    if (!req.deviceId) {
      throw new ForbiddenException("Station device authentication required");
    }
    return this.service.applyBatch(req.tenantId!, body, req.deviceId);
  }
}
