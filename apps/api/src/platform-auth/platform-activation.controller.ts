import { Body, Controller, Post } from "@nestjs/common";
import { AllowPublicPlatformToken } from "./platform-access-policy";
import { PlatformActivationService } from "./platform-activation.service";

@Controller("platform/activation")
export class PlatformActivationController {
  constructor(private readonly activation: PlatformActivationService) {}

  @Post("complete")
  @AllowPublicPlatformToken()
  complete(@Body() body: unknown) {
    return this.activation.completePublicRequest(body);
  }
}
