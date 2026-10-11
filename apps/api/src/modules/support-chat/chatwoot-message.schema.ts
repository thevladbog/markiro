export interface ChatwootMapping {
  accountId: number;
  inboxId: number;
  contactId: number;
  conversationId: number;
}

export interface PublicChatwootMessage {
  remoteId: number;
  direction: "customer" | "operator";
  text: string;
  occurredAt: Date;
  sourceId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Selects only public, text-bearing messages from the already checked conversation. */
export function parsePublicChatwootMessage(
  value: unknown,
  mapping: ChatwootMapping,
): PublicChatwootMessage | null {
  const message = record(value);
  if (!message) return null;
  if (message.account_id !== undefined && message.account_id !== mapping.accountId) {
    throw new Error("Chatwoot message account mismatch");
  }
  if (message.inbox_id !== mapping.inboxId || message.conversation_id !== mapping.conversationId) {
    throw new Error("Chatwoot message scope mismatch");
  }
  if (message.private !== false) return null;
  if (message.message_type !== 0 && message.message_type !== 1) return null;
  if (message.content_type !== "text") return null;
  if (
    !positiveInteger(message.id) ||
    typeof message.content !== "string" ||
    !message.content.length
  ) {
    return null;
  }
  if (typeof message.created_at !== "number" || !Number.isFinite(message.created_at)) return null;
  const occurredAt = new Date(message.created_at * 1000);
  if (Number.isNaN(occurredAt.getTime())) return null;
  return {
    remoteId: message.id,
    direction: message.message_type === 0 ? "customer" : "operator",
    text: message.content,
    occurredAt,
    sourceId: typeof message.source_id === "string" ? message.source_id : null,
  };
}

export function parsePublicMessageList(
  value: unknown,
  mapping: ChatwootMapping,
): PublicChatwootMessage[] {
  const wrapper = record(value);
  if (!wrapper || !Array.isArray(wrapper.payload)) throw new Error("Invalid Chatwoot message list");
  const result: PublicChatwootMessage[] = [];
  for (const item of wrapper.payload) {
    const parsed = parsePublicChatwootMessage(item, mapping);
    if (parsed) result.push(parsed);
  }
  return result;
}

/** The cursor is derived from the fetched page, including private/activity rows. */
export function parsePublicMessagePage(value: unknown, mapping: ChatwootMapping) {
  const wrapper = record(value);
  if (!wrapper || !Array.isArray(wrapper.payload)) throw new Error("Invalid Chatwoot message list");
  const publicMessages: PublicChatwootMessage[] = [];
  let oldestRawId: number | null = null;
  let newestRawId: number | null = null;
  for (const item of wrapper.payload) {
    const raw = record(item);
    if (
      !raw ||
      !positiveInteger(raw.id) ||
      (raw.account_id !== undefined && raw.account_id !== mapping.accountId) ||
      raw.inbox_id !== mapping.inboxId ||
      raw.conversation_id !== mapping.conversationId
    ) {
      throw new Error("Chatwoot message scope mismatch");
    }
    oldestRawId = oldestRawId === null ? raw.id : Math.min(oldestRawId, raw.id);
    newestRawId = newestRawId === null ? raw.id : Math.max(newestRawId, raw.id);
    const publicMessage = parsePublicChatwootMessage(raw, mapping);
    if (publicMessage) publicMessages.push(publicMessage);
  }
  return { publicMessages, oldestRawId, newestRawId, rawCount: wrapper.payload.length };
}
