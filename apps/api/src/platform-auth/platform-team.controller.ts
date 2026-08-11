import { Body, Controller, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { PLATFORM_ROLES } from "@markiro/db";
import { z } from "zod";
import { ZodValidationPipe } from "../zod.pipe";
import { RequirePlatformCapabilities } from "./platform-access-policy";
import type { RequestWithPlatformPrincipal } from "./platform-auth.guard";
import { PlatformTeamService } from "./platform-team.service";

const roleSchema = z.enum(PLATFORM_ROLES);
const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .pipe(z.email())
    .transform((value) => value.toLocaleLowerCase("en-US")),
  role: roleSchema,
});
const roleChangeSchema = z.object({ role: roleSchema });

@Controller("platform/team")
@RequirePlatformCapabilities("platformTeam.write")
export class PlatformTeamController {
  constructor(private readonly team: PlatformTeamService) {}

  @Get()
  list() {
    return this.team.list();
  }

  @Post()
  invite(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(inviteSchema)) body: z.infer<typeof inviteSchema>,
  ) {
    return this.team.invite(request.platformPrincipal!, body);
  }

  @Patch(":id/role")
  async changeRole(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(roleChangeSchema)) body: z.infer<typeof roleChangeSchema>,
  ) {
    await this.team.changeRole(request.platformPrincipal!, id, body.role);
    return { status: true };
  }

  @Post(":id/suspend")
  async suspend(@Req() request: RequestWithPlatformPrincipal, @Param("id") id: string) {
    await this.team.suspend(request.platformPrincipal!, id);
    return { status: true };
  }

  @Post(":id/activation/renew")
  renewActivation(@Req() request: RequestWithPlatformPrincipal, @Param("id") id: string) {
    return this.team.renewActivation(request.platformPrincipal!, id);
  }

  @Post(":id/2fa/recover")
  async recoverTwoFactor(@Req() request: RequestWithPlatformPrincipal, @Param("id") id: string) {
    await this.team.recoverTwoFactor(request.platformPrincipal!, id);
    return { status: true };
  }
}
