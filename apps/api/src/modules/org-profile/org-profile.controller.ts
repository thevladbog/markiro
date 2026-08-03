import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  putOrgProfileSchema,
  ssccCounterSchema,
  type OrgProfileDto,
  type PutOrgProfileDto,
  type SsccCounterDto,
} from "./dto";
import { OrgProfileService } from "./org-profile.service";

@ApiTags("org-profile")
@Controller("org/profile")
@UseGuards(TenantGuard, AuthorizationGuard)
@RequirePermissions(CABINET_CAPABILITY.TENANT_SETTINGS_MANAGE)
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

  @Get("sscc")
  async getSscc(@Req() req: RequestWithTenant): Promise<SsccCounterDto> {
    return this.orgProfileService.getSscc(req.tenantId!);
  }

  @Put("sscc")
  async putSscc(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(ssccCounterSchema)) body: SsccCounterDto,
  ): Promise<SsccCounterDto> {
    return this.orgProfileService.putSscc(req.tenantId!, body);
  }
}
