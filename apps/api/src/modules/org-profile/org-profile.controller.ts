import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodResponse,
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
  orgProfileOpenApiSchema,
  organizationLogoOpenApiSchema,
  putOrgProfileSchema,
  ssccCounterSchema,
  ssccCounterStateOpenApiSchema,
  type OrgProfileDto,
  type OrganizationLogoDto,
  type PutOrgProfileDto,
  type SsccCounterDto,
} from "./dto";
import type { SsccCounterStateDto } from "../sscc/dto";
import { OrgProfileService } from "./org-profile.service";

@ApiTags("org-profile")
@Controller("org/profile")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.TENANT_SETTINGS_MANAGE)
@ApiCabinetAuth()
export class OrgProfileController {
  constructor(private readonly orgProfileService: OrgProfileService) {}

  @Get()
  @ApiOperation({ summary: "Get the organization profile" })
  @ApiResponse({ status: 200, schema: orgProfileOpenApiSchema })
  @ApiHttpErrors(401, 403)
  async getProfile(@Req() req: RequestWithTenant): Promise<OrgProfileDto> {
    // TenantGuard guarantees tenantId is set before a handler runs.
    return this.orgProfileService.getProfile(req.tenantId!);
  }

  @Put()
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Update the organization profile",
    description:
      "Partial merge: omitted fields keep their current value, explicit null clears a field.",
  })
  @ApiZodBody(putOrgProfileSchema)
  @ApiResponse({ status: 200, schema: orgProfileOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  async putProfile(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(putOrgProfileSchema)) body: PutOrgProfileDto,
  ): Promise<OrgProfileDto> {
    return this.orgProfileService.upsertProfile(req.tenantId!, req.userId!, body);
  }

  @Post("logo")
  @RequireSubscriptionWrite()
  @ApiOperation({ summary: "Upload the organization logo" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["logo"],
      properties: { logo: { type: "string", format: "binary" } },
    },
  })
  @ApiResponse({ status: 201, schema: organizationLogoOpenApiSchema })
  @ApiHttpErrors(400, 401, 403, 409, 413, 503)
  @UseInterceptors(
    FileInterceptor("logo", {
      storage: memoryStorage(),
      limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1,
        fields: 0,
        // Busboy emits partsLimit at this count. Two is therefore the exclusive
        // threshold that accepts one file and rejects every subsequent part.
        parts: 2,
      },
    }),
  )
  uploadLogo(
    @Req() req: RequestWithTenant,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<OrganizationLogoDto> {
    if (!file) throw new BadRequestException("Logo file is required");
    return this.orgProfileService.uploadLogo(req.tenantId!, req.userId!, file.buffer);
  }

  @Get("logo/:revision")
  @ApiOperation({ summary: "Download the organization logo" })
  @ApiParam({ name: "revision", schema: { type: "string", format: "uuid" } })
  @ApiResponse({
    status: 200,
    description: "The active logo revision as a WebP image.",
    content: { "image/webp": { schema: { type: "string", format: "binary" } } },
  })
  @ApiHttpErrors(400, 401, 403, 404, 503)
  async getLogo(
    @Req() req: RequestWithTenant,
    @Param("revision", new ParseUUIDPipe()) revision: string,
  ): Promise<StreamableFile> {
    const logo = await this.orgProfileService.getKioskLogo(req.tenantId!, revision);
    return new StreamableFile(logo.body, {
      type: logo.contentType,
      disposition: "inline",
      length: logo.body.byteLength,
    });
  }

  @Delete("logo")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @ApiOperation({ summary: "Delete the organization logo" })
  @ApiResponse({ status: 204, description: "The logo is removed (idempotent)." })
  @ApiHttpErrors(401, 403)
  deleteLogo(@Req() req: RequestWithTenant): Promise<void> {
    return this.orgProfileService.deleteLogo(req.tenantId!, req.userId!);
  }

  @Get("sscc")
  @ApiOperation({
    summary: "Get the box SSCC counter state",
    description:
      "The tenant's own box counter plus the seeding rules: the current floor and the blocker, if any, that prevents reseeding. Requires the profile to have a GLN.",
  })
  @ApiResponse({ status: 200, schema: ssccCounterStateOpenApiSchema })
  @ApiHttpErrors(400, 401, 403)
  async getSscc(@Req() req: RequestWithTenant): Promise<SsccCounterStateDto> {
    return this.orgProfileService.getSscc(req.tenantId!);
  }

  @Put("sscc")
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Seed the box SSCC counter",
    description:
      "Reseeds the counter and revokes serial blocks devices still hold. Refused while a shift is open or a device holding a live block is out of sync.",
  })
  @ApiZodBody(ssccCounterSchema)
  @ApiZodResponse({ status: 200, schema: ssccCounterSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 409)
  async putSscc(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(ssccCounterSchema)) body: SsccCounterDto,
  ): Promise<SsccCounterDto> {
    return this.orgProfileService.putSscc(req.tenantId!, body);
  }
}
