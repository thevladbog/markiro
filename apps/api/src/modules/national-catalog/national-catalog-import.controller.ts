import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Req,
  Res,
  HttpCode,
  ParseUUIDPipe,
  UseGuards,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Response } from "express";
import { ApiOperation, ApiTags, ApiOkResponse } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { z } from "zod";
import * as contracts from "@markiro/platform-contracts";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodResponse,
  ApiZodQuery,
} from "../../lib/openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import type { ImportActor } from "./national-catalog-import.types";
import { NationalCatalogImportService } from "./national-catalog-import.service";
import { NationalCatalogImportPreviewService } from "./national-catalog-import-preview.service";
import { NationalCatalogImportApplyService } from "./national-catalog-import-apply.service";
import { NationalCatalogImageService } from "./national-catalog-image.service";
import { NationalCatalogCapabilitiesService } from "./national-catalog-capabilities.service";
function actor(req: RequestWithTenant): ImportActor {
  if (!req.tenantId || !req.userId) throw new UnauthorizedException();
  return { tenantId: req.tenantId, userId: req.userId };
}

const itemsHttpQuerySchema = z
  .object({
    cursor: z.string().optional(),
    search: z.string().max(500).default(""),
    statuses: z
      .union([contracts.chzStatusKeySchema, z.array(contracts.chzStatusKeySchema)])
      .optional(),
    includeArchived: z.enum(["true", "false"]).default("false"),
    limit: z.coerce.number().int().min(1).max(100).default(100),
  })
  .strict();
