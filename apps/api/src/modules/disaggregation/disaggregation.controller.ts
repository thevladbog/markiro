import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodQuery,
  ApiZodValidationError,
} from "../../lib/openapi";
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
  addLinesSchema,
  createDocumentSchema,
  disaggregationApplyConflictOpenApiSchema,
  disaggregationDocumentDetailOpenApiSchema,
  disaggregationDocumentOpenApiSchema,
  disaggregationImportErrorOpenApiSchema,
  disaggregationImportFileOpenApiSchema,
  disaggregationLinesOpenApiSchema,
  disaggregationNotDraftConflictOpenApiSchema,
  listDisaggregationDocumentsOpenApiSchema,
  listDocumentsQuerySchema,
  reportQuerySchema,
  updateDocumentSchema,
  type AddLinesDto,
  type CreateDocumentDto,
  type ListDocumentsQueryDto,
  type ReportQueryDto,
  type UpdateDocumentDto,
} from "./dto";
import { DisaggregationService } from "./disaggregation.service";
import { renderDisaggregationReportHtml } from "./report";
import { parseSsccImport } from "./import-parser";

@ApiTags("disaggregation")
@ApiCabinetAuth()
@Controller("disaggregation")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class DisaggregationController {
  constructor(private readonly service: DisaggregationService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "List disaggregation documents" })
  // Manual ApiQuery: `from`/`to` use z.coerce.date()/a transform, which
  // z.toJSONSchema cannot represent.
  @ApiQuery({
    name: "status",
    required: false,
    schema: { type: "string", enum: ["draft", "applied", "cancelled"] },
  })
  @ApiQuery({ name: "reasonId", required: false, schema: { type: "string", format: "uuid" } })
  @ApiQuery({
    name: "from",
    required: false,
    schema: { type: "string", format: "date-time" },
    description: "Inclusive lower bound on createdAt.",
  })
  @ApiQuery({
    name: "to",
    required: false,
    schema: { type: "string" },
    description:
      "Upper bound on createdAt: an ISO date-time, or a date-only YYYY-MM-DD value covering that whole day.",
  })
  @ApiQuery({
    name: "docNo",
    required: false,
    schema: { type: "string", minLength: 1, maxLength: 40 },
    description: "Substring match on the document number.",
  })
  @ApiQuery({ name: "page", required: false, schema: { type: "integer", minimum: 1, default: 1 } })
  @ApiOkResponse({ schema: listDisaggregationDocumentsOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  list(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listDocumentsQuerySchema)) query: ListDocumentsQueryDto,
  ) {
    return this.service.listDocuments(req.tenantId!, query);
  }

  @Post()
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({
    summary: "Create a disaggregation document",
    description:
      'Creates a draft document. A reasonId unknown to this tenant yields 400 with body { code: "unknown_reason" }.',
  })
  @ApiZodBody(createDocumentSchema)
  @ApiCreatedResponse({ schema: disaggregationDocumentOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  create(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createDocumentSchema)) body: CreateDocumentDto,
  ) {
    return this.service.createDocument(req.tenantId!, req.userId!, body);
  }

  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Get a disaggregation document" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: disaggregationDocumentDetailOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  get(@Req() req: RequestWithTenant, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.service.getDocument(req.tenantId!, id);
  }

  /**
   * Print-ready A4 "Акт дезагрегации": `variant=boxes` — только коды
   * упаковок (SSCC + Code128); `variant=full` — плюс DataMatrix каждого
   * кода содержимого. Same open-in-new-tab HTML contract as
   * `GET /pickup-orders/:id/slip`.
   */
  @Get(":id/report")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Render the disaggregation act",
    description:
      'Print-ready A4 HTML ("Акт дезагрегации") for opening in a new tab: variant=boxes lists only the box codes (SSCC + Code128); variant=full adds a DataMatrix for every contained code.',
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodQuery(reportQuerySchema)
  @ApiProduces("text/html")
  @ApiOkResponse({ schema: { type: "string" }, description: "Print-ready HTML document." })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  async report(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(reportQuerySchema)) query: ReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const data = await this.service.reportData(req.tenantId!, id, query.variant === "full");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return renderDisaggregationReportHtml(data);
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({
    summary: "Update a draft disaggregation document",
    description:
      'Only draft documents can be edited. A reasonId unknown to this tenant yields 400 with body { code: "unknown_reason" }.',
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(updateDocumentSchema)
  @ApiOkResponse({ schema: disaggregationDocumentOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  @ApiResponse({
    status: 409,
    schema: disaggregationNotDraftConflictOpenApiSchema,
    description: "The document is no longer a draft.",
  })
  update(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateDocumentSchema)) body: UpdateDocumentDto,
  ) {
    return this.service.updateDocument(req.tenantId!, id, body);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Cancel a draft disaggregation document" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: disaggregationDocumentOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  @ApiResponse({
    status: 409,
    schema: disaggregationNotDraftConflictOpenApiSchema,
    description: "The document is no longer a draft.",
  })
  cancel(@Req() req: RequestWithTenant, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.service.cancelDocument(req.tenantId!, id, req.userId!);
  }

  @Post(":id/apply")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({
    summary: "Apply a disaggregation document",
    description:
      "Re-validates every line and, only if all are still ok, disassembles their boxes and marks the document applied. Otherwise 409 with a code of not_draft, reason_required, no_lines, or invalid_lines (the latter includes the freshly revalidated lines).",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: disaggregationDocumentDetailOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  @ApiResponse({
    status: 409,
    schema: disaggregationApplyConflictOpenApiSchema,
    description: "The document cannot be applied in its current state.",
  })
  apply(@Req() req: RequestWithTenant, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.service.applyDocument(req.tenantId!, id, req.userId!);
  }

  @Post(":id/lines")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({
    summary: "Add lines to a draft disaggregation document",
    description:
      "Each SSCC is parsed and validated; unparseable inputs and repeats of already-present lines are stored as not_found/duplicate marker lines rather than rejected.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(addLinesSchema)
  @ApiCreatedResponse({ schema: disaggregationLinesOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  @ApiResponse({
    status: 409,
    schema: disaggregationNotDraftConflictOpenApiSchema,
    description: "The document is no longer a draft.",
  })
  addLines(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(addLinesSchema)) body: AddLinesDto,
  ) {
    return this.service.addLines(req.tenantId!, id, body.ssccs);
  }

  @Post(":id/import")
  @HttpCode(201)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 1024 * 1024, files: 1 },
    }),
  )
  @ApiConsumes("multipart/form-data")
  @ApiOperation({
    summary: "Import lines from a file",
    description:
      "Adds every SSCC token found in the uploaded text file to the draft document (same validation as adding lines manually) and marks the document's source as import.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: disaggregationImportFileOpenApiSchema })
  @ApiCreatedResponse({ schema: disaggregationLinesOpenApiSchema })
  @ApiResponse({
    status: 400,
    schema: disaggregationImportErrorOpenApiSchema,
    description: "The file is missing, contains no tokens, or exceeds the token ceiling.",
  })
  @ApiHttpErrors(401, 403, 404, 413)
  @ApiResponse({
    status: 409,
    schema: disaggregationNotDraftConflictOpenApiSchema,
    description: "The document is no longer a draft.",
  })
  async importLines(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException({ code: "file_required" });
    const tokens = parseSsccImport(file.buffer.toString("utf8"));
    if (tokens.length === 0) throw new BadRequestException({ code: "file_empty" });
    return this.service.importLines(req.tenantId!, id, tokens);
  }

  @Delete(":id/lines/:lineId")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Remove a line from a draft disaggregation document" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "lineId", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "Line removed." })
  @ApiHttpErrors(401, 403, 404)
  @ApiResponse({
    status: 409,
    schema: disaggregationNotDraftConflictOpenApiSchema,
    description: "The document is no longer a draft.",
  })
  removeLine(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("lineId", new ParseUUIDPipe()) lineId: string,
  ) {
    return this.service.removeLine(req.tenantId!, id, lineId);
  }
}
