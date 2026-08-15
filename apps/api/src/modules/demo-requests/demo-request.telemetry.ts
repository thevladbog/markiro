import { Injectable, Logger } from "@nestjs/common";
import type { Request } from "express";
import type { DemoSourcePath } from "./demo-request-routes";

export type DemoRequestTelemetryLocale = "ru" | "en" | "unknown";
export type DemoRequestTelemetrySourcePath = DemoSourcePath | "unknown";

export type DemoRequestTelemetryEvent =
  | {
      event: "landing_demo_request_final";
      status: 202 | 400 | 404 | 429 | 503;
      code:
        | "accepted"
        | "invalid_request"
        | "captcha_invalid"
        | "captcha_unavailable"
        | "rate_limited"
        | "submission_disabled"
        | "submission_unavailable";
      locale: DemoRequestTelemetryLocale;
      sourcePath: DemoRequestTelemetrySourcePath;
    }
  | {
      event: "landing_demo_request_rate_limited";
      scope: "source" | "global";
    }
  | {
      event: "landing_demo_request_captcha_rejected";
      classification: "invalid";
      reason: "provider_status" | "host_mismatch";
    }
  | {
      event: "landing_demo_request_captcha_rejected";
      classification: "infrastructure";
      reason: "network" | "http_status" | "malformed_response";
    };

export interface DemoRequestTelemetrySink {
  record(event: DemoRequestTelemetryEvent): void;
}

export const NOOP_DEMO_REQUEST_TELEMETRY: DemoRequestTelemetrySink = {
  record: () => undefined,
};

/** Writes only the allowlisted event union above to the established Nest logger boundary. */
@Injectable()
export class DemoRequestTelemetry implements DemoRequestTelemetrySink {
  readonly #logger = new Logger(DemoRequestTelemetry.name);

  record(event: DemoRequestTelemetryEvent): void {
    this.#logger.log(JSON.stringify(event));
  }
}

/** Telemetry is operational best-effort and must never alter endpoint behavior. */
export function recordDemoRequestTelemetry(
  sink: DemoRequestTelemetrySink,
  event: DemoRequestTelemetryEvent,
): void {
  try {
    sink.record(event);
  } catch {
    // The request contract takes precedence over an unavailable logging sink.
  }
}

export interface DemoRequestTelemetryContext {
  locale: "ru" | "en";
  sourcePath: DemoSourcePath;
}

export const DEMO_REQUEST_TELEMETRY_CONTEXT = Symbol("DEMO_REQUEST_TELEMETRY_CONTEXT");

export interface DemoRequestTelemetryRequest extends Request {
  [DEMO_REQUEST_TELEMETRY_CONTEXT]?: DemoRequestTelemetryContext;
}
