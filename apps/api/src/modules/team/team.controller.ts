import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createTeamInvitationSchema,
  linkTeamEmployeeSchema,
  updateTeamMemberSchema,
  type CreateTeamInvitationDto,
  type LinkTeamEmployeeDto,
  type TeamInvitationDto,
  type TeamMemberDto,
  type TeamResponseDto,
  type UpdateTeamMemberDto,
} from "./dto";
import { TeamService } from "./team.service";

@ApiTags("team")
@Controller("team")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.MEMBERS_MANAGE)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  list(@Req() req: RequestWithTenant): Promise<TeamResponseDto> {
    return this.team.getTeam(req.tenantId!);
  }

  @Post("invitations")
  @RequireSubscriptionWrite()
  createInvitation(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createTeamInvitationSchema)) body: CreateTeamInvitationDto,
  ): Promise<TeamInvitationDto> {
    return this.team.createInvitation(req.tenantId!, req.userId!, body);
  }

  @Post("invitations/:id/resend")
  @RequireSubscriptionWrite()
  resendInvitation(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<TeamInvitationDto> {
    return this.team.resendInvitation(req.tenantId!, req.userId!, id);
  }

  @Delete("invitations/:id")
  @HttpCode(204)
  @AllowSubscriptionReadOnly("security")
  cancelInvitation(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.team.cancelInvitation(req.tenantId!, req.userId!, id);
  }

  @Patch("members/:id")
  @RequireSubscriptionWrite()
  updateMember(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateTeamMemberSchema)) body: UpdateTeamMemberDto,
  ): Promise<TeamMemberDto> {
    return this.team.updateMember(req.tenantId!, req.userId!, id, body);
  }

  @Put("members/:id/employee")
  @RequireSubscriptionWrite()
  linkEmployee(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(linkTeamEmployeeSchema)) body: LinkTeamEmployeeDto,
  ): Promise<TeamMemberDto> {
    return this.team.linkEmployee(req.tenantId!, req.userId!, id, body);
  }

  @Delete("members/:id/employee")
  @RequireSubscriptionWrite()
  unlinkEmployee(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<TeamMemberDto> {
    return this.team.unlinkEmployee(req.tenantId!, req.userId!, id);
  }

  @Delete("members/:id")
  @HttpCode(204)
  @AllowSubscriptionReadOnly("security")
  removeMember(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.team.removeMember(req.tenantId!, req.userId!, id);
  }
}
