import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiParam, ApiTags } from "@nestjs/swagger";
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

type SessionRequest = RequestWithTenant & { tenantId: string; userId: string };

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
  @AllowSubscriptionReadOnly("export")
  @ApiParam({ name: "shiftId", format: "uuid", type: "string" })
  @ApiBody({ schema: createShiftExportOpenApiSchema })
  @ApiCreatedResponse({ schema: shiftExportOpenApiSchema })
  create(
    @Req() req: SessionRequest,
    @Param("shiftId", new ParseUUIDPipe()) shiftId: string,
    @Body(new ZodValidationPipe(createShiftExportSchema)) body: CreateShiftExportDto,
  ): Promise<ShiftExportDto> {
    return this.exports.create(req.tenantId, req.userId, shiftId, body);
  }

  @Get("shifts/:shiftId/exports")
  @ApiParam({ name: "shiftId", format: "uuid", type: "string" })
  @ApiOkResponse({ schema: { type: "array", items: shiftExportOpenApiSchema } })
  list(
    @Req() req: SessionRequest,
    @Param("shiftId", new ParseUUIDPipe()) shiftId: string,
  ): Promise<ShiftExportDto[]> {
    return this.exports.list(req.tenantId, shiftId);
  }

  @Post("shift-exports/:exportId/retry")
  @AllowSubscriptionReadOnly("export")
  @ApiParam({ name: "exportId", format: "uuid", type: "string" })
  @HttpCode(200)
  @ApiOkResponse({ schema: shiftExportOpenApiSchema })
  retry(
    @Req() req: SessionRequest,
    @Param("exportId", new ParseUUIDPipe()) exportId: string,
  ): Promise<ShiftExportDto> {
    return this.exports.retry(req.tenantId, req.userId, exportId);
  }

  @Get("shift-exports/:exportId/artifacts/:artifactId/download")
  @ApiParam({ name: "exportId", format: "uuid", type: "string" })
  @ApiParam({ name: "artifactId", format: "uuid", type: "string" })
  @ApiOkResponse({ schema: shiftExportDownloadOpenApiSchema })
  download(
    @Req() req: SessionRequest,
    @Param("exportId", new ParseUUIDPipe()) exportId: string,
    @Param("artifactId", new ParseUUIDPipe()) artifactId: string,
  ): Promise<ShiftExportDownloadDto> {
    return this.exports.download(req.tenantId, req.userId, exportId, artifactId);
  }
}
