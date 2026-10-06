import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Env } from "../../env";
import {
  parsePublicMessageList,
  parsePublicMessagePage,
  type ChatwootMapping,
  type PublicChatwootMessage,
} from "./chatwoot-message.schema";
import { SupportChatRepository } from "./support-chat.repository";

export const CHATWOOT_CONFIG = Symbol("CHATWOOT_CONFIG");
export type ChatwootConfig = {
  baseUrl: string;
  accountId: number;
  inboxId: number;
  apiToken: string;
};

export function chatwootConfigFromEnv(env: Env): ChatwootConfig | null {
  if (!env.SUPPORT_CHAT_ENABLED) return null;
  const {
    SUPPORT_CHATWOOT_BASE_URL: baseUrl,
    SUPPORT_CHATWOOT_ACCOUNT_ID: accountId,
    SUPPORT_CHATWOOT_INBOX_ID: inboxId,
    SUPPORT_CHATWOOT_API_TOKEN: apiToken,
  } = env;
  if (!baseUrl || !accountId || !inboxId || !apiToken) {
    throw new Error("Incomplete support chat configuration");
  }
  return {
    baseUrl,
    accountId,
    inboxId,
    apiToken,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Invalid Chatwoot identifier");
  }
  return value;
}

@Injectable()
export class ChatwootClient {
  constructor(
    @Inject(CHATWOOT_CONFIG) private readonly config: ChatwootConfig,
    private readonly repository: SupportChatRepository,
  ) {}

