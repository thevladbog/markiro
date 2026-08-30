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
  platformBillingRequestCommentSchema,
  platformBillingRequestIdSchema,
  platformBillingRequestLinkSchema,
  platformBillingRequestLinkTargetQuerySchema,
  platformBillingRequestListQuerySchema,
  platformBillingRequestOfferCreateSchema,
  platformBillingRequestStatusSchema,
  type PlatformBillingRequestCommentDto,
  type PlatformBillingRequestLinkDto,
  type PlatformBillingRequestLinkTargetQueryDto,
  type PlatformBillingRequestListQueryDto,
  type PlatformBillingRequestOfferCreateDto,
  type PlatformBillingRequestStatusMutationDto,
} from "./dto";
import { PlatformBillingRequestsService } from "./platform-billing-requests.service";

@ApiTags("platform-billing-requests")
@Controller("platform/billing/requests")
export class PlatformBillingRequestsController {
  constructor(private readonly requests: PlatformBillingRequestsService) {}

  @Get()
  @ApiOperation({ summary: "List tenant billing requests for the platform" })
  @PlatformApiProtectedOk({
    query: platformCommercialContracts.billingRequests.list.query,
    response: platformCommercialContracts.billingRequests.list.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async list(
    @Req() req: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(platformBillingRequestListQuerySchema))
    query: PlatformBillingRequestListQueryDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingRequests.list.response,
      await this.requests.list(req.platformPrincipal!, query),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Read a tenant billing request for the platform" })
  @PlatformApiProtectedOk({ response: platformCommercialContracts.billingRequests.detail.response })
  @RequirePlatformCapabilities("billing.read")
  async detail(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformBillingRequestIdSchema)) id: string,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingRequests.detail.response,
      await this.requests.detail(req.platformPrincipal!, id),
    );
  }

  @Get(":id/link-targets")
  @ApiOperation({ summary: "Suggest tenant resources for a billing request link" })
  @PlatformApiProtectedOk({
    query: platformCommercialContracts.billingRequests.linkTargets.query,
    response: platformCommercialContracts.billingRequests.linkTargets.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async linkTargets(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformBillingRequestIdSchema)) id: string,
    @Query(new ZodValidationPipe(platformBillingRequestLinkTargetQuerySchema))
    query: PlatformBillingRequestLinkTargetQueryDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingRequests.linkTargets.response,
      await this.requests.linkTargets(req.platformPrincipal!, id, query),
    );
  }

  @Post(":id/offer")
  @ApiOperation({ summary: "Create an offer for a tenant billing request" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.billingRequests.createOffer.body,
    response: platformCommercialContracts.billingRequests.createOffer.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async createOffer(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformBillingRequestIdSchema)) id: string,
    @Body(new ZodValidationPipe(platformBillingRequestOfferCreateSchema))
    body: PlatformBillingRequestOfferCreateDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingRequests.createOffer.response,
      await this.requests.createOffer(req.platformPrincipal!, id, body),
    );
  }

  @Post(":id/comments")
  @ApiOperation({ summary: "Comment on a tenant billing request" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.billingRequests.comment.body,
    response: platformCommercialContracts.billingRequests.comment.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async comment(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformBillingRequestIdSchema)) id: string,
    @Body(new ZodValidationPipe(platformBillingRequestCommentSchema))
    body: PlatformBillingRequestCommentDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingRequests.comment.response,
      await this.requests.comment(req.platformPrincipal!, id, body),
    );
  }

  @Post(":id/status")
  @ApiOperation({ summary: "Change a tenant billing request status" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.billingRequests.status.body,
    response: platformCommercialContracts.billingRequests.status.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async status(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformBillingRequestIdSchema)) id: string,
    @Body(new ZodValidationPipe(platformBillingRequestStatusSchema))
    body: PlatformBillingRequestStatusMutationDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingRequests.status.response,
      await this.requests.changeStatus(req.platformPrincipal!, id, body),
    );
  }

  @Post(":id/links")
  @ApiOperation({ summary: "Link a resource to a tenant billing request" })
  @PlatformApiProtectedCreated({
    body: platformCommercialContracts.billingRequests.link.body,
    response: platformCommercialContracts.billingRequests.link.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async link(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformBillingRequestIdSchema)) id: string,
    @Body(new ZodValidationPipe(platformBillingRequestLinkSchema))
    body: PlatformBillingRequestLinkDto,
  ) {
    return parsePlatformResponse(
      platformCommercialContracts.billingRequests.link.response,
      await this.requests.link(req.platformPrincipal!, id, body),
    );
  }
}
