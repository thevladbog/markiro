import { Controller, Get, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { platformAuthContracts } from "@markiro/platform-contracts";
import { PlatformApiProtectedOk } from "../platform-http/platform-openapi";
import { parsePlatformResponse } from "../platform-http/platform-response";
import { RequirePlatformCapabilities } from "./platform-access-policy";
import type { RequestWithPlatformPrincipal } from "./platform-auth.guard";

@ApiTags("platform-auth")
@Controller("platform")
export class PlatformMeController {
  @Get("me")
  @ApiOperation({
    summary: "Get the current platform principal",
    description: "Returns the authenticated back-office user with role and capabilities.",
  })
  @PlatformApiProtectedOk({ response: platformAuthContracts.me.response })
  @RequirePlatformCapabilities()
  me(@Req() request: RequestWithPlatformPrincipal) {
    return parsePlatformResponse(platformAuthContracts.me.response, request.platformPrincipal);
  }
}
