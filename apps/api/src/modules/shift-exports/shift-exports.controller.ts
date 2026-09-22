import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { ApiCabinetAuth, ApiHttpErrors, ApiZodValidationError } from "../../lib/openapi";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createPalletExportOpenApiSchema,
  createPalletExportSchema,
  createShiftExportOpenApiSchema,
  createShiftExportSchema,
  palletExportFormatOpenApiSchema,
  shiftExportDownloadOpenApiSchema,
  shiftExportFormatOpenApiSchema,
  shiftExportOpenApiSchema,
  type CreatePalletExportDto,
  type CreateShiftExportDto,
  type PalletExportFormatsDto,
  type ShiftExportDownloadDto,
  type ShiftExportDto,
  type ShiftExportFormatsDto,
} from "./dto";
import { ShiftExportsService } from "./shift-exports.service";

type SessionRequest = RequestWithTenant & { tenantId: string; userId: string };

@ApiTags("shift-exports")
@ApiCabinetAuth()
@Controller()
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
export class ShiftExportsController {
  constructor(private readonly exports: ShiftExportsService) {}

  @Get("shift-exports/formats")
  @ApiOperation({ summary: "List shift export formats" })
  @ApiOkResponse({ schema: { type: "array", items: shiftExportFormatOpenApiSchema } })
  @ApiHttpErrors(401, 403)
  formats(): ShiftExportFormatsDto {
    return this.exports.formats();
  }

  @Post("shifts/:shiftId/exports")
  @AllowSubscriptionReadOnly("export")
  @ApiOperation({
    summary: "Create a shift export",
    description:
      "Queues generation of the shift's code export in the selected format; idempotent per idempotencyKey.",
  })
  @ApiParam({ name: "shiftId", format: "uuid", type: "string" })
  @ApiBody({ schema: createShiftExportOpenApiSchema })
  @ApiCreatedResponse({ schema: shiftExportOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  create(
    @Req() req: SessionRequest,
    @Param("shiftId", new ParseUUIDPipe()) shiftId: string,
    @Body(new ZodValidationPipe(createShiftExportSchema)) body: CreateShiftExportDto,
  ): Promise<ShiftExportDto> {
    return this.exports.create(req.tenantId, req.userId, shiftId, body);
  }

  @Get("shifts/:shiftId/exports")
  @ApiOperation({ summary: "List exports for a shift" })
  @ApiParam({ name: "shiftId", format: "uuid", type: "string" })
  @ApiOkResponse({ schema: { type: "array", items: shiftExportOpenApiSchema } })
  @ApiHttpErrors(401, 403)
  list(
    @Req() req: SessionRequest,
    @Param("shiftId", new ParseUUIDPipe()) shiftId: string,
  ): Promise<ShiftExportDto[]> {
    return this.exports.list(req.tenantId, shiftId);
  }

  @Get("pallet-exports/formats")
  @ApiOperation({ summary: "List pallet export formats" })
  @ApiOkResponse({ schema: { type: "array", items: palletExportFormatOpenApiSchema } })
  @ApiHttpErrors(401, 403)
  palletFormats(): PalletExportFormatsDto {
    return this.exports.palletFormats();
  }

  @Post("pallets/:palletId/exports")
  @AllowSubscriptionReadOnly("export")
  @ApiOperation({
    summary: "Create a pallet export",
    description:
      "Queues a GIS MT aggregation of the pallet's box SSCCs (no unit codes); idempotent per idempotencyKey.",
  })
  @ApiParam({ name: "palletId", format: "uuid", type: "string" })
  @ApiBody({ schema: createPalletExportOpenApiSchema })
  @ApiCreatedResponse({ schema: shiftExportOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  createPalletExport(
    @Req() req: SessionRequest,
    @Param("palletId", new ParseUUIDPipe()) palletId: string,
    @Body(new ZodValidationPipe(createPalletExportSchema)) body: CreatePalletExportDto,
  ): Promise<ShiftExportDto> {
    return this.exports.createForPallet(req.tenantId, req.userId, palletId, body);
  }

  @Get("pallets/:palletId/exports")
  @ApiOperation({ summary: "List exports for a pallet" })
  @ApiParam({ name: "palletId", format: "uuid", type: "string" })
  @ApiOkResponse({ schema: { type: "array", items: shiftExportOpenApiSchema } })
  @ApiHttpErrors(401, 403)
  listPalletExports(
    @Req() req: SessionRequest,
    @Param("palletId", new ParseUUIDPipe()) palletId: string,
  ): Promise<ShiftExportDto[]> {
    return this.exports.listForPallet(req.tenantId, palletId);
  }

  @Post("shift-exports/:exportId/retry")
  @AllowSubscriptionReadOnly("export")
  @ApiOperation({ summary: "Retry a failed shift export" })
  @ApiParam({ name: "exportId", format: "uuid", type: "string" })
  @HttpCode(200)
  @ApiOkResponse({ schema: shiftExportOpenApiSchema })
  @ApiHttpErrors(401, 403)
  retry(
    @Req() req: SessionRequest,
    @Param("exportId", new ParseUUIDPipe()) exportId: string,
  ): Promise<ShiftExportDto> {
    return this.exports.retry(req.tenantId, req.userId, exportId);
  }

  @Get("shift-exports/:exportId/artifacts/:artifactId/download")
  @ApiOperation({
    summary: "Get a shift export artifact download link",
    description: "Returns a short-lived signed URL rather than the file bytes.",
  })
  @ApiParam({ name: "exportId", format: "uuid", type: "string" })
  @ApiParam({ name: "artifactId", format: "uuid", type: "string" })
  @ApiOkResponse({ schema: shiftExportDownloadOpenApiSchema })
  @ApiHttpErrors(401, 403)
  download(
    @Req() req: SessionRequest,
    @Param("exportId", new ParseUUIDPipe()) exportId: string,
    @Param("artifactId", new ParseUUIDPipe()) artifactId: string,
  ): Promise<ShiftExportDownloadDto> {
    return this.exports.download(req.tenantId, req.userId, exportId, artifactId);
  }
}
