import { Controller, Get, Req, UnauthorizedException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { platformOperationsContracts } from "@markiro/platform-contracts";

import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { PlatformOperationsService } from "./platform-operations.service";

@ApiTags("platform-operations")
@Controller("platform/operations")
export class PlatformOperationsController {
  constructor(private readonly operations: PlatformOperationsService) {}

  @Get("overview")
  @ApiOperation({
    summary: "Get platform operations overview",
    description: "The returned sections depend on the caller's platform role.",
  })
  @PlatformApiProtectedOk({ response: platformOperationsContracts.overview.response })
  @RequirePlatformCapabilities("tenants.read")
  async overview(@Req() request: RequestWithPlatformPrincipal) {
    const principal = request.platformPrincipal;
    if (!principal) throw new UnauthorizedException();
    return parsePlatformResponse(
      platformOperationsContracts.overview.response,
      await this.operations.overview(principal.role),
    );
  }

  @Get("monitoring")
  @ApiOperation({ summary: "Get platform monitoring metrics" })
  @PlatformApiProtectedOk({ response: platformOperationsContracts.monitoring.response })
  @RequirePlatformCapabilities("diagnostics.read")
  async monitoring() {
    return parsePlatformResponse(
      platformOperationsContracts.monitoring.response,
      await this.operations.monitoring(),
    );
  }
}
