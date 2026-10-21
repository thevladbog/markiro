import type { Env } from "../../env";

export const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 10_000;
/** Telegram rejects longer texts; the builders stay below it. */
export const TELEGRAM_MESSAGE_LIMIT = 4_096;

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** `null` keeps Telegram silent: the flag is off (env validation enforces the rest). */
export function telegramConfigFromEnv(env: Env): TelegramConfig | null {
  if (!env.LEAD_TELEGRAM_ENABLED) return null;
  const { LEAD_TELEGRAM_BOT_TOKEN: botToken, LEAD_TELEGRAM_CHAT_ID: chatId } = env;
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

/**
 * A send failure reduced to a machine code. The request URL carries the bot token, so
 * neither the URL nor the underlying error ever leaves this module.
 */
export class TelegramSendError extends Error {
  constructor(
    readonly code: string,
    readonly transient: boolean,
  ) {
    super(`Telegram send failed: ${code}`);
    this.name = "TelegramSendError";
  }
}

export interface TelegramSender {
  sendMessage(text: string): Promise<void>;
}

/** Bot API client shaped like `ChatwootClient`: one origin, a timeout, no redirects. */
export class TelegramClient implements TelegramSender {
  constructor(
    private readonly config: TelegramConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async sendMessage(text: string): Promise<void> {
    const url = new URL(`/bot${this.config.botToken}/sendMessage`, TELEGRAM_API_ORIGIN);
    if (url.origin !== TELEGRAM_API_ORIGIN)
      throw new TelegramSendError("telegram_untrusted_url", false);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text: text.slice(0, TELEGRAM_MESSAGE_LIMIT),
          disable_web_page_preview: true,
        }),
      });
    } catch {
      throw new TelegramSendError("telegram_network", true);
    }
    if (response.status === 429) throw new TelegramSendError("telegram_rate_limited", true);
    if (response.status >= 500) throw new TelegramSendError("telegram_unavailable", true);
    if (!response.ok) throw new TelegramSendError(`telegram_rejected_${response.status}`, false);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TelegramSendError("telegram_malformed_response", true);
    }
    if (!body || typeof body !== "object" || (body as { ok?: unknown }).ok !== true) {
      throw new TelegramSendError("telegram_not_ok", true);
    }
  }
}
