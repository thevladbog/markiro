import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY, organizationBrandingDescriptorSchema } from "@markiro/domain";
import type { Response } from "express";
import { AllowStationOrPermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { ApiHttpErrors, ApiStationAuth, zodApiSchema } from "../../lib/openapi";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { OrgProfileService } from "./org-profile.service";

@ApiTags("station")
@ApiStationAuth()
@Controller("station/branding")
@UseGuards(TenantGuard, AuthorizationGuard, StationOnlyGuard, SubscriptionAccessGuard)
@AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
@AllowSubscriptionReadOnly("read")
export class StationBrandingController {
  constructor(private readonly profiles: OrgProfileService) {}
  private assertStation(req: RequestWithTenant): void {
    if (req.deviceKind !== "station")
      throw new ForbiddenException("Branding requires a station device");
  }
  @Get()
  @ApiOperation({ summary: "Read complete private branding for offline Station printing" })
  @ApiOkResponse({ schema: zodApiSchema(organizationBrandingDescriptorSchema) })
  @ApiHttpErrors(401, 403, 404, 503)
  async read(@Req() req: RequestWithTenant, @Res({ passthrough: true }) response: Response) {
    this.assertStation(req);
    response.setHeader("Cache-Control", "private, no-store");
    return this.profiles.getStationBranding(req.tenantId!);
  }
  @Get("logo/:revision")
  @ApiOperation({ summary: "Read the current tenant logo revision for a Station" })
  @ApiParam({ name: "revision", format: "uuid" })
  @ApiOkResponse({ content: { "image/webp": { schema: { type: "string", format: "binary" } } } })
  @ApiHttpErrors(400, 401, 403, 404, 503)
  async logo(
    @Req() req: RequestWithTenant,
    @Param("revision", new ParseUUIDPipe()) revision: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    this.assertStation(req);
    const logo = await this.profiles.getKioskLogo(req.tenantId!, revision);
    response.setHeader("Cache-Control", "private, no-store");
    return new StreamableFile(logo.body, {
      type: logo.contentType,
      length: logo.body.byteLength,
      disposition: "inline",
    });
  }
}
