import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { platformCommercialContracts } from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  billingActCancelSchema,
  billingActCreateSchema,
  billingActIdSchema,
  billingActIssueSchema,
  billingActListQuerySchema,
  type BillingActCancelDto,
  type BillingActCreateDto,
  type BillingActIssueDto,
  type BillingActListQueryDto,
} from "./dto";
import { BillingActsService } from "./billing-acts.service";

const billingActDocumentDownloadParamsPipe = new ZodValidationPipe(
  platformCommercialContracts.billingActs.documents.download.params,
);

@ApiTags("platform-billing-acts")
@Controller("platform/billing/acts")
export class BillingActsController {
  constructor(private readonly acts: BillingActsService) {}

  @Get()
  @ApiOperation({ summary: "List billing acts" })
  @PlatformApiProtectedOk({
    query: platformCommercialContracts.billingActs.list.query,
    response: platformCommercialContracts.billingActs.list.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async list(
    @Req() req: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(billingActListQuerySchema)) query: BillingActListQueryDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingActs.list.response,
      await this.acts.list(req.platformPrincipal!, query),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Read a billing act" })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.billingActs.detail.response })
  @RequirePlatformCapabilities("billing.read")
  async detail(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(billingActIdSchema)) id: string,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingActs.detail.response,
      await this.acts.detail(req.platformPrincipal!, id),
    );
  }

  @Get(":id/documents/:documentId/download")
  @ApiOperation({ summary: "Get a billing act document download URL" })
  @PlatformApiProtectedOk({
    response: platformCommercialContracts.billingActs.documents.download.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async documentDownload(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(billingActIdSchema)) id: string,
    @Param("documentId") documentId: string,
  ) {
    const params = {
      actId: id,
      documentId,
    };
    billingActDocumentDownloadParamsPipe.transform(params);
    return parsePlatformResponse(
      platformCommercialContracts.billingActs.documents.download.response,
      await this.acts.documentUrl(req.platformPrincipal!, params.actId, params.documentId),
    );
  }

  @Post()
  @ApiOperation({ summary: "Create a billing act" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.billingActs.create.body,
    response: platformCommercialContracts.billingActs.create.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async create(
    @Req() req: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(billingActCreateSchema)) body: BillingActCreateDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingActs.create.response,
      await this.acts.create(req.platformPrincipal!, body),
    );
  }

  @Post(":id/issue")
  @ApiOperation({ summary: "Generate and issue a billing act PDF" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.billingActs.issue.body,
    response: platformCommercialContracts.billingActs.issue.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async issue(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(billingActIdSchema)) id: string,
    @Body(new ZodValidationPipe(billingActIssueSchema)) body: BillingActIssueDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingActs.issue.response,
      await this.acts.issueGenerated(req.platformPrincipal!, id, body),
    );
  }

  @Post(":id/cancel")
  @ApiOperation({ summary: "Cancel a billing act" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.billingActs.cancel.body,
    response: platformCommercialContracts.billingActs.cancel.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async cancel(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(billingActIdSchema)) id: string,
    @Body(new ZodValidationPipe(billingActCancelSchema)) body: BillingActCancelDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingActs.cancel.response,
      await this.acts.cancel(req.platformPrincipal!, id, body),
    );
  }
}
