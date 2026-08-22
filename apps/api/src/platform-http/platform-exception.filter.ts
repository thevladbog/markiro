import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { BaseExceptionFilter, HttpAdapterHost } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import type { Request } from "express";

import {
  currentPlatformRequestId,
  isPlatformRequestPath,
} from "./platform-request-context.middleware";
import { parsePlatformError, safePlatformMachineCode } from "./platform-response";

@Catch()
export class PlatformExceptionFilter extends BaseExceptionFilter implements ExceptionFilter {
  private readonly platformLogger = new Logger(PlatformExceptionFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {
    super(adapterHost.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    if (!isPlatformRequestPath(request.path)) {
      super.catch(exception, host);
      return;
    }

    const response = host.switchToHttp().getResponse<unknown>();
    const adapter = this.adapterHost.httpAdapter;
    const requestId = currentPlatformRequestId(request) ?? randomUUID();
    const status = platformStatus(exception);
    const code = platformCode(exception, status);
    const body = parsePlatformError({ code, message: platformMessage(status), requestId });

    if (status >= 500) {
      this.platformLogger.error({
        method: request.method,
        path: request.path,
        exception: exceptionClassName(exception),
        requestId,
      });
    }

    if (!adapter.isHeadersSent(response)) {
      adapter.setHeader(response, "x-request-id", requestId);
      adapter.reply(response, body, status);
      return;
    }
    adapter.end(response);
  }
}

function platformStatus(exception: unknown): number {
  if (!(exception instanceof HttpException)) return 500;
  const status = exception.getStatus();
  return status >= 400 && status < 600 ? status : 500;
}

function platformCode(exception: unknown, status: number): string {
  if (status < 500 && exception instanceof HttpException) {
    const response = exception.getResponse() as unknown;
    if (response && typeof response === "object" && !Array.isArray(response)) {
      const domainCode = safePlatformMachineCode("code" in response ? response.code : null);
      if (domainCode) return domainCode;
    }
  }

  if (status >= 500) return "platform_internal_error";
  switch (status) {
    case 400:
    case 422:
      return "platform_validation_error";
    case 401:
      return "platform_unauthorized";
    case 403:
      return "platform_forbidden";
    case 404:
      return "platform_not_found";
    case 409:
      return "platform_conflict";
    case 429:
      return "platform_rate_limited";
    default:
      return "platform_request_error";
  }
}

function platformMessage(status: number): string {
  if (status >= 500) return "The platform could not complete the request.";
  switch (status) {
    case 400:
    case 422:
      return "The platform request is invalid.";
    case 401:
      return "Platform authentication is required.";
    case 403:
      return "The platform request is not permitted.";
    case 404:
      return "The requested platform resource was not found.";
    case 409:
      return "The platform resource has changed.";
    case 429:
      return "Too many platform requests.";
    default:
      return "The platform request could not be completed.";
  }
}

function exceptionClassName(exception: unknown): string {
  return exception instanceof Error ? exception.constructor.name.slice(0, 128) : typeof exception;
}
