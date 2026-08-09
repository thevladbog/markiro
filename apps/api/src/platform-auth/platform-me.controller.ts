import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RequirePlatformCapabilities } from "./platform-access-policy";
import { PlatformAuthGuard, type RequestWithPlatformPrincipal } from "./platform-auth.guard";

@Controller("platform")
@UseGuards(PlatformAuthGuard)
export class PlatformMeController {
  @Get("me")
  @RequirePlatformCapabilities()
  me(@Req() request: RequestWithPlatformPrincipal) {
    return request.platformPrincipal;
  }
}
