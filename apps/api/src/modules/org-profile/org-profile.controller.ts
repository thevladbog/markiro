import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { SessionOnlyGuard } from "../../tenancy/session-only.guard";
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
// The station never calls this module. SessionOnlyGuard keeps a station
// api-key out even though TenantGuard accepts it for tenant resolution.
@UseGuards(TenantGuard, SessionOnlyGuard)
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
