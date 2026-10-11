import { Body, Controller, Get, Header, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { supportChatContracts } from "@markiro/platform-contracts";
import { RequireMembership } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodQuery,
  ApiZodResponse,
} from "../../lib/openapi";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { SupportChatService } from "./support-chat.service";
import {
  SupportChatEscalationService,
  type SupportDecisionInput,
} from "./support-chat-escalation.service";

@ApiTags("support-chat")
@ApiCabinetAuth()
@Controller("support-chat/episodes")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@RequireMembership()
@AllowSubscriptionReadOnly("read")
export class SupportChatController {
  constructor(
    private readonly support: SupportChatService,
    private readonly escalation: SupportChatEscalationService,
  ) {}

  private owner(req: RequestWithTenant) {
    const principal = req.cabinetPrincipal!;
    return { tenantId: principal.tenantId, userId: principal.userId };
  }

  @Get()
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "List own support episodes" })
  @ApiZodQuery(supportChatContracts.episodeList.query)
  @ApiZodResponse({ status: 200, schema: supportChatContracts.episodeList.response })
  @ApiHttpErrors(400, 401, 403, 503)
  list(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(supportChatContracts.episodeList.query))
    query: { cursor?: string; limit?: number },
  ) {
    return this.support.list(this.owner(req), query);
  }

  @Post()
  @AllowSubscriptionReadOnly("read")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Create an own support episode" })
  @ApiZodBody(supportChatContracts.episodeCreate.body)
  @ApiZodResponse({ status: 201, schema: supportChatContracts.episodeCreate.response })
  @ApiHttpErrors(400, 401, 403, 503)
  create(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(supportChatContracts.episodeCreate.body))
    body: { idempotencyKey: string },
  ) {
    return this.support.create(this.owner(req), body);
  }

  @Get(":id")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Read an own support episode" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodQuery(supportChatContracts.episode.query)
  @ApiZodResponse({ status: 200, schema: supportChatContracts.episode.response })
  @ApiHttpErrors(400, 401, 403, 404, 503)
  detail(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(supportChatContracts.episode.params)) params: { id: string },
    @Query(new ZodValidationPipe(supportChatContracts.episode.query))
    query: { cursor?: string; limit?: number },
  ) {
    return this.support.detail(this.owner(req), params.id, query);
  }

  @Post(":id/messages")
  @AllowSubscriptionReadOnly("read")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Send a public text support message" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(supportChatContracts.message.body)
  @ApiZodResponse({ status: 201, schema: supportChatContracts.message.response })
  @ApiHttpErrors(400, 401, 403, 404, 409, 503)
  send(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(supportChatContracts.message.params)) params: { id: string },
    @Body(new ZodValidationPipe(supportChatContracts.message.body))
    body: { text: string; idempotencyKey: string },
  ) {
    return this.support.send(this.owner(req), params.id, body);
  }

  @Post(":id/proposals/:proposalId/decision")
  @AllowSubscriptionReadOnly("read")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Decide whether to share an own support conversation in a request" })
  @ApiZodBody(supportChatContracts.decision.body)
  @ApiZodResponse({ status: 201, schema: supportChatContracts.decision.response })
  @ApiHttpErrors(400, 401, 403, 404, 409, 503)
  decide(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(supportChatContracts.decision.params))
    params: { id: string; proposalId: string },
    @Body(new ZodValidationPipe(supportChatContracts.decision.body)) body: SupportDecisionInput,
  ) {
    return this.escalation.decide(this.owner(req), params.id, params.proposalId, body);
  }
}
