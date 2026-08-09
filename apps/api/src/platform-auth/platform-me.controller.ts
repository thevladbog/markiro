import { Controller, Get, Req } from "@nestjs/common";
import { RequirePlatformCapabilities } from "./platform-access-policy";
import type { RequestWithPlatformPrincipal } from "./platform-auth.guard";

@Controller("platform")
export class PlatformMeController {
  @Get("me")
  @RequirePlatformCapabilities()
  me(@Req() request: RequestWithPlatformPrincipal) {
    return request.platformPrincipal;
  }
}
