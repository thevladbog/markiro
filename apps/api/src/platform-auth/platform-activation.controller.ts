import { Body, Controller, Post } from "@nestjs/common";
import { platformAuthContracts } from "@markiro/platform-contracts";
import { parsePlatformResponse } from "../platform-http/platform-response";
import { AllowPublicPlatformToken } from "./platform-access-policy";
import { PlatformActivationService } from "./platform-activation.service";

@Controller("platform/activation")
export class PlatformActivationController {
  constructor(private readonly activation: PlatformActivationService) {}

  @Post("complete")
  @AllowPublicPlatformToken()
  async complete(@Body() body: unknown) {
    return parsePlatformResponse(
      platformAuthContracts.activationComplete.response,
      await this.activation.completePublicRequest(body),
    );
  }
}
