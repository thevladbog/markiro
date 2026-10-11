import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import {
  CABINET_CAPABILITY,
  PALLET_SHEET_FOOTER_CAPABILITY,
  organizationBrandingDescriptorSchema,
} from "@markiro/domain";
import type { Response } from "express";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { ApiCabinetAuth, ApiHttpErrors, zodApiSchema } from "../../lib/openapi";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { OrgProfileService } from "./org-profile.service";
@ApiTags("org-profile")
@ApiCabinetAuth()
@Controller("org/profile/print-branding")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
@AllowSubscriptionReadOnly("read")
export class CabinetPrintBrandingController {
  constructor(private readonly profiles: OrgProfileService) {}
  @Get()
  @ApiHeader({
    name: "x-station-capabilities",
    required: false,
    description:
      "Opt into organizationInn with pallet-sheet-footer-v1; absent capability preserves the legacy response.",
  })
  @ApiOperation({
    summary: "Read organization name and private logo metadata for local label previews",
  })
  @ApiOkResponse({ schema: zodApiSchema(organizationBrandingDescriptorSchema) })
  @ApiHttpErrors(401, 403, 404, 503)
  async read(@Req() req: RequestWithTenant, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "private, no-store");
    return this.profiles.getCabinetPrintBranding(req.tenantId!, {
      includeInn:
        req
          .get("x-station-capabilities")
          ?.split(",")
          .map((v) => v.trim())
          .includes(PALLET_SHEET_FOOTER_CAPABILITY) === true,
    });
  }
  @Get("logo/:revision")
  @ApiOperation({ summary: "Read the current private logo for a label preview" })
  @ApiParam({ name: "revision", format: "uuid" })
  @ApiOkResponse({ content: { "image/webp": { schema: { type: "string", format: "binary" } } } })
  @ApiHttpErrors(400, 401, 403, 404, 503)
  async logo(
    @Req() req: RequestWithTenant,
    @Param("revision", new ParseUUIDPipe()) revision: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const logo = await this.profiles.getKioskLogo(req.tenantId!, revision);
    response.setHeader("Cache-Control", "private, no-store");
    return new StreamableFile(logo.body, {
      type: logo.contentType,
      length: logo.body.byteLength,
      disposition: "inline",
    });
  }
}
