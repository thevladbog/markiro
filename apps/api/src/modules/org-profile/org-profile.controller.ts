import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { putOrgProfileSchema, type OrgProfileDto, type PutOrgProfileDto } from "./dto";
import { OrgProfileService } from "./org-profile.service";

@Controller("org/profile")
@UseGuards(TenantGuard)
export class OrgProfileController {
  constructor(private readonly orgProfileService: OrgProfileService) {}

  @Get()
  async getProfile(@Req() req: RequestWithTenant): Promise<OrgProfileDto> {
    // TenantGuard guarantees tenantId is set before a handler runs.
    return this.orgProfileService.getProfile(req.tenantId!);
  }

  @Put()
  async putProfile(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(putOrgProfileSchema)) body: PutOrgProfileDto,
  ): Promise<OrgProfileDto> {
    return this.orgProfileService.upsertProfile(req.tenantId!, body);
  }
}
