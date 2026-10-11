import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, asc, eq, gt, isNotNull, or } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  supportTranscriptContracts,
  type SupportTranscriptPage,
} from "@markiro/platform-contracts";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { ApiCabinetAuth, ApiHttpErrors, ApiZodQuery, ApiZodResponse } from "../../lib/openapi";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { SupportChatService } from "./support-chat.service";
import { SupportChatRepository } from "./support-chat.repository";

type QueryInput = { cursor?: string; limit?: number };

function decodeCursor(value: string): string {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (
      Buffer.from(decoded, "utf8").toString("base64url") !== value ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded)
    )
      throw new Error("Invalid cursor");
    return decoded;
  } catch {
    throw new BadRequestException("Invalid support transcript cursor");
  }
}

@Injectable()
export class SupportChatTranscriptReader {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly support: SupportChatService,
    private readonly repository: SupportChatRepository,
  ) {}

  async page(
    requestId: string,
    tenantId: string | null,
    query: QueryInput,
  ): Promise<SupportTranscriptPage> {
    this.support.requireEnabled();
    const [episode] = await this.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(
        and(
          eq(schema.supportChatEpisodes.requestId, requestId),
          tenantId ? eq(schema.supportChatEpisodes.tenantId, tenantId) : undefined,
        ),
      );
    if (!episode) throw new NotFoundException();
    const limit = query.limit ?? 50;
    const [after] = query.cursor
      ? await this.db
          .select()
          .from(schema.supportChatMessages)
          .where(
            and(
              eq(schema.supportChatMessages.tenantId, episode.tenantId),
              eq(schema.supportChatMessages.episodeId, episode.id),
              eq(schema.supportChatMessages.id, decodeCursor(query.cursor)),
              eq(schema.supportChatMessages.delivery, "sent"),
              isNotNull(schema.supportChatMessages.remoteMessageId),
            ),
          )
      : [];
    if (query.cursor && !after) throw new BadRequestException("Invalid support transcript cursor");
    const rows = await this.db
      .select()
      .from(schema.supportChatMessages)
      .where(
        and(
          eq(schema.supportChatMessages.tenantId, episode.tenantId),
          eq(schema.supportChatMessages.episodeId, episode.id),
          eq(schema.supportChatMessages.delivery, "sent"),
          isNotNull(schema.supportChatMessages.remoteMessageId),
          after
            ? or(
                gt(schema.supportChatMessages.occurredAt, after.occurredAt),
                and(
                  eq(schema.supportChatMessages.occurredAt, after.occurredAt),
                  gt(schema.supportChatMessages.remoteMessageId, after.remoteMessageId!),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        asc(schema.supportChatMessages.occurredAt),
        asc(schema.supportChatMessages.remoteMessageId),
      )
      .limit(limit + 1);
    const selected = rows.slice(0, limit);
    return {
      items: selected.map((row) => ({
        id: row.id,
        direction: row.direction,
        text: row.text,
        occurredAt: row.occurredAt.toISOString(),
        delivery: "sent" as const,
      })),
      nextCursor:
        rows.length > limit ? Buffer.from(selected.at(-1)!.id).toString("base64url") : null,
      sync: await this.repository.sync(episode),
    };
  }
}

@ApiTags("support-chat-transcript")
@ApiCabinetAuth()
@Controller("billing/requests")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.BILLING_READ)
export class SupportChatTranscriptController {
  constructor(private readonly reader: SupportChatTranscriptReader) {}

  @Get(":id/transcript")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Read a support request transcript" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodQuery(supportTranscriptContracts.tenant.query)
  @ApiZodResponse({ status: 200, schema: supportTranscriptContracts.tenant.response })
  @ApiHttpErrors(400, 401, 403, 404, 503)
  read(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(supportTranscriptContracts.tenant.params)) params: { id: string },
    @Query(new ZodValidationPipe(supportTranscriptContracts.tenant.query)) query: QueryInput,
  ) {
    return this.reader.page(params.id, req.tenantId!, query);
  }
}

@ApiTags("platform-support-chat")
@Controller("platform/billing/requests")
export class PlatformSupportChatTranscriptController {
  constructor(private readonly reader: SupportChatTranscriptReader) {}

  @Get(":id/transcript")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Read a support request transcript for platform operators" })
  @PlatformApiProtectedOk({
    query: supportTranscriptContracts.platform.query,
    response: supportTranscriptContracts.platform.response,
  })
  @RequirePlatformCapabilities("billing.read")
  async read(
    @Param(new ZodValidationPipe(supportTranscriptContracts.platform.params))
    params: { id: string },
    @Query(new ZodValidationPipe(supportTranscriptContracts.platform.query)) query: QueryInput,
  ) {
    return parsePlatformResponse(
      supportTranscriptContracts.platform.response,
      await this.reader.page(params.id, null, query),
    );
  }
}
