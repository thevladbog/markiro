import { Body, Controller, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  platformTeamContracts,
  type PlatformTeamInviteInput,
  type PlatformTeamRoleChangeInput,
  type PlatformTeamUserParams,
} from "@markiro/platform-contracts";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../platform-http/platform-openapi";
import { parsePlatformResponse } from "../platform-http/platform-response";
import { ZodValidationPipe } from "../zod.pipe";
import { RequirePlatformCapabilities } from "./platform-access-policy";
import type { RequestWithPlatformPrincipal } from "./platform-auth.guard";
import { PlatformTeamService } from "./platform-team.service";

@ApiTags("platform-team")
@Controller("platform/team")
@RequirePlatformCapabilities("platformTeam.write")
export class PlatformTeamController {
  constructor(private readonly team: PlatformTeamService) {}

  @Get()
  @ApiOperation({ summary: "List platform team members" })
  @PlatformApiProtectedOk({ response: platformTeamContracts.list.response })
  async list() {
    return parsePlatformResponse(platformTeamContracts.list.response, await this.team.list());
  }

  @Post()
  @ApiOperation({ summary: "Invite a platform team member" })
  @PlatformApiProtectedCreated({
    body: platformTeamContracts.invite.body,
    response: platformTeamContracts.invite.response,
  })
  invite(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(platformTeamContracts.invite.body)) body: PlatformTeamInviteInput,
  ) {
    return this.team
      .invite(request.platformPrincipal!, body)
      .then((result) => parsePlatformResponse(platformTeamContracts.invite.response, result));
  }

  @Patch(":id/role")
  @ApiOperation({ summary: "Change a team member's role" })
  @PlatformApiProtectedOk({
    body: platformTeamContracts.changeRole.body,
    response: platformTeamContracts.changeRole.response,
  })
  async changeRole(
    @Req() request: RequestWithPlatformPrincipal,
    @Param(new ZodValidationPipe(platformTeamContracts.changeRole.params))
    params: PlatformTeamUserParams,
    @Body(new ZodValidationPipe(platformTeamContracts.changeRole.body))
    body: PlatformTeamRoleChangeInput,
  ) {
    const result: unknown = await this.team.changeRole(
      request.platformPrincipal!,
      params.id,
      body.role,
    );
    return parsePlatformResponse(
      platformTeamContracts.changeRole.response,
      result === undefined ? { status: true } : result,
    );
  }

  @Post(":id/suspend")
  @ApiOperation({ summary: "Suspend a platform team member" })
  @PlatformApiProtectedCreated({ response: platformTeamContracts.suspend.response })
  async suspend(
    @Req() request: RequestWithPlatformPrincipal,
    @Param(new ZodValidationPipe(platformTeamContracts.suspend.params))
    params: PlatformTeamUserParams,
  ) {
    const result: unknown = await this.team.suspend(request.platformPrincipal!, params.id);
    return parsePlatformResponse(
      platformTeamContracts.suspend.response,
      result === undefined ? { status: true } : result,
    );
  }

  @Post(":id/activation/renew")
  @ApiOperation({
    summary: "Renew a team member's activation link",
    description: "Issues a fresh activation token for a not-yet-activated team member.",
  })
  @PlatformApiProtectedCreated({ response: platformTeamContracts.renewActivation.response })
  async renewActivation(
    @Req() request: RequestWithPlatformPrincipal,
    @Param(new ZodValidationPipe(platformTeamContracts.renewActivation.params))
    params: PlatformTeamUserParams,
  ) {
    return parsePlatformResponse(
      platformTeamContracts.renewActivation.response,
      await this.team.renewActivation(request.platformPrincipal!, params.id),
    );
  }

  @Post(":id/2fa/recover")
  @ApiOperation({ summary: "Reset two-factor authentication for a team member" })
  @PlatformApiProtectedCreated({ response: platformTeamContracts.recoverTwoFactor.response })
  async recoverTwoFactor(
    @Req() request: RequestWithPlatformPrincipal,
    @Param(new ZodValidationPipe(platformTeamContracts.recoverTwoFactor.params))
    params: PlatformTeamUserParams,
  ) {
    const result: unknown = await this.team.recoverTwoFactor(request.platformPrincipal!, params.id);
    return parsePlatformResponse(
      platformTeamContracts.recoverTwoFactor.response,
      result === undefined ? { status: true } : result,
    );
  }
}
