import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
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
  platformBillingRequestListQuerySchema,
  platformBillingRequestStatusSchema,
  type PlatformBillingRequestCommentDto,
  type PlatformBillingRequestLinkDto,
  type PlatformBillingRequestListQueryDto,
  type PlatformBillingRequestStatusMutationDto,
} from "./dto";
import { PlatformBillingRequestsService } from "./platform-billing-requests.service";

@Controller("platform/billing/requests")
export class PlatformBillingRequestsController {
  constructor(private readonly requests: PlatformBillingRequestsService) {}

  @Get()
  @PlatformApiProtectedOk({ response: platformCommercialContracts.billingRequests.list.response })
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

  @Post(":id/comments")
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
