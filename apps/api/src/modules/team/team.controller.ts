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
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodValidationError,
} from "../../lib/openapi";
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
  teamInvitationOpenApiSchema,
  teamMemberOpenApiSchema,
  teamResponseOpenApiSchema,
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
@ApiCabinetAuth()
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  @ApiOperation({ summary: "Get team members and pending invitations" })
  @ApiResponse({ status: 200, schema: teamResponseOpenApiSchema })
  @ApiHttpErrors(401, 403)
  list(@Req() req: RequestWithTenant): Promise<TeamResponseDto> {
    return this.team.getTeam(req.tenantId!);
  }

  @Post("invitations")
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Invite a team member",
    description:
      "Creates a pending invitation and enqueues the invitation email. At most one pending invitation may exist per email.",
  })
  @ApiZodBody(createTeamInvitationSchema)
  @ApiResponse({ status: 201, schema: teamInvitationOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409, 429)
  createInvitation(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createTeamInvitationSchema)) body: CreateTeamInvitationDto,
  ): Promise<TeamInvitationDto> {
    return this.team.createInvitation(req.tenantId!, req.userId!, body);
  }

  @Post("invitations/:id/resend")
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Resend a pending invitation",
    description: "Extends the invitation's expiry and supersedes the previous invitation email.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 201, schema: teamInvitationOpenApiSchema })
  @ApiHttpErrors(401, 403, 404, 409, 429)
  resendInvitation(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<TeamInvitationDto> {
    return this.team.resendInvitation(req.tenantId!, req.userId!, id);
  }

  @Delete("invitations/:id")
  @HttpCode(204)
  @AllowSubscriptionReadOnly("security")
  @ApiOperation({ summary: "Cancel a pending invitation" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "The invitation is canceled." })
  @ApiHttpErrors(401, 403, 404, 409)
  cancelInvitation(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.team.cancelInvitation(req.tenantId!, req.userId!, id);
  }

  @Patch("members/:id")
  @RequireSubscriptionWrite()
  @ApiOperation({ summary: "Update a team member's role or position" })
  @ApiZodBody(updateTeamMemberSchema)
  @ApiResponse({ status: 200, schema: teamMemberOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  updateMember(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateTeamMemberSchema)) body: UpdateTeamMemberDto,
  ): Promise<TeamMemberDto> {
    return this.team.updateMember(req.tenantId!, req.userId!, id, body);
  }

  @Put("members/:id/employee")
  @RequireSubscriptionWrite()
  @ApiOperation({ summary: "Link a team member to an employee" })
  @ApiZodBody(linkTeamEmployeeSchema)
  @ApiResponse({ status: 200, schema: teamMemberOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  linkEmployee(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(linkTeamEmployeeSchema)) body: LinkTeamEmployeeDto,
  ): Promise<TeamMemberDto> {
    return this.team.linkEmployee(req.tenantId!, req.userId!, id, body);
  }

  @Delete("members/:id/employee")
  @RequireSubscriptionWrite()
  @ApiOperation({ summary: "Unlink a team member from their employee" })
  @ApiResponse({ status: 200, schema: teamMemberOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  unlinkEmployee(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<TeamMemberDto> {
    return this.team.unlinkEmployee(req.tenantId!, req.userId!, id);
  }

  @Delete("members/:id")
  @HttpCode(204)
  @AllowSubscriptionReadOnly("security")
  @ApiOperation({ summary: "Remove a team member" })
  @ApiResponse({ status: 204, description: "The member is removed from the organization." })
  @ApiHttpErrors(401, 403, 404)
  removeMember(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.team.removeMember(req.tenantId!, req.userId!, id);
  }
}
