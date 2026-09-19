import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { SecurityAuditService } from "../../authorization/security-audit.service";
import { ApiCabinetAuth, ApiHttpErrors, ApiZodValidationError } from "../../lib/openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { ChzKmOrdersService } from "./chz-km-orders.service";
import {
  chzKmIssueCodesOpenApiSchema,
  chzKmIssueConflictOpenApiSchema,
  chzKmIssueIdSchema,
  chzKmIssueNotExportOpenApiSchema,
  chzKmIssueOpenApiSchema,
  chzKmOrderIdSchema,
  chzKmOrderListOpenApiSchema,
  chzKmOrderNotFailedOpenApiSchema,
  chzKmOrderOpenApiSchema,
  chzKmOrderPreflightFailedOpenApiSchema,
  createChzKmOrderOpenApiSchema,
  createChzKmOrderSchema,
  issueChzKmCodesOpenApiSchema,
  issueChzKmCodesSchema,
  type ChzKmIssueCodesDto,
  type ChzKmIssueDto,
  type ChzKmOrderDto,
  type ChzKmOrderListDto,
  type CreateChzKmOrderDto,
  type IssueChzKmCodesDto,
} from "./dto";

@ApiTags("chz-km-orders")
@ApiCabinetAuth()
@Controller("chz-km-orders")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class ChzKmOrdersController {
  constructor(
    private readonly chzKmOrders: ChzKmOrdersService,
    private readonly audit: SecurityAuditService,
  ) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "List Chestny ZNAK marking-code orders" })
  @ApiOkResponse({ schema: chzKmOrderListOpenApiSchema })
  @ApiHttpErrors(401, 403)
  list(@Req() req: RequestWithTenant): Promise<ChzKmOrderListDto> {
    return this.chzKmOrders.list(req.tenantId!);
  }

  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Get a Chestny ZNAK marking-code order" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: chzKmOrderOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  get(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(chzKmOrderIdSchema)) id: string,
  ): Promise<ChzKmOrderDto> {
    return this.chzKmOrders.get(req.tenantId!, id);
  }

  @Post()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Order Chestny ZNAK marking codes for a product",
    description:
      "Refuses the order (422) unless every pre-flight condition holds: СУЗ settings, a paired " +
      "signer agent, a usable СУЗ token, and a product with a GTIN and a supported product " +
      "group carrying exactly one UNIT template.",
  })
  @ApiBody({ schema: createChzKmOrderOpenApiSchema })
  @ApiCreatedResponse({ schema: chzKmOrderOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  @ApiResponse({
    status: 422,
    schema: chzKmOrderPreflightFailedOpenApiSchema,
    description:
      "One or more pre-flight conditions block the order; `blockedBy` lists all of them.",
  })
  create(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createChzKmOrderSchema)) body: CreateChzKmOrderDto,
  ): Promise<ChzKmOrderDto> {
    return this.chzKmOrders.create(req.tenantId!, req.userId!, body);
  }

  @Post(":id/retry")
  @HttpCode(200)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Retry a failed Chestny ZNAK marking-code order",
    description:
      "Only accepted from the failed state: a rejected order is Chestny ZNAK's own verdict, " +
      "not a transient failure.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: chzKmOrderOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  @ApiResponse({
    status: 409,
    schema: chzKmOrderNotFailedOpenApiSchema,
    description: "The order is not in the failed state.",
  })
  retry(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(chzKmOrderIdSchema)) id: string,
  ): Promise<ChzKmOrderDto> {
    // Creation and retry are audited by the service, which is the only place
    // that knows the write happened; issuing and the two code reads are
    // audited below, where the issue id the trail points at is created.
    return this.chzKmOrders.retry(req.tenantId!, req.userId!, id);
  }

  @Post(":id/issues")
  @HttpCode(201)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Issue marking codes from a completed order",
    description:
      "Hands out a contiguous range of the lowest still-available codes, either as a downloadable " +
      "file (`export`) or as a list for a browser print page (`print`). An issue is permanent: " +
      "the codes it contains are never handed out again.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiBody({ schema: issueChzKmCodesOpenApiSchema })
  @ApiCreatedResponse({ schema: chzKmIssueOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  @ApiResponse({
    status: 409,
    schema: chzKmIssueConflictOpenApiSchema,
    description:
      "The order has not completed, or `count` exceeds the codes it still has available.",
  })
  async issue(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(chzKmOrderIdSchema)) id: string,
    @Body(new ZodValidationPipe(issueChzKmCodesSchema)) body: IssueChzKmCodesDto,
  ): Promise<ChzKmIssueDto> {
    const issue = await this.chzKmOrders.issue(req.tenantId!, req.userId!, id, body);
    // The issue id, range and counts -- never a code. A raw marking code in a
    // log is the same disclosure as handing the file to whoever reads it.
    this.audit.credentialMutation({
      tenantId: req.tenantId!,
      userId: req.userId!,
      action: "chz_km_order.issue",
      resourceId: issue.id,
      outcome: "succeeded",
    });
    return issue;
  }

  /**
   * Read access stays available under a restricted subscription: these codes
   * are already paid for, and a tenant that cannot download them cannot mark
   * the goods it has already ordered codes for.
   */
  @Get(":id/issues/:issueId/file")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Download an export issue as a file",
    description:
      "One raw code per LF-terminated line (TXT) or a single quoted `code` column (CSV), both " +
      "UTF-8 without BOM and preserving the GS1 group separator. Sent with `Cache-Control: " +
      "no-store`: raw marking codes must not outlive the response in a cache.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "issueId", schema: { type: "string", format: "uuid" } })
  @ApiResponse({
    status: 200,
    description: "The issue's codes as a TXT or CSV attachment.",
    content: {
      "text/plain; charset=utf-8": { schema: { type: "string" } },
      "text/csv; charset=utf-8": { schema: { type: "string" } },
    },
  })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  @ApiResponse({
    status: 409,
    schema: chzKmIssueNotExportOpenApiSchema,
    description: "The issue is a print batch, which has no file.",
  })
  async issueFile(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(chzKmOrderIdSchema)) id: string,
    @Param("issueId", new ZodValidationPipe(chzKmIssueIdSchema)) issueId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.chzKmOrders.issueFile(req.tenantId!, id, issueId);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
    res.setHeader("Cache-Control", "no-store");
    this.audit.sensitiveRead({
      tenantId: req.tenantId!,
      userId: req.userId ?? null,
      action: "chz_km_order.codes_read",
      resourceId: issueId,
    });
    return new StreamableFile(Buffer.from(file.bytes), { length: file.bytes.byteLength });
  }

  @Get(":id/issues/:issueId/codes")
  @Header("Cache-Control", "no-store")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Get an issue's codes for a print page",
    description:
      "The raw codes of one issue in `seq` order, for the cabinet's browser print view. Sent " +
      "with `Cache-Control: no-store`: raw marking codes must not outlive the response in a cache.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "issueId", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: chzKmIssueCodesOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  async issueCodes(
    @Req() req: RequestWithTenant,
    @Param("id", new ZodValidationPipe(chzKmOrderIdSchema)) id: string,
    @Param("issueId", new ZodValidationPipe(chzKmIssueIdSchema)) issueId: string,
  ): Promise<ChzKmIssueCodesDto> {
    const codes = await this.chzKmOrders.issueCodes(req.tenantId!, id, issueId);
    this.audit.sensitiveRead({
      tenantId: req.tenantId!,
      userId: req.userId ?? null,
      action: "chz_km_order.codes_read",
      resourceId: issueId,
    });
    return codes;
  }
}
