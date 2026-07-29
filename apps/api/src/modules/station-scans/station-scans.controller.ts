import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { syncBatchSchema, type SyncBatchDto, type SyncBatchResponseDto } from "./dto";
import { StationScansService } from "./station-scans.service";

/**
 * Station scan ingest. Deliberately `TenantGuard`-only, never
 * `SessionOnlyGuard`: delivering scans is the device's entire purpose, and
 * making this session-only would silently strand every station's data on its
 * own disk. Recorded in docs/device-key-surface.md and pinned by a positive
 * e2e regression test.
 */
@ApiTags("station")
@Controller("station")
@UseGuards(TenantGuard)
export class StationScansController {
  constructor(private readonly service: StationScansService) {}

  @Post("scans")
  async ingest(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(syncBatchSchema)) body: SyncBatchDto,
  ): Promise<SyncBatchResponseDto> {
    return this.service.applyBatch(req.tenantId!, body);
  }
}
