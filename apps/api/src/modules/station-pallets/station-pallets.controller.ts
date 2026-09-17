import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { AllowStationOrPermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { ApiHttpErrors, ApiStationAuth } from "../../lib/openapi";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { stationPalletBootstrapOpenApiSchema, type StationPalletBootstrapDto } from "./dto";
import { StationPalletsService } from "./station-pallets.service";

@ApiTags("station-pallets")
@Controller()
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class StationPalletsController {
  constructor(private readonly service: StationPalletsService) {}

  @Get("station/pallet-bootstrap")
  @UseGuards(StationOnlyGuard)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Get the handheld warehouse-pallet bootstrap",
    description:
      "Catalogue with pallet capacities, per-operator pallet permission, this device's extension-1 SSCC block for the organisation's GLN, and the default pallet label templates. The block is null when the subscription is read-only, the organisation has no GLN, or the prefix is exhausted.",
  })
  @ApiStationAuth()
  @ApiOkResponse({ schema: stationPalletBootstrapOpenApiSchema })
  @ApiHttpErrors(401, 403, 429)
  bootstrap(@Req() req: RequestWithTenant): Promise<StationPalletBootstrapDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.service.bootstrap(req.tenantId!, req.deviceId);
  }
}
