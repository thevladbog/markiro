import { Injectable } from "@nestjs/common";
import { captchaInvalidError, captchaUnavailableError } from "./demo-request.errors";

const SMARTCAPTCHA_VALIDATE_URL = "https://smartcaptcha.cloud.yandex.ru/validate";
const SMARTCAPTCHA_TIMEOUT_MS = 1_500;

interface DemoRequestCaptchaOptions {
  serverKey: string;
  landingOrigin: string;
  fetcher?: typeof fetch;
}

interface SmartCaptchaResponse {
  status: string;
  host?: string;
}

function isSmartCaptchaResponse(value: unknown): value is SmartCaptchaResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { status?: unknown; host?: unknown };
  return (
    typeof candidate.status === "string" &&
    (candidate.host === undefined || typeof candidate.host === "string")
  );
}

@Injectable()
export class DemoRequestCaptchaService {
  readonly #serverKey: string;
  readonly #expectedHost: string;
  readonly #fetcher: typeof fetch;

  constructor(options: DemoRequestCaptchaOptions) {
    this.#serverKey = options.serverKey;
    this.#expectedHost = new URL(options.landingOrigin).host;
    this.#fetcher = options.fetcher ?? fetch;
  }

  async assertHuman(token: string, source: string): Promise<void> {
    const body = new URLSearchParams({ secret: this.#serverKey, token, ip: source });
    let response: Response;
    try {
      response = await this.#fetcher(SMARTCAPTCHA_VALIDATE_URL, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(SMARTCAPTCHA_TIMEOUT_MS),
      });
    } catch {
      throw captchaUnavailableError();
    }

    if (!response.ok) throw captchaUnavailableError();

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw captchaUnavailableError();
    }

    if (!isSmartCaptchaResponse(payload)) throw captchaUnavailableError();
    if (payload.status !== "ok" || payload.host !== this.#expectedHost) {
      throw captchaInvalidError();
    }
  }
}
