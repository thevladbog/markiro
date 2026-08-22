import { Body, Controller, Get, Param, Patch, Post, Req } from "@nestjs/common";
import {
  platformTeamContracts,
  type PlatformTeamInviteInput,
  type PlatformTeamRoleChangeInput,
} from "@markiro/platform-contracts";
import { parsePlatformResponse } from "../platform-http/platform-response";
import { ZodValidationPipe } from "../zod.pipe";
import { RequirePlatformCapabilities } from "./platform-access-policy";
import type { RequestWithPlatformPrincipal } from "./platform-auth.guard";
import { PlatformTeamService } from "./platform-team.service";

@Controller("platform/team")
@RequirePlatformCapabilities("platformTeam.write")
export class PlatformTeamController {
  constructor(private readonly team: PlatformTeamService) {}

  @Get()
  async list() {
    return parsePlatformResponse(platformTeamContracts.list.response, await this.team.list());
  }

  @Post()
  invite(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(platformTeamContracts.invite.body)) body: PlatformTeamInviteInput,
  ) {
    return this.team
      .invite(request.platformPrincipal!, body)
      .then((result) => parsePlatformResponse(platformTeamContracts.invite.response, result));
  }

  @Patch(":id/role")
  async changeRole(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(platformTeamContracts.changeRole.body))
    body: PlatformTeamRoleChangeInput,
  ) {
    const result: unknown = await this.team.changeRole(request.platformPrincipal!, id, body.role);
    return parsePlatformResponse(
      platformTeamContracts.changeRole.response,
      result === undefined ? { status: true } : result,
    );
  }

  @Post(":id/suspend")
  async suspend(@Req() request: RequestWithPlatformPrincipal, @Param("id") id: string) {
    const result: unknown = await this.team.suspend(request.platformPrincipal!, id);
    return parsePlatformResponse(
      platformTeamContracts.suspend.response,
      result === undefined ? { status: true } : result,
    );
  }

  @Post(":id/activation/renew")
  async renewActivation(@Req() request: RequestWithPlatformPrincipal, @Param("id") id: string) {
    return parsePlatformResponse(
      platformTeamContracts.renewActivation.response,
      await this.team.renewActivation(request.platformPrincipal!, id),
    );
  }

  @Post(":id/2fa/recover")
  async recoverTwoFactor(@Req() request: RequestWithPlatformPrincipal, @Param("id") id: string) {
    const result: unknown = await this.team.recoverTwoFactor(request.platformPrincipal!, id);
    return parsePlatformResponse(
      platformTeamContracts.recoverTwoFactor.response,
      result === undefined ? { status: true } : result,
    );
  }
}
