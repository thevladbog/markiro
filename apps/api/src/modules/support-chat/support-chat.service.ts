import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { SupportEpisodeView, SupportOwner, SupportMessage } from "@markiro/platform-contracts";
import { AuthorizationService } from "../../authorization/authorization.service";
import { CHATWOOT_CONFIG, ChatwootClient, type ChatwootConfig } from "./chatwoot.client";
import { SupportChatRepository, type EpisodeRow } from "./support-chat.repository";
import { SupportChatDeliveryService, publicSupportMessage } from "./support-chat-delivery.service";

export const SUPPORT_CHAT_ENABLED = Symbol("SUPPORT_CHAT_ENABLED");
export type SupportPageQuery = { cursor?: string; limit?: number };

@Injectable()
export class SupportChatService {
  constructor(
    private readonly repository: SupportChatRepository,
    private readonly delivery: SupportChatDeliveryService,
    private readonly chatwoot: ChatwootClient,
    private readonly authorization: AuthorizationService,
    @Inject(SUPPORT_CHAT_ENABLED) private readonly enabled: boolean,
    @Inject(CHATWOOT_CONFIG) private readonly config: ChatwootConfig | null,
  ) {}

  requireEnabled(): void {
    if (!this.enabled || !this.config)
      throw new ServiceUnavailableException("Support chat unavailable");
  }

  private async requireCurrentMembership(owner: SupportOwner): Promise<void> {
    if (!(await this.authorization.resolvePrincipal(owner.userId, owner.tenantId))) {
      throw new ForbiddenException("Insufficient cabinet permissions");
    }
  }

  async view(episode: EpisodeRow, query: SupportPageQuery = {}): Promise<SupportEpisodeView> {
    const limit = query.limit ?? 50;
    const rows = await this.repository.messages(episode, limit + 1, query.cursor);
    const history = !episode.requestId
      ? await this.repository.privateHistoryCheckpoint(episode)
      : null;
    const hasMore = rows.length > limit || history?.before !== undefined;
    const selected = rows.slice(0, limit);
    const state = await this.repository.state(episode);
    return {
      id: episode.id,
      messages: [...selected].reverse().map(publicSupportMessage),
      nextCursor: hasMore ? (selected.at(-1)?.id ?? query.cursor ?? null) : null,
      proposal: state.proposal,
      request: state.request,
      sync: await this.repository.sync(episode),
    };
  }

  async list(owner: SupportOwner, query: SupportPageQuery) {
    this.requireEnabled();
    const limit = query.limit ?? 50;
    const rows = await this.repository.listEpisodes(owner, limit + 1, query.cursor);
    const selected = rows.slice(0, limit);
    const items = await Promise.all(
      selected.map(async (row) => ({
        id: row.id,
        ...(await this.repository.state(row)),
        sync: await this.repository.sync(row),
      })),
    );
    await this.requireCurrentMembership(owner);
    return { items, nextCursor: rows.length > limit ? (selected.at(-1)?.id ?? null) : null };
  }

  async create(
    owner: SupportOwner,
    input: { idempotencyKey: string },
  ): Promise<SupportEpisodeView> {
    this.requireEnabled();
    const episode = await this.repository.createEpisode(owner, input.idempotencyKey);
    try {
      await this.chatwoot.ensureConversation(episode.id);
    } catch {
      /* local episode remains pending */
    }
    await this.requireCurrentMembership(owner);
    return this.view(episode);
  }

  async detail(
    owner: SupportOwner,
    episodeId: string,
    query: SupportPageQuery,
  ): Promise<SupportEpisodeView> {
    this.requireEnabled();
    const episode = await this.repository.findEpisode(owner, episodeId);
    if (!episode) throw new NotFoundException();
    // Once consent creates a request, only the complete fenced job may advance
    // transcript health. The latest-message window is still useful for live chat.
    if (
      !episode.requestId &&
      episode.remoteAccountId &&
      episode.remoteInboxId &&
      episode.remoteConversationId
    ) {
      const ownerRow = await this.repository.episodeById(episode.id);
      if (ownerRow?.owner.remoteContactId) {
        try {
          const mapping = {
            accountId: episode.remoteAccountId,
            inboxId: episode.remoteInboxId,
            conversationId: episode.remoteConversationId,
            contactId: Number(ownerRow.owner.remoteContactId),
          };
          // A bounded cycle resumes its raw cursor across polls, including
          // private-only pages. Later cycles stop at the prior high-water mark.
          for (let pages = 0; pages < 2; pages++) {
            const state = await this.repository.privateHistoryCheckpoint(episode);
            const page = await this.chatwoot.verifiedMessagePage(mapping, state.before);
            await this.requireCurrentMembership(owner);
            if (
              page.rawCount > 0 &&
              (page.oldestRawId === null ||
                (state.before !== undefined && page.oldestRawId >= state.before))
            )
              throw new Error("nonprogressing_remote_page");
            const target = state.target ?? page.newestRawId ?? state.highWater;
            const complete =
              page.rawCount < 20 ||
              (state.highWater !== undefined &&
                page.oldestRawId !== null &&
                page.oldestRawId <= state.highWater);
            const next = {
              stage: "ready" as const,
              ...(complete
                ? { ...(target !== undefined ? { highWater: target } : {}), initialComplete: true }
                : {
                    before: page.oldestRawId!,
                    ...(state.highWater !== undefined ? { highWater: state.highWater } : {}),
                    ...(target !== undefined ? { target } : {}),
                    initialComplete: state.initialComplete === true,
                  }),
            };
            if (
              !(await this.repository.commitPrivatePage(
                episode,
                mapping,
                page.publicMessages,
                state,
                next,
                complete,
              )) ||
              complete
            )
              break;
          }
        } catch {
          await this.repository.setSync(episode, "error");
        }
      }
    }
    const refreshed = await this.repository.findEpisode(owner, episodeId);
    await this.requireCurrentMembership(owner);
    return this.view(refreshed ?? episode, query);
  }

  async send(
    owner: SupportOwner,
    episodeId: string,
    input: { text: string; idempotencyKey: string },
  ): Promise<SupportMessage> {
    this.requireEnabled();
    const episode = await this.repository.findEpisode(owner, episodeId);
    if (!episode) throw new NotFoundException();
    await this.requireCurrentMembership(owner);
    const sent = await this.delivery.send(episode, input.text, input.idempotencyKey);
    await this.requireCurrentMembership(owner);
    return sent;
  }
}
