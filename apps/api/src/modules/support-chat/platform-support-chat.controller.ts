import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { platformSupportChatContracts } from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { SupportChatRepository } from "./support-chat.repository";
import { SupportChatService } from "./support-chat.service";
import { SupportChatProposalsService } from "./support-chat-proposals.service";
import { SupportChatJobsService } from "./support-chat-jobs.service";

@ApiTags("platform-support-chat")
@Controller("platform/support-chat/episodes")
export class PlatformSupportChatController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly support: SupportChatService,
    private readonly repository: SupportChatRepository,
    private readonly proposals: SupportChatProposalsService,
    private readonly jobs: SupportChatJobsService,
  ) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "List support episodes for platform operators" })
  @PlatformApiProtectedOk({
    query: platformSupportChatContracts.episodeList.query,
    response: platformSupportChatContracts.episodeList.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async list(
    @Query(new ZodValidationPipe(platformSupportChatContracts.episodeList.query))
    query: {
      tenantId?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    this.support.requireEnabled();
    const limit = query.limit ?? 50;
    const [after] = query.cursor
      ? await this.db
          .select()
          .from(schema.supportChatEpisodes)
          .where(
            and(
              eq(schema.supportChatEpisodes.id, query.cursor),
              query.tenantId ? eq(schema.supportChatEpisodes.tenantId, query.tenantId) : undefined,
            ),
          )
      : [];
    if (query.cursor && !after) throw new NotFoundException();
    const rows = await this.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(
        and(
          query.tenantId ? eq(schema.supportChatEpisodes.tenantId, query.tenantId) : undefined,
          after
            ? or(
                gt(schema.supportChatEpisodes.createdAt, after.createdAt),
                and(
                  eq(schema.supportChatEpisodes.createdAt, after.createdAt),
                  gt(schema.supportChatEpisodes.id, after.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(schema.supportChatEpisodes.createdAt), asc(schema.supportChatEpisodes.id))
      .limit(limit + 1);
    const selected = rows.slice(0, limit);
    const items = await Promise.all(
      selected.map(async (episode) => ({
        id: episode.id,
        ...(await this.repository.state(episode)),
        sync: await this.repository.sync(episode),
      })),
    );
    return parsePlatformResponse(platformSupportChatContracts.episodeList.response, {
      items,
      nextCursor: rows.length > limit ? (selected.at(-1)?.id ?? null) : null,
    });
  }

  @Get(":id")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Read a support episode for platform operators" })
  @PlatformApiProtectedOk({
    query: platformSupportChatContracts.episode.query,
    response: platformSupportChatContracts.episode.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async detail(
    @Param(new ZodValidationPipe(platformSupportChatContracts.episode.params))
    params: { id: string },
    @Query(new ZodValidationPipe(platformSupportChatContracts.episode.query))
    query: { cursor?: string; limit?: number },
  ) {
    this.support.requireEnabled();
    const linked = await this.repository.episodeById(params.id);
    if (!linked) throw new NotFoundException();
    return parsePlatformResponse(
      platformSupportChatContracts.episode.response,
      await this.support.view(linked.episode, query),
    );
  }

  @Post(":id/proposals")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Propose escalation of a support episode" })
  @PlatformApiProtectedCreated({
    body: platformSupportChatContracts.proposal.body,
    response: platformSupportChatContracts.proposal.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async propose(
    @Req() req: RequestWithPlatformPrincipal,
    @Param(new ZodValidationPipe(platformSupportChatContracts.proposal.params))
    params: { id: string },
    @Body(new ZodValidationPipe(platformSupportChatContracts.proposal.body))
    body: { title: string; summary: string; idempotencyKey: string },
  ) {
    return parsePlatformResponse(
      platformSupportChatContracts.proposal.response,
      await this.proposals.propose(req.platformPrincipal!, params.id, body),
    );
  }

  @Post(":id/retry-sync")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Schedule support transcript reconciliation" })
  @PlatformApiProtectedOk({
    body: platformSupportChatContracts.retrySync.body,
    response: platformSupportChatContracts.retrySync.response,
  })
  @RequirePlatformCapabilities("billing.write")
  async retrySync(
    @Req() req: RequestWithPlatformPrincipal,
    @Param(new ZodValidationPipe(platformSupportChatContracts.retrySync.params))
    params: { id: string },
    @Body(new ZodValidationPipe(platformSupportChatContracts.retrySync.body))
    _body: Record<string, never>,
  ) {
    return parsePlatformResponse(
      platformSupportChatContracts.retrySync.response,
      await this.jobs.retrySync(req.platformPrincipal!, params.id),
    );
  }
}
