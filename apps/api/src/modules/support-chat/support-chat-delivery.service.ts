import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { SupportMessage } from "@markiro/platform-contracts";
import { ChatwootClient } from "./chatwoot.client";
import { SupportChatRepository, type EpisodeRow, type MessageRow } from "./support-chat.repository";

export function publicSupportMessage(row: MessageRow): SupportMessage {
  return {
    id: row.id,
    direction: row.direction,
    text: row.text,
    occurredAt: row.occurredAt.toISOString(),
    delivery: row.delivery,
  };
}

@Injectable()
export class SupportChatDeliveryService {
  constructor(
    private readonly repository: SupportChatRepository,
    private readonly chatwoot: ChatwootClient,
  ) {}

  async send(episode: EpisodeRow, text: string, idempotencyKey: string): Promise<SupportMessage> {
    const intent = await this.repository.messageIntent(episode, text, idempotencyKey);
    const current = await this.repository.expireStaleSend(intent.row);
    if (current.delivery !== "pending") return publicSupportMessage(current);
    let mapping;
    try {
      mapping = await this.chatwoot.ensureConversation(episode.id);
    } catch {
      return publicSupportMessage(intent.row);
    }
    if (!mapping) return publicSupportMessage(intent.row);
    const attemptToken = randomUUID();
    if (!(await this.repository.claimSend(intent.row, attemptToken)))
      return publicSupportMessage(intent.row);
    try {
      const remote = await this.chatwoot.sendMessage(mapping, { id: intent.row.id, text });
      return publicSupportMessage(
        await this.repository.markSent(intent.row, mapping, remote, attemptToken),
      );
    } catch {
      // A connection loss can happen after Chatwoot saved the message. The
      // durable local intent and failed job make this visible for operator
      // reconciliation. Never repeat this POST automatically.
      return publicSupportMessage(await this.repository.markUncertain(intent.row, attemptToken));
    }
  }
}
