import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createShiftExportOpenApiSchema,
  createShiftExportSchema,
  shiftExportDownloadOpenApiSchema,
  shiftExportFormatOpenApiSchema,
  shiftExportOpenApiSchema,
  type CreateShiftExportDto,
  type ShiftExportDownloadDto,
  type ShiftExportDto,
  type ShiftExportFormatsDto,
} from "./dto";
import { ShiftExportsService } from "./shift-exports.service";

@ApiTags("shift-exports")
@Controller()
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
export class ShiftExportsController {
  constructor(private readonly exports: ShiftExportsService) {}

  @Get("shift-exports/formats")
  @ApiOkResponse({ schema: { type: "array", items: shiftExportFormatOpenApiSchema } })
  formats(): ShiftExportFormatsDto {
    return this.exports.formats();
  }

  @Post("shifts/:shiftId/exports")
  @ApiBody({ schema: createShiftExportOpenApiSchema })
  @ApiCreatedResponse({ schema: shiftExportOpenApiSchema })
  create(
    @Req() req: RequestWithTenant,
    @Param("shiftId") shiftId: string,
    @Body(new ZodValidationPipe(createShiftExportSchema)) body: CreateShiftExportDto,
  ): Promise<ShiftExportDto> {
    return this.exports.create(req.tenantId!, req.userId!, shiftId, body);
  }

  @Get("shifts/:shiftId/exports")
  @ApiOkResponse({ schema: { type: "array", items: shiftExportOpenApiSchema } })
  list(
    @Req() req: RequestWithTenant,
    @Param("shiftId") shiftId: string,
  ): Promise<ShiftExportDto[]> {
    return this.exports.list(req.tenantId!, shiftId);
  }

  @Post("shift-exports/:exportId/retry")
  @HttpCode(200)
  @ApiOkResponse({ schema: shiftExportOpenApiSchema })
  retry(
    @Req() req: RequestWithTenant,
    @Param("exportId") exportId: string,
  ): Promise<ShiftExportDto> {
    return this.exports.retry(req.tenantId!, req.userId!, exportId);
  }

  @Get("shift-exports/:exportId/artifacts/:artifactId/download")
  @ApiOkResponse({ schema: shiftExportDownloadOpenApiSchema })
  download(
    @Req() req: RequestWithTenant,
    @Param("exportId") exportId: string,
    @Param("artifactId") artifactId: string,
  ): Promise<ShiftExportDownloadDto> {
    return this.exports.download(req.tenantId!, req.userId!, exportId, artifactId);
  }
}