  contactIdentifier(tenantId: string, userId: string): string {
    return `markiro-${createHash("sha256")
      .update(JSON.stringify([tenantId, userId]))
      .digest("hex")}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = new URL(path, `${this.config.baseUrl.replace(/\/$/, "")}/`);
    if (url.origin !== new URL(this.config.baseUrl).origin)
      throw new Error("Untrusted Chatwoot URL");
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        api_access_token: this.config.apiToken,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`Chatwoot HTTP ${response.status}`);
    return response.json();
  }

  private contactInbox(value: unknown): { contactId: number; sourceId: string } {
    const object = record(value);
    const contact = record(object?.contact) ?? object;
    const contactId = positiveId(contact?.id);
    const inboxes: unknown[] = Array.isArray(contact?.contact_inboxes)
      ? contact.contact_inboxes
      : [];
    const explicit = object?.contact_inbox;
    const candidates: unknown[] = [explicit, ...inboxes];
    const candidate = candidates.map(record).find((item) => {
      const inbox = record(item?.inbox);
      return inbox?.id === this.config.inboxId || item?.inbox_id === this.config.inboxId;
    });
    if (!candidate || typeof candidate.source_id !== "string" || !candidate.source_id) {
      throw new Error("Chatwoot contact has no expected inbox source");
    }
    return { contactId, sourceId: candidate.source_id };
  }

  async findContact(identifier: string): Promise<{ contactId: number; sourceId: string } | null> {
    const encoded = encodeURIComponent(identifier);
    const response = record(
      await this.request(`api/v1/accounts/${this.config.accountId}/contacts/search?q=${encoded}`),
    );
    const payload = response?.payload;
    if (!Array.isArray(payload)) throw new Error("Invalid Chatwoot contact search");
    const matches = payload.filter((item) => record(item)?.identifier === identifier);
    if (matches.length > 1) throw new Error("Ambiguous Chatwoot contact identity");
    return matches.length === 1 ? this.contactInbox(matches[0]) : null;
  }

  async createContact(identifier: string): Promise<{ contactId: number; sourceId: string }> {
    const result = record(
      await this.request(`api/v1/accounts/${this.config.accountId}/contacts`, {
        method: "POST",
        body: JSON.stringify({ identifier, inbox_id: this.config.inboxId }),
      }),
    );
    if (!result?.payload) throw new Error("Invalid Chatwoot contact response");
    const contact = record(result.payload);
    if (record(contact?.contact)?.identifier !== identifier) {
      throw new Error("Chatwoot contact identity mismatch");
    }
    return this.contactInbox(result.payload);
  }

  async createConversation(
    contactId: number,
    sourceId: string,
    episodeId: string,
  ): Promise<ChatwootMapping> {
    const result = record(
      await this.request(`api/v1/accounts/${this.config.accountId}/conversations`, {
        method: "POST",
        body: JSON.stringify({
          contact_id: contactId,
          inbox_id: this.config.inboxId,
          source_id: sourceId,
          custom_attributes: { markiro_support_episode_id: episodeId },
        }),
      }),
    );
    if (result?.account_id !== this.config.accountId || result.inbox_id !== this.config.inboxId) {
      throw new Error("Chatwoot conversation scope mismatch");
    }
    const sender = record(record(result.meta)?.sender);
    if (sender?.id !== contactId) throw new Error("Chatwoot conversation contact mismatch");
    return {
      accountId: this.config.accountId,
      inboxId: this.config.inboxId,
      contactId,
      conversationId: positiveId(result.id),
    };
  }

  async ensureConversation(episodeId: string): Promise<ChatwootMapping | null> {
    const found = await this.repository.episodeById(episodeId);
    if (!found) throw new Error("Support episode unavailable");
    const { episode, owner } = found;
    await this.repository.ensureProvisioningJob(episode);
    if (
      episode.remoteConversationId &&
      episode.remoteAccountId &&
      episode.remoteInboxId &&
      owner.remoteContactId
    ) {
      const mapping = {
        accountId: episode.remoteAccountId,
        inboxId: episode.remoteInboxId,
        contactId: positiveId(Number(owner.remoteContactId)),
        conversationId: episode.remoteConversationId,
      };
      await this.verifyConversation(mapping);
      await this.repository.setProvisioningCheckpoint(episode, "ready");
      return mapping;
    }
    const identifier = this.contactIdentifier(owner.tenantId, owner.userId);
    let contactId = owner.remoteContactId ? positiveId(Number(owner.remoteContactId)) : null;
    let sourceId = owner.remoteContactSourceId;
    if (!contactId || !sourceId) {
      const existing = await this.findContact(identifier);
      if (existing) {
        contactId = existing.contactId;
        sourceId = existing.sourceId;
        await this.repository.setContact(owner, contactId, sourceId);
      } else {
        const checkpoint = await this.repository.provisioningCheckpoint(episode);
        if (checkpoint === "contact_post_started") return null;
        if (
          !(await this.repository.beginProvisioningStage(
            episode,
            checkpoint,
            "contact_post_started",
          ))
        )
          return null;
        // Contact identifier is unique per account. If the response is lost,
        // the next attempt performs exact identifier search and does not POST.
        const created = await this.createContact(identifier);
        contactId = created.contactId;
        sourceId = created.sourceId;
        await this.repository.setContact(owner, contactId, sourceId);
      }
    }
    const checkpoint = await this.repository.provisioningCheckpoint(episode);
    if (checkpoint === "conversation_post_started") return null;
    if (
      !(await this.repository.beginProvisioningStage(
        episode,
        checkpoint,
        "conversation_post_started",
      ))
    )
      return null;
    const mapping = await this.createConversation(contactId, sourceId, episode.id);
    await this.repository.setConversation(episode, mapping);
    await this.repository.setProvisioningCheckpoint(episode, "ready");
    return mapping;
  }

  async listMessages(
    mapping: ChatwootMapping,
    page?: { before?: number; after?: number },
  ): Promise<PublicChatwootMessage[]> {
    const query = new URLSearchParams();
    if (page?.before) query.set("before", String(page.before));
    if (page?.after) query.set("after", String(page.after));
    const suffix = query.size ? `?${query}` : "";
    const response = await this.request(
      `api/v1/accounts/${mapping.accountId}/conversations/${mapping.conversationId}/messages${suffix}`,
    );
    return parsePublicMessageList(response, mapping);
  }

  async verifiedMessagePage(mapping: ChatwootMapping, before?: number) {
    await this.verifyConversation(mapping);
    const suffix = before === undefined ? "" : `?before=${before}`;
    const response = await this.request(
      `api/v1/accounts/${mapping.accountId}/conversations/${mapping.conversationId}/messages${suffix}`,
    );
    return parsePublicMessagePage(response, mapping);
  }

  async verifyConversation(mapping: ChatwootMapping): Promise<void> {
    const conversation = record(
      await this.request(
        `api/v1/accounts/${mapping.accountId}/conversations/${mapping.conversationId}`,
      ),
    );
    if (
      conversation?.id !== mapping.conversationId ||
      conversation.account_id !== mapping.accountId ||
      conversation.inbox_id !== mapping.inboxId ||
      record(record(conversation.meta)?.sender)?.id !== mapping.contactId
    ) {
      throw new Error("Chatwoot conversation scope mismatch");
    }
  }

  async sendMessage(
    mapping: ChatwootMapping,
    intent: { id: string; text: string },
  ): Promise<PublicChatwootMessage> {
    const response = await this.request(
      `api/v1/accounts/${mapping.accountId}/conversations/${mapping.conversationId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          content: intent.text,
          message_type: "incoming",
          private: false,
          source_id: intent.id,
          content_attributes: { markiro_support_message_id: intent.id },
        }),
      },
    );
    const parsed = parsePublicMessageList({ payload: [response] }, mapping)[0];
    if (
      !parsed ||
      parsed.direction !== "customer" ||
      parsed.sourceId !== intent.id ||
      parsed.text !== intent.text
    )
      throw new Error("Invalid Chatwoot send response");
    return parsed;
  }
}
