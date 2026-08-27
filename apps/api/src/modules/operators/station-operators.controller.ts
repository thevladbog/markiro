import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { OperatorMirrorRecord } from "@markiro/db";
import { ApiHttpErrors, ApiStationAuth } from "../../lib/openapi";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { stationOperatorRosterOpenApiSchema } from "./dto";
import { OperatorsService } from "./operators.service";

/**
 * Station-facing roster. The device calls this with its own api-key during
 * initialization, right after enrollment and BEFORE any operator can sign in —
 * that is what makes a freshly installed station usable at all. It returns
 * PBKDF2 verifiers, never plaintext PINs or badge codes.
 */
@ApiTags("station")
@Controller("station")
@UseGuards(TenantGuard, StationOnlyGuard)
@ApiStationAuth()
export class StationOperatorsController {
  constructor(private readonly operatorsService: OperatorsService) {}

  @Get("operators")
  @ApiOperation({
    summary: "List the station operator roster",
    description:
      "Called by the device during initialization, before any operator can sign in. Returns PBKDF2 verifiers, never plaintext PINs or badge codes.",
  })
  @ApiOkResponse({ schema: stationOperatorRosterOpenApiSchema })
  @ApiHttpErrors(401, 403, 429)
  async listRoster(@Req() req: RequestWithTenant): Promise<{ items: OperatorMirrorRecord[] }> {
    return { items: await this.operatorsService.buildRoster(req.tenantId!) };
  }
}
