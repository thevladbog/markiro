import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
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
  ApiZodQuery,
  ApiZodValidationError,
} from "../../lib/openapi";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  boxCardOpenApiSchema,
  classifyNotFoundOpenApiSchema,
  classifyQuerySchema,
  classifySearchResponseOpenApiSchema,
  codeCardOpenApiSchema,
  codeHashParamSchema,
  listCodesOpenApiSchema,
  listCodesQuerySchema,
  type BoxCardDto,
  type ClassifyQueryDto,
  type ClassifySearchResponseDto,
  type CodeCardDto,
  type ListCodesQueryDto,
  type ListCodesResponseDto,
} from "./dto";
import { CodeSearchService } from "./code-search.service";
import { renderBoxReportHtml } from "./box-report";

/**
 * Manager-only, entirely read-only module: classify a scanned/typed input
 * (SSCC or KM) to a box or a code, and browse the tenant's code registry
 * with derived status. Cabinet authorization keeps a station api-key out
 * even though `TenantGuard` accepts it for tenant resolution -- see
 * docs/device-key-surface.md and conflicts.controller.ts for the same
 * pattern.
 */
@ApiTags("code-search")
@ApiCabinetAuth()
@Controller("code-search")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class CodeSearchController {
  constructor(private readonly codeSearchService: CodeSearchService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Classify a scanned or typed input",
    description:
      "Resolves an SSCC (full or partial) or a marking code (KM) to a box or a code. A partial SSCC matching several boxes returns a disambiguation list.",
  })
  @ApiZodQuery(classifyQuerySchema)
  @ApiOkResponse({ schema: classifySearchResponseOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  @ApiResponse({
    status: 404,
    schema: classifyNotFoundOpenApiSchema,
    description: "The input is unrecognized, or nothing in this tenant matches it.",
  })
  async classify(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(classifyQuerySchema)) query: ClassifyQueryDto,
  ): Promise<ClassifySearchResponseDto> {
    return this.codeSearchService.classify(req.tenantId!, query.q);
  }

  @Get("codes")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "List registered codes" })
  // Manual ApiQuery: `from`/`to` use z.coerce.date()/a transform, which
  // z.toJSONSchema cannot represent.
  @ApiQuery({ name: "page", required: false, schema: { type: "integer", minimum: 1, default: 1 } })
  @ApiQuery({
    name: "from",
    required: false,
    schema: { type: "string", format: "date-time" },
    description: "Inclusive lower bound on scannedAt.",
  })
  @ApiQuery({
    name: "to",
    required: false,
    schema: { type: "string" },
    description:
      "Upper bound on scannedAt: an ISO date-time, or a date-only YYYY-MM-DD value covering that whole day.",
  })
  @ApiQuery({
    name: "productionFrom",
    required: false,
    schema: { type: "string", format: "date" },
    description: "Inclusive lower bound on the shift's production day (YYYY-MM-DD).",
  })
  @ApiQuery({
    name: "productionTo",
    required: false,
    schema: { type: "string", format: "date" },
    description: "Inclusive upper bound on the shift's production day (YYYY-MM-DD).",
  })
  @ApiQuery({ name: "productId", required: false, schema: { type: "string", format: "uuid" } })
  @ApiQuery({ name: "shiftId", required: false, schema: { type: "string", format: "uuid" } })
  @ApiQuery({
    name: "status",
    required: false,
    schema: { type: "string", enum: ["free", "aggregated", "written_off"] },
  })
  @ApiOkResponse({ schema: listCodesOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  async listCodes(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listCodesQuerySchema)) query: ListCodesQueryDto,
  ): Promise<ListCodesResponseDto> {
    return this.codeSearchService.listCodes(req.tenantId!, query);
  }

  /**
   * `codeHash` isn't a UUID, so it can't reuse `ParseUUIDPipe` -- a malformed
   * value (wrong length/charset) is treated the same as "not in this
   * tenant's registry" (404), not a 400: from the caller's perspective both
   * mean "nothing to show for this input".
   */
  @Get("codes/:codeHash")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Get a code card",
    description:
      "The code's identity, derived status, current box, and full movement history. A malformed codeHash yields 404 (not 400), same as an unknown one.",
  })
  @ApiParam({ name: "codeHash", schema: { type: "string", pattern: "^[0-9a-f]{64}$" } })
  @ApiOkResponse({ schema: codeCardOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  async getCodeCard(
    @Req() req: RequestWithTenant,
    @Param("codeHash") codeHash: string,
  ): Promise<CodeCardDto> {
    if (!codeHashParamSchema.safeParse(codeHash).success) {
      throw new NotFoundException();
    }
    return this.codeSearchService.getCodeCard(req.tenantId!, codeHash);
  }

  @Get("boxes/:boxId")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Get a box card" })
  @ApiParam({ name: "boxId", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: boxCardOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  async getBoxCard(
    @Req() req: RequestWithTenant,
    @Param("boxId", new ParseUUIDPipe()) boxId: string,
  ): Promise<BoxCardDto> {
    return this.codeSearchService.getBoxCard(req.tenantId!, boxId);
  }

  /**
   * Print-ready A4 "Состав короба": the box row (SSCC + Code128) with each
   * unit code indented underneath (DataMatrix). Same open-in-new-tab HTML
   * contract as `GET /disaggregation/:id/report`.
   */
  @Get("boxes/:boxId/report")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Render the box contents report",
    description:
      'Print-ready A4 HTML ("Состав короба") for opening in a new tab: the box row (SSCC + Code128) with each unit code indented underneath (DataMatrix).',
  })
  @ApiParam({ name: "boxId", schema: { type: "string", format: "uuid" } })
  @ApiProduces("text/html")
  @ApiOkResponse({ schema: { type: "string" }, description: "Print-ready HTML document." })
  @ApiHttpErrors(401, 403, 404)
  async boxReport(
    @Req() req: RequestWithTenant,
    @Param("boxId", new ParseUUIDPipe()) boxId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const data = await this.codeSearchService.boxReportData(req.tenantId!, boxId);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return renderBoxReportHtml(data);
  }
}
