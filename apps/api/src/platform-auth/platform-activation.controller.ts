import { Body, Controller, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { platformAuthContracts } from "@markiro/platform-contracts";
import { PlatformApiPublicCreated } from "../platform-http/platform-openapi";
import { parsePlatformResponse } from "../platform-http/platform-response";
import { AllowPublicPlatformToken } from "./platform-access-policy";
import { PlatformActivationService } from "./platform-activation.service";

@ApiTags("platform-auth")
@Controller("platform/activation")
export class PlatformActivationController {
  constructor(private readonly activation: PlatformActivationService) {}

  @Post("complete")
  @ApiOperation({
    summary: "Complete platform account activation",
    description:
      "Public route: consumes a one-time activation token and sets the account password; two-factor enrollment follows.",
  })
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
