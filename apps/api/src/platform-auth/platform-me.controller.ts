import { Controller, Get, Req } from "@nestjs/common";
import { platformAuthContracts } from "@markiro/platform-contracts";
import { parsePlatformResponse } from "../platform-http/platform-response";
import { RequirePlatformCapabilities } from "./platform-access-policy";
import type { RequestWithPlatformPrincipal } from "./platform-auth.guard";

@Controller("platform")
export class PlatformMeController {
  @Get("me")
  @RequirePlatformCapabilities()
  me(@Req() request: RequestWithPlatformPrincipal) {
    return parsePlatformResponse(platformAuthContracts.me.response, request.platformPrincipal);
  }
}
