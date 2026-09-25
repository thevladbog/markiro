import { Controller, Get, Header, HttpCode, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ApiHttpErrors, ApiStationAuth } from "../../lib/openapi";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard } from "../../tenancy/tenant.guard";

/**
 * Line presence for a paired device. `TenantGuard` resolves the key to its
 * live durable device row and records `lastSeenAt` before the handler runs;
 * the handler deliberately reads nothing else, so an idle line's
 * once-a-minute probe costs the same on day one and after years of shift
 * history. It carries no subscription gate, like `GET /station/identity`:
 * presence exposes no business data, and a restricted tenant's cabinet still
 * needs to see which lines are online. Replacement-recovery keys remain
 * denied by `TenantGuard`'s default.
 */
@ApiTags("station")
@Controller("station")
@UseGuards(TenantGuard, StationOnlyGuard)
@ApiStationAuth()
export class StationHeartbeatController {
  @Get("heartbeat")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Record station presence",
    description:
      "Authenticated presence probe for a paired station or handheld. Records `lastSeenAt` for the device that owns the presented key and returns no body; a cabinet session is rejected.",
  })
  @ApiResponse({
    status: 204,
    description: "Presence was recorded for the calling device.",
    headers: { "Cache-Control": { schema: { type: "string", enum: ["no-store"] } } },
  })
  @ApiHttpErrors(401, 403, 429)
  heartbeat(): void {
    // TenantGuard has already recorded presence for the authenticated device.
  }
}
