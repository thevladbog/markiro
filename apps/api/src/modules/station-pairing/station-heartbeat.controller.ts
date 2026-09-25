import { Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ApiHttpErrors, ApiStationAuth } from "../../lib/openapi";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard } from "../../tenancy/tenant.guard";

/**
 * Line presence for a paired device. `TenantGuard` resolves the key to its
 * live durable device row and records `lastSeenAt` before the handler runs;
 * the handler deliberately reads nothing else, so an idle line's
 * once-a-minute probe costs the same on day one and after years of shift
 * history. It carries no subscription gate: presence exposes no business
 * data, and a restricted tenant's cabinet still needs to see which lines are
 * online. Replacement-recovery keys remain denied by `TenantGuard`'s default.
 */
@ApiTags("station")
@Controller("station")
@UseGuards(TenantGuard, StationOnlyGuard)
@ApiStationAuth()
export class StationHeartbeatController {
  @Post("heartbeat")
  @HttpCode(204)
  @ApiOperation({
    summary: "Record station presence",
    description:
      "Authenticated presence heartbeat for a paired station or handheld. Records `lastSeenAt` for the device that owns the presented key; takes no body and returns none. A cabinet session is rejected.",
  })
  @ApiResponse({ status: 204, description: "Presence was recorded for the calling device." })
  @ApiHttpErrors(401, 403, 429)
  heartbeat(): void {
    // TenantGuard has already recorded presence for the authenticated device.
  }
}
