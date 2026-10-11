import {
  validationReprocessingDetailsQuerySchema,
  validationReprocessingDetailsSchema,
  type ValidationReprocessingDetailsQuery,
} from "@markiro/domain";
import { projectDeviceValidationPrint, projectDeviceShiftOutput } from "./validation-print-policy";
import {
  assertPalletSheetClient,
  supportsPalletSheetClient,
  projectPalletSheetFields,
  type PalletSheetCaller,
} from "./pallet-sheet-policy";
import {
  validationCodeHistoryQuerySchema,
  validationCodeHistorySchema,
  type ValidationCodeHistoryQuery,
} from "@markiro/domain";
import {
  productLabelHistoryQuerySchema,
  productLabelEventsQuerySchema,
  type ProductLabelHistoryQuery,
  type ProductLabelEventsQuery,
} from "./product-label-history";
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiExtraModels,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import {
  CABINET_CAPABILITY,
  productLabelTemplateListSchema,
  productLabelHistorySchema,
  productLabelEventHistorySchema,
  PRODUCT_LABEL_PROTOCOL,
  type ProductLabelTemplateList,
} from "@markiro/domain";
import {
  ApiCabinetAuth,
  ApiCabinetOrStationAuth,
  ApiHttpErrors,
  ApiStationAuth,
  ApiZodBody,
  ApiZodQuery,
  ApiZodValidationError,
  zodApiSchema,
} from "../../lib/openapi";
import { AllowStationOrPermissions, RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  AllowSubscriptionReadOnly,
  AllowSubscriptionRecovery,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import {
  closeShiftSchema,
  createShiftOpenApiSchema,
  createShiftSchema,
  listShiftsQuerySchema,
  listShiftsOpenApiSchema,
  shiftBoxLabelTemplatesOpenApiSchema,
  shiftPalletLabelTemplatesOpenApiSchema,
  shiftBundleOpenApiSchema,
  boxSsccTopUpOpenApiSchema,
  shiftOpenApiSchema,
  shiftPlanningConfigOpenApiSchema,
  shiftReferenceBundleOpenApiSchema,
  shiftSummaryOpenApiSchema,
  updateShiftOpenApiSchema,
  updateShiftSchema,
  type CloseShiftDto,
  type CreateShiftDto,
  type ListShiftsQueryDto,
  type ShiftBoxLabelTemplatesDto,
  type ShiftPalletLabelTemplatesDto,
  type ShiftDto,
  type BoxSsccTopUpDto,
  type ShiftPlanningConfigDto,
  type UpdateShiftDto,
  boxLabelTemplateProductQuerySchema,
  type BoxLabelTemplateProductQueryDto,
  productLabelTemplateProductQuerySchema,
  type ProductLabelTemplateProductQueryDto,
  shiftEntrySchema,
  type ShiftEntryDto,
  shiftLabelTemplatePreviewQuerySchema,
  shiftLabelTemplatePreviewSchema,
  palletSheetSnapshotOpenApiSchema,
  shiftPalletSheetTemplatesOpenApiSchema,
  palletSheetTemplatePreviewQuerySchema,
  type PalletSheetTemplatePreviewQueryDto,
  type ShiftLabelTemplatePreviewQueryDto,
  type ShiftLabelTemplatePreviewDto,
} from "./dto";
import { ShiftsService, type EffectiveListShiftsQuery } from "./shifts.service";
import { renderShiftTaskFormHtml } from "./shift-task-form";
import { PalletSheetNodeDocument } from "../label-templates/dto";

function sheetCaller(req: RequestWithTenant): PalletSheetCaller {
  return req.authKind === "station"
    ? {
        kind: "device",
        deviceKind: req.deviceKind,
        capabilities: req.get("x-station-capabilities"),
      }
    : { kind: "cabinet" };
}

function includesSheets(req: RequestWithTenant): boolean {
  return req.authKind === "station"
    ? supportsPalletSheetClient(sheetCaller(req))
    : Boolean(
        req
          .get("x-label-template-formats")
          ?.split(",")
          .map((token) => token.trim())
          .includes("pallet-sheet-v2"),
      );
}

function projectShift(
  req: RequestWithTenant,
  shift: ShiftDto,
  includeSheets = includesSheets(req),
): ShiftDto {
  const projected = projectPalletSheetFields(shift, sheetCaller(req), includeSheets);
  return req.authKind === "station"
    ? projectDeviceValidationPrint(projected, req.get("x-station-capabilities"))
    : projected;
}

@ApiTags("shifts")
@ApiExtraModels(PalletSheetNodeDocument)
@ApiHeader({
  name: "x-label-template-formats",
  required: false,
  description:
    "Cabinet clients opt into optional A4 fields with label-v1,pallet-sheet-v2. Devices negotiate x-station-capabilities instead.",
})
@Controller("shifts")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class ShiftsController {
  constructor(private readonly shiftsService: ShiftsService) {}

  @Get()
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "List shifts",
    description:
      "A station credential that omits `lineId` is scoped to its own line, including unassigned shifts.",
  })
  @ApiCabinetOrStationAuth()
  @ApiZodQuery(listShiftsQuerySchema)
  @ApiOkResponse({ schema: listShiftsOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 429)
  async listShifts(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listShiftsQuerySchema)) query: ListShiftsQueryDto,
  ) {
    const effectiveQuery: EffectiveListShiftsQuery =
      req.authKind === "station" && query.lineId === undefined && req.deviceLineId
        ? { ...query, lineId: req.deviceLineId, includeUnassigned: true }
        : query;
    const result = await this.shiftsService.listShifts(req.tenantId!, effectiveQuery);
    return { ...result, items: result.items.map((item) => projectShift(req, item)) };
  }

  @Get("product-label-templates")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "List product duplicate label template options",
    description:
      "Enabled templates for the tenant and the product's category. Returns summaries without template specs.",
  })
  @ApiCabinetOrStationAuth()
  @ApiZodQuery(productLabelTemplateProductQuerySchema)
  @ApiOkResponse({ schema: zodApiSchema(productLabelTemplateListSchema) })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 429)
  async listProductLabelTemplates(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(productLabelTemplateProductQuerySchema))
    query: ProductLabelTemplateProductQueryDto,
  ): Promise<ProductLabelTemplateList> {
    return this.shiftsService.listProductLabelTemplates(req.tenantId!, query.productId);
  }

  @Get("planning-config")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Read the shift planning configuration",
    description:
      "With `productId`, the box-template default is resolved for that product's category (category default, then organisation default).",
  })
  @ApiCabinetOrStationAuth()
  @ApiZodQuery(boxLabelTemplateProductQuerySchema)
  @ApiOkResponse({ schema: shiftPlanningConfigOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  async getPlanningConfig(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(boxLabelTemplateProductQuerySchema))
    query: BoxLabelTemplateProductQueryDto,
  ): Promise<ShiftPlanningConfigDto> {
    const result = await this.shiftsService.getPlanningConfig(
      req.tenantId!,
      query.productId,
      includesSheets(req),
    );
    if (
      req.authKind === "station" &&
      !req
        .get("x-station-capabilities")
        ?.split(",")
        .map((token) => token.trim())
        .includes("validation-reprocessing-v1")
    ) {
      const { validationReprocessingProtocol: supported, ...legacy } = result;
      void supported;
      return legacy;
    }
    return result;
  }

  // Station-readable summaries retain their legacy response shapes. The
  // separate product-scoped preview route exposes only an eligible selected spec.
  @Get("box-label-templates")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "List box label template options",
    description:
      "Template summaries only; selected specs are available through the product-scoped preview route. " +
      "With `productId` only templates eligible for that product's category are returned; without it, every enabled template.",
  })
  @ApiCabinetOrStationAuth()
  @ApiZodQuery(boxLabelTemplateProductQuerySchema)
  @ApiOkResponse({ schema: shiftBoxLabelTemplatesOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 429)
  async listBoxLabelTemplates(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(boxLabelTemplateProductQuerySchema))
    query: BoxLabelTemplateProductQueryDto,
  ): Promise<ShiftBoxLabelTemplatesDto> {
    return this.shiftsService.listBoxLabelTemplates(req.tenantId!, query.productId);
  }

  @Get("pallet-label-templates")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "List pallet label template options",
    description:
      "Template summaries only; selected specs are available through the product-scoped preview route. " +
      "With `productId` only templates eligible for that product's category are returned; without it, every enabled template.",
  })
  @ApiCabinetOrStationAuth()
  @ApiZodQuery(boxLabelTemplateProductQuerySchema)
  @ApiOkResponse({ schema: shiftPalletLabelTemplatesOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 429)
  async listPalletLabelTemplates(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(boxLabelTemplateProductQuerySchema))
    query: BoxLabelTemplateProductQueryDto,
  ): Promise<ShiftPalletLabelTemplatesDto> {
    return this.shiftsService.listPalletLabelTemplates(req.tenantId!, query.productId);
  }

  @Get("pallet-sheet-templates")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "List compatible editable A4 pallet templates for shift planning" })
  @ApiCabinetOrStationAuth()
  @ApiZodQuery(boxLabelTemplateProductQuerySchema)
  @ApiOkResponse({ schema: shiftPalletSheetTemplatesOpenApiSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  async listPalletSheetTemplates(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(boxLabelTemplateProductQuerySchema))
    query: BoxLabelTemplateProductQueryDto,
  ) {
    assertPalletSheetClient(sheetCaller(req));
    return this.shiftsService.listPalletSheetTemplates(req.tenantId!, query.productId);
  }

  @Get("pallet-sheet-template-preview")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Read a selected A4 pallet template snapshot for planning preview" })
  @ApiCabinetOrStationAuth()
  @ApiZodQuery(palletSheetTemplatePreviewQuerySchema)
  @ApiOkResponse({ schema: palletSheetSnapshotOpenApiSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  async getPalletSheetTemplatePreview(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(palletSheetTemplatePreviewQuerySchema))
    query: PalletSheetTemplatePreviewQueryDto,
  ) {
    assertPalletSheetClient(sheetCaller(req));
    return this.shiftsService.getPalletSheetPreview(
      req.tenantId!,
      query.productId,
      query.templateId,
    );
  }

  @Get("label-template-preview")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Read a selected label template for shift planning preview",
    description:
      "Returns the shared label spec, not a rendered image. The product and enabled template must belong to the authenticated tenant and match the requested purpose and product category. Handheld credentials are refused. Creating a shift still resolves and validates its own print snapshot.",
  })
  @ApiCabinetOrStationAuth()
  @ApiZodQuery(shiftLabelTemplatePreviewQuerySchema)
  @ApiOkResponse({ schema: zodApiSchema(shiftLabelTemplatePreviewSchema) })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 429)
  async getLabelTemplatePreview(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(shiftLabelTemplatePreviewQuerySchema))
    query: ShiftLabelTemplatePreviewQueryDto,
  ): Promise<ShiftLabelTemplatePreviewDto> {
    if (req.authKind === "station" && req.deviceKind === "handheld") {
      throw new ForbiddenException("Label template previews require a station device");
    }
    return this.shiftsService.getLabelTemplatePreview(req.tenantId!, query);
  }

  @Get(":id/reprocessings")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiCabinetAuth()
  @ApiOperation({
    summary: "Read repeated validation occurrences and their original source shifts",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiZodQuery(validationReprocessingDetailsQuerySchema)
  @ApiOkResponse({ schema: zodApiSchema(validationReprocessingDetailsSchema) })
  @ApiHttpErrors(400, 401, 403, 404)
  getReprocessings(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(validationReprocessingDetailsQuerySchema))
    query: ValidationReprocessingDetailsQuery,
  ) {
    return this.shiftsService.getValidationReprocessingDetails(req.tenantId!, id, query);
  }

  @Get(":id/code-history")
  @UseGuards(StationOnlyGuard)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @AllowSubscriptionRecovery("shift")
  @ApiStationAuth()
  @ApiOperation({ summary: "Read a coherent page of validation code ownership history" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiZodQuery(validationCodeHistoryQuerySchema)
  @ApiOkResponse({ schema: zodApiSchema(validationCodeHistorySchema) })
  @ApiHttpErrors(400, 401, 403, 404, 409)
  getCodeHistory(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(validationCodeHistoryQuerySchema))
    query: ValidationCodeHistoryQuery,
  ) {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.shiftsService.getValidationCodeHistory(req.tenantId!, req.deviceId, id, query);
  }

  @Get(":id/product-labels")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Read duplicate label history and attempt totals" })
  @ApiCabinetAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiZodQuery(productLabelHistoryQuerySchema)
  @ApiOkResponse({ schema: zodApiSchema(productLabelHistorySchema) })
  @ApiHttpErrors(400, 401, 403, 404)
  getProductLabels(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(productLabelHistoryQuerySchema)) query: ProductLabelHistoryQuery,
  ) {
    return this.shiftsService.getProductLabelHistory(req.tenantId!, id, query);
  }

  @Get(":id/product-labels/:jobId/events")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Read accepted label events in device sequence order",
    description: "Specify deviceId when the same local job UUID occurs on multiple stations.",
  })
  @ApiCabinetAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiParam({ name: "jobId", format: "uuid" })
  @ApiZodQuery(productLabelEventsQuerySchema)
  @ApiOkResponse({ schema: zodApiSchema(productLabelEventHistorySchema) })
  @ApiHttpErrors(400, 401, 403, 404)
  getProductLabelEvents(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("jobId") jobId: string,
    @Query(new ZodValidationPipe(productLabelEventsQuerySchema)) query: ProductLabelEventsQuery,
  ) {
    return this.shiftsService.getProductLabelEvents(req.tenantId!, id, jobId, query);
  }

  @Get(":id/summary")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Read factual shift output and participants",
    description:
      "Cabinet users read any shift of the organisation; a station or handheld device reads only shifts it has entered.",
  })
  @ApiCabinetOrStationAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: shiftSummaryOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  async getShiftSummary(@Req() req: RequestWithTenant, @Param("id") id: string) {
    const result = await this.shiftsService.getShiftSummary(
      req.tenantId!,
      id,
      req.authKind === "station" ? (req.deviceId ?? null) : null,
    );
    return req.authKind === "station"
      ? projectDeviceShiftOutput(result, req.get("x-station-capabilities"))
      : result;
  }

  @Get(":id/task-form")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Render the printable shift task form",
    description:
      "Responds with a text/html page for printing, not JSON. Closed shifts are refused.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiProduces("text/html")
  @ApiOkResponse({ schema: { type: "string" } })
  @ApiHttpErrors(401, 403, 404, 409)
  @ApiCabinetAuth()
  async taskForm(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const data = await this.shiftsService.taskFormData(req.tenantId!, id);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    return renderShiftTaskFormHtml(data);
  }

  // Cabinet-only: a device reading an
  // arbitrary shift by id has no legitimate use once it can already
  // list/open/bundle its own.
  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Read a shift" })
  @ApiCabinetAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: shiftOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  async getShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftDto> {
    return projectShift(req, await this.shiftsService.getShift(req.tenantId!, id));
  }

  @Post()
  @ApiHeader({
    name: "x-station-capabilities",
    required: false,
    description: `Comma-separated station protocols. ${PRODUCT_LABEL_PROTOCOL} is required for duplicate printing; otherwise STATION_UPDATE_REQUIRED (409).`,
  })
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Create a shift",
    description:
      "Omitted capacities and counterparty are prefilled from the product; a station-created shift is pinned to the device's line.",
  })
  @ApiCabinetOrStationAuth()
  @ApiBody({ schema: createShiftOpenApiSchema })
  @ApiCreatedResponse({ schema: shiftOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 409, 422, 429)
  async createShift(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createShiftSchema)) body: CreateShiftDto,
  ) {
    if (req.authKind === "station") {
      return projectShift(
        req,
        await this.shiftsService.createShift(
          req.tenantId!,
          {
            ...body,
            lineId: req.deviceLineId ?? null,
          },
          { domain: "station_device", id: req.deviceId! },
          "station",
          req.get("x-station-capabilities"),
          includesSheets(req),
        ),
      );
    }
    return projectShift(
      req,
      await this.shiftsService.createShift(
        req.tenantId!,
        body,
        { domain: "cabinet", id: req.userId! },
        "admin",
        undefined,
        includesSheets(req),
      ),
      includesSheets(req) || body.palletSheetTemplateId !== undefined,
    );
  }

  @Patch(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Update a shift",
    description:
      "Planned shifts accept the full shape; active shifts accept only line/date/quantity/box-template metadata.",
  })
  @ApiCabinetAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: updateShiftOpenApiSchema })
  @ApiOkResponse({ schema: shiftOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409, 422)
  async updateShift(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateShiftSchema)) body: UpdateShiftDto,
  ): Promise<ShiftDto> {
    return projectShift(
      req,
      await this.shiftsService.updateShift(req.tenantId!, req.userId!, id, body),
      includesSheets(req) || body.palletSheetTemplateId !== undefined,
    );
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({ summary: "Delete a planned shift" })
  @ApiCabinetAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiResponse({ status: 204, description: "The shift was deleted." })
  @ApiHttpErrors(401, 403, 404, 409)
  async deleteShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.shiftsService.deleteShift(req.tenantId!, id);
  }

  // Cabinet-only: closing a shift from the station is deliberately not a
  // station action (see docs/device-key-surface.md).
  @Post(":id/close")
  @HttpCode(200)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @AllowSubscriptionRecovery("shift")
  @ApiOperation({
    summary: "Close a shift",
    description: "Cabinet-only: closing a shift is deliberately not a station action.",
  })
  @ApiCabinetAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiZodBody(closeShiftSchema)
  @ApiOkResponse({ schema: shiftOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  async closeShift(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(closeShiftSchema)) body: CloseShiftDto,
  ): Promise<ShiftDto> {
    return this.shiftsService.closeShift(req.tenantId!, id, body);
  }

  @Post(":id/open")
  @ApiHeader({
    name: "x-station-capabilities",
    required: false,
    description: `Comma-separated station protocols. ${PRODUCT_LABEL_PROTOCOL} is required for duplicate printing; otherwise STATION_UPDATE_REQUIRED (409).`,
  })
  @HttpCode(200)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({ summary: "Open a shift" })
  @ApiCabinetOrStationAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiZodBody(shiftEntrySchema, { required: false })
  @ApiOkResponse({ schema: shiftOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409, 429)
  async openShift(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(shiftEntrySchema)) body: ShiftEntryDto,
  ) {
    const result = await this.shiftsService.openShift(
      req.tenantId!,
      id,
      req.authKind === "station"
        ? { domain: "station_device", id: req.deviceId! }
        : { domain: "cabinet", id: req.userId! },
      req.deviceId,
      req.get("x-station-capabilities"),
      body.entryMethod,
    );
    return projectShift(req, result);
  }

  @Post(":id/enter")
  @ApiHeader({
    name: "x-station-capabilities",
    required: false,
    description: `Comma-separated station protocols. ${PRODUCT_LABEL_PROTOCOL} is required for duplicate printing; otherwise STATION_UPDATE_REQUIRED (409).`,
  })
  @HttpCode(200)
  @UseGuards(StationOnlyGuard)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Enter an active shift from a station",
    description: "Station-only: records the calling device as a participant of an open shift.",
  })
  @ApiStationAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiZodBody(shiftEntrySchema, { required: false })
  @ApiOkResponse({ schema: shiftOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409, 429)
  async enterShift(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(shiftEntrySchema)) body: ShiftEntryDto,
  ) {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    const result = await this.shiftsService.enterShift(
      req.tenantId!,
      id,
      req.deviceId,
      req.get("x-station-capabilities"),
      body.entryMethod,
    );
    return projectShift(req, result);
  }

  @Get(":id/bundle")
  @ApiHeader({
    name: "x-station-capabilities",
    required: false,
    description: `Comma-separated station protocols. ${PRODUCT_LABEL_PROTOCOL} is required for duplicate printing; otherwise STATION_UPDATE_REQUIRED (409).`,
  })
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @AllowSubscriptionRecovery("shift")
  @ApiOperation({
    summary: "Download the shift bundle",
    description:
      "Everything the station needs offline. On aggregation shifts a station caller also allocates or reconciles its SSCC serial block. Allocation is denied with device_replacement_waiting before the target's newWorkAllowedAt; reference-bundle remains available for recovery.",
  })
  @ApiCabinetOrStationAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: shiftBundleOpenApiSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409, 429)
  async getBundle(@Req() req: RequestWithTenant, @Param("id") id: string) {
    const result = await this.shiftsService.getBundle(
      req.tenantId!,
      id,
      req.deviceId ?? null,
      req.get("x-station-capabilities"),
    );
    return {
      ...projectPalletSheetFields(result, sheetCaller(req), includesSheets(req)),
      shift: projectShift(req, result.shift),
    };
  }

  @Post(":id/sscc/top-up")
  @HttpCode(200)
  @UseGuards(StationOnlyGuard)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @AllowSubscriptionRecovery("shift")
  @ApiOperation({ summary: "Reconcile and top up this device's box SSCC ranges" })
  @ApiStationAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: boxSsccTopUpOpenApiSchema })
  @ApiHttpErrors(400, 401, 403, 404, 409, 429)
  async topUpBoxSscc(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<BoxSsccTopUpDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.shiftsService.topUpBoxSscc(req.tenantId!, id, req.deviceId);
  }

  @Get(":id/reference-bundle")
  @ApiHeader({
    name: "x-station-capabilities",
    required: false,
    description: `Comma-separated station protocols. ${PRODUCT_LABEL_PROTOCOL} is required for duplicate printing; otherwise STATION_UPDATE_REQUIRED (409).`,
  })
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @AllowSubscriptionRecovery("shift")
  @ApiOperation({
    summary: "Download the reference shift bundle",
    description: "Mirrored reference data only; never allocates or reconciles an SSCC block.",
  })
  @ApiCabinetOrStationAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: shiftReferenceBundleOpenApiSchema })
  @ApiHttpErrors(401, 403, 404, 409, 429)
  async getReferenceBundle(@Req() req: RequestWithTenant, @Param("id") id: string) {
    const result = await this.shiftsService.getReferenceBundle(
      req.tenantId!,
      id,
      req.authKind === "station",
      req.get("x-station-capabilities"),
      req.deviceKind,
    );
    return {
      ...projectPalletSheetFields(result, sheetCaller(req), includesSheets(req)),
      shift: projectPalletSheetFields(
        req.authKind === "station"
          ? projectDeviceValidationPrint(result.shift, req.get("x-station-capabilities"))
          : result.shift,
        sheetCaller(req),
        includesSheets(req),
      ),
    };
  }
}