@ApiTags("national-catalog-import")
@ApiCabinetAuth()
@Controller("national-catalog")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class NationalCatalogImportController {
  constructor(
    private readonly sessions: NationalCatalogImportService,
    private readonly previews: NationalCatalogImportPreviewService,
    private readonly applies: NationalCatalogImportApplyService,
    private readonly images: NationalCatalogImageService,
    private readonly capabilities: NationalCatalogCapabilitiesService,
  ) {}
  @Get("capabilities")
  @ApiOperation({ summary: "Read National Catalog import capabilities" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiZodResponse({ status: 200, schema: contracts.catalogCapabilitiesSchema })
  capabilitiesRead(@Req() req: RequestWithTenant) {
    return this.capabilities.read(actor(req).tenantId);
  }
  @Post("import-sessions")
  @ApiOperation({ summary: "Start a National Catalog import session" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiZodBody(contracts.importStartSchema)
  @ApiZodResponse({ status: 200, schema: contracts.importSessionSchema })
  start(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(contracts.importStartSchema)) body: contracts.ImportStart,
  ) {
    return this.sessions.start(actor(req), body);
  }
  @Get("import-sessions/:sessionId")
  @ApiOperation({ summary: "Read a saved import session" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiZodResponse({ status: 200, schema: contracts.importSessionSchema })
  read(@Req() req: RequestWithTenant, @Param("sessionId", new ParseUUIDPipe()) sessionId: string) {
    return this.sessions.read(actor(req).tenantId, sessionId);
  }
  @Post("import-sessions/:sessionId/retries")
  @ApiOperation({ summary: "Retry import enumeration" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiZodBody(contracts.importSessionRetrySchema)
  @ApiZodResponse({ status: 200, schema: contracts.importSessionSchema })
  retrySession(
    @Req() req: RequestWithTenant,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Body(new ZodValidationPipe(contracts.importSessionRetrySchema))
    _body: z.infer<typeof contracts.importSessionRetrySchema>,
  ) {
    return this.sessions.retry(actor(req), sessionId);
  }
  @Put("import-sessions/:sessionId/selection")
  @ApiOperation({ summary: "Update the import selection" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiZodBody(contracts.importSelectionSchema)
  @ApiZodResponse({ status: 200, schema: contracts.importSessionSchema })
  select(
    @Req() req: RequestWithTenant,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Body(new ZodValidationPipe(contracts.importSelectionSchema)) body: contracts.ImportSelection,
  ) {
    return this.sessions.select(actor(req), sessionId, body);
  }
  @Post("import-sessions/:sessionId/previews")
  @ApiOperation({ summary: "Prepare selected import previews" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiZodBody(contracts.importPrepareSchema)
  @ApiZodResponse({ status: 200, schema: contracts.importPrepareResponseSchema })
  prepare(
    @Req() req: RequestWithTenant,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Body(new ZodValidationPipe(contracts.importPrepareSchema)) body: contracts.ImportPrepare,
  ) {
    return this.previews.prepare(actor(req), sessionId, body);
  }
  @Get("import-sessions/:sessionId/preparations/:preparationId")
  @ApiOperation({ summary: "Read saved import preparation" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiZodResponse({ status: 200, schema: contracts.importPrepareResponseSchema })
  preparation(
    @Req() req: RequestWithTenant,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Param("preparationId", new ParseUUIDPipe()) preparationId: string,
  ) {
    return this.previews.readPreparation(actor(req).tenantId, sessionId, preparationId);
  }
  @Post("import-sessions/:sessionId/preparations/:preparationId/retries")
  @ApiOperation({ summary: "Retry import preparation" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiZodBody(contracts.importPreparationRetrySchema)
  @ApiZodResponse({ status: 200, schema: contracts.importPrepareResponseSchema })
  retryPreparation(
    @Req() req: RequestWithTenant,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Param("preparationId", new ParseUUIDPipe()) preparationId: string,
    @Body(new ZodValidationPipe(contracts.importPreparationRetrySchema))
    _body: z.infer<typeof contracts.importPreparationRetrySchema>,
  ) {
    return this.previews.retryPreparation(actor(req), sessionId, preparationId);
  }
  @Post("import-sessions/:sessionId/previews/:previewId/images/:candidateId")
  @ApiOperation({ summary: "Prepare an alternative import photo" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiZodBody(contracts.importSessionRetrySchema)
  @ApiZodResponse({ status: 200, schema: contracts.importPhotoSchema })
  prepareImage(
    @Req() req: RequestWithTenant,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Param("previewId", new ParseUUIDPipe()) previewId: string,
    @Param("candidateId", new ParseUUIDPipe()) candidateId: string,
    @Body(new ZodValidationPipe(contracts.importSessionRetrySchema))
    _body: z.infer<typeof contracts.importSessionRetrySchema>,
  ) {
    return this.images.prepare(actor(req), sessionId, previewId, candidateId);
  }
  @Post("import-sessions/:sessionId/applies")
  @ApiOperation({ summary: "Accept import decisions" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiZodBody(contracts.importApplySchema)
  @ApiZodResponse({ status: 200, schema: contracts.importResultSchema })
  apply(
    @Req() req: RequestWithTenant,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Body(new ZodValidationPipe(contracts.importApplySchema)) body: contracts.ImportApply,
  ) {
    return this.applies.start(actor(req), sessionId, body);
  }
  @Get("import-sessions/:sessionId/applies/:operationId")
  @ApiOperation({ summary: "Read saved import results" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiZodResponse({ status: 200, schema: contracts.importResultSchema })
  result(
    @Req() req: RequestWithTenant,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Param("operationId", new ParseUUIDPipe()) operationId: string,
  ) {
    return this.applies.read(actor(req).tenantId, sessionId, operationId);
  }
  @Post("import-sessions/:sessionId/applies/:operationId/retries")
  @ApiOperation({ summary: "Retry failed import results" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiZodBody(contracts.importApplyRetrySchema)
  @ApiZodResponse({ status: 200, schema: contracts.importResultSchema })
  retryApply(
    @Req() req: RequestWithTenant,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Param("operationId", new ParseUUIDPipe()) operationId: string,
    @Body(new ZodValidationPipe(contracts.importApplyRetrySchema))
    body: z.infer<typeof contracts.importApplyRetrySchema>,
  ) {
    return this.applies.retry(actor(req), sessionId, operationId, body.previewIds);
  }
  @Post("import-sessions/:sessionId/cancel")
  @ApiOperation({ summary: "Cancel an import session" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiZodBody(contracts.importSessionRetrySchema)
  @ApiZodResponse({ status: 200, schema: contracts.importSessionSchema })
  cancel(
    @Req() req: RequestWithTenant,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Body(new ZodValidationPipe(contracts.importSessionRetrySchema))
    _body: z.infer<typeof contracts.importSessionRetrySchema>,
  ) {
    return this.sessions.cancel(actor(req), sessionId);
  }
  @Get("import-sessions/:sessionId/items")
  @ApiOperation({ summary: "List stored import items" })
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiZodQuery(itemsHttpQuerySchema)
  @ApiZodResponse({ status: 200, schema: contracts.importItemsResponseSchema })
  items(
    @Req() req: RequestWithTenant,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Query(new ZodValidationPipe(itemsHttpQuerySchema)) query: z.infer<typeof itemsHttpQuerySchema>,
  ) {
    const parsed = contracts.importItemsQuerySchema.safeParse({
      ...query,
      cursor: query.cursor ?? null,
      statuses: typeof query.statuses === "string" ? [query.statuses] : (query.statuses ?? []),
      includeArchived: query.includeArchived === "true",
    });
    if (!parsed.success) throw new UnprocessableEntityException("invalid_items_query");
    return this.sessions.items(actor(req).tenantId, sessionId, parsed.data);
  }
  @Get("import-sessions/:sessionId/images/:candidateId")
  @ApiOperation({ summary: "Read a private prepared WebP photo" })
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOkResponse({ content: { "image/webp": { schema: { type: "string", format: "binary" } } } })
  async image(
    @Req() req: RequestWithTenant,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Param("candidateId", new ParseUUIDPipe()) candidateId: string,
    @Res() res: Response,
  ) {
    const image = await this.images.readPreview(actor(req).tenantId, sessionId, candidateId);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type(image.contentType).send(image.buffer);
  }
}
