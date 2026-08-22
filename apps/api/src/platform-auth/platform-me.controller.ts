import { Controller, Get, Req } from "@nestjs/common";
import { platformAuthContracts } from "@markiro/platform-contracts";
import { PlatformApiProtectedOk } from "../platform-http/platform-openapi";
import { parsePlatformResponse } from "../platform-http/platform-response";
import { RequirePlatformCapabilities } from "./platform-access-policy";
import type { RequestWithPlatformPrincipal } from "./platform-auth.guard";

@Controller("platform")
export class PlatformMeController {
  @Get("me")
  @PlatformApiProtectedOk({ response: platformAuthContracts.me.response })
  @RequirePlatformCapabilities()
  me(@Req() request: RequestWithPlatformPrincipal) {
    return parsePlatformResponse(platformAuthContracts.me.response, request.platformPrincipal);
  }
}
