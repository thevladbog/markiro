import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
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
  putOrgProfileSchema,
  ssccCounterSchema,
  type OrgProfileDto,
  type OrganizationLogoDto,
  type PutOrgProfileDto,
  type SsccCounterDto,
} from "./dto";
import { OrgProfileService } from "./org-profile.service";

@ApiTags("org-profile")
@Controller("org/profile")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.TENANT_SETTINGS_MANAGE)
export class OrgProfileController {
  constructor(private readonly orgProfileService: OrgProfileService) {}

  @Get()
  async getProfile(@Req() req: RequestWithTenant): Promise<OrgProfileDto> {
    // TenantGuard guarantees tenantId is set before a handler runs.
    return this.orgProfileService.getProfile(req.tenantId!);
  }

  @Put()
  @RequireSubscriptionWrite()
  async putProfile(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(putOrgProfileSchema)) body: PutOrgProfileDto,
  ): Promise<OrgProfileDto> {
    return this.orgProfileService.upsertProfile(req.tenantId!, req.userId!, body);
  }

  @Post("logo")
  @RequireSubscriptionWrite()
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["logo"],
      properties: { logo: { type: "string", format: "binary" } },
    },
  })
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

  @Delete("logo")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  deleteLogo(@Req() req: RequestWithTenant): Promise<void> {
    return this.orgProfileService.deleteLogo(req.tenantId!, req.userId!);
  }

  @Get("sscc")
  async getSscc(@Req() req: RequestWithTenant): Promise<SsccCounterDto> {
    return this.orgProfileService.getSscc(req.tenantId!);
  }

  @Put("sscc")
  @RequireSubscriptionWrite()
  async putSscc(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(ssccCounterSchema)) body: SsccCounterDto,
  ): Promise<SsccCounterDto> {
    return this.orgProfileService.putSscc(req.tenantId!, body);
  }
}
