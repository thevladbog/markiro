import { Injectable } from "@nestjs/common";
import { captchaInvalidError, captchaUnavailableError } from "./demo-request.errors";
import {
  NOOP_DEMO_REQUEST_TELEMETRY,
  recordDemoRequestTelemetry,
  type DemoRequestTelemetryEvent,
  type DemoRequestTelemetrySink,
} from "./demo-request.telemetry";

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
  readonly #telemetry: DemoRequestTelemetrySink;

  constructor(
    options: DemoRequestCaptchaOptions,
    telemetry: DemoRequestTelemetrySink = NOOP_DEMO_REQUEST_TELEMETRY,
  ) {
    this.#serverKey = options.serverKey;
    this.#expectedHost = new URL(options.landingOrigin).host;
    this.#fetcher = options.fetcher ?? fetch;
    this.#telemetry = telemetry;
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
      this.#rejectUnavailable("network");
    }

    if (response.status !== 200) this.#rejectUnavailable("http_status");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      this.#rejectUnavailable("malformed_response");
    }

    if (!isSmartCaptchaResponse(payload)) this.#rejectUnavailable("malformed_response");
    if (payload.status !== "ok") this.#rejectInvalid("provider_status");
    if (payload.host !== this.#expectedHost) this.#rejectInvalid("host_mismatch");
  }

  #rejectInvalid(
    reason: Extract<DemoRequestTelemetryEvent, { classification: "invalid" }>["reason"],
  ): never {
    recordDemoRequestTelemetry(this.#telemetry, {
      event: "landing_demo_request_captcha_rejected",
      classification: "invalid",
      reason,
    });
    throw captchaInvalidError();
  }

  #rejectUnavailable(
    reason: Extract<DemoRequestTelemetryEvent, { classification: "infrastructure" }>["reason"],
  ): never {
    recordDemoRequestTelemetry(this.#telemetry, {
      event: "landing_demo_request_captcha_rejected",
      classification: "infrastructure",
      reason,
    });
    throw captchaUnavailableError();
  }
}
