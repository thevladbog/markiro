import { Body, Controller, Post } from "@nestjs/common";
import { platformAuthContracts } from "@markiro/platform-contracts";
import { PlatformApiPublicCreated } from "../platform-http/platform-openapi";
import { parsePlatformResponse } from "../platform-http/platform-response";
import { AllowPublicPlatformToken } from "./platform-access-policy";
import { PlatformActivationService } from "./platform-activation.service";

@Controller("platform/activation")
export class PlatformActivationController {
  constructor(private readonly activation: PlatformActivationService) {}

  @Post("complete")
  @PlatformApiPublicCreated({
    body: platformAuthContracts.activationComplete.body,
    response: platformAuthContracts.activationComplete.response,
  })
  @AllowPublicPlatformToken()
  async complete(@Body() body: unknown) {
    return parsePlatformResponse(
      platformAuthContracts.activationComplete.response,
      await this.activation.completePublicRequest(body),
    );
  }
}
