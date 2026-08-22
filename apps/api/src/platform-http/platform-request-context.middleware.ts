import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable, type NestMiddleware } from "@nestjs/common";
import { platformUuidSchema } from "@markiro/platform-contracts";
import type { NextFunction, Request, Response } from "express";

interface PlatformRequestContext {
  requestId: string;
}

const platformRequestStorage = new AsyncLocalStorage<PlatformRequestContext>();
const PLATFORM_REQUEST_ID = Symbol("platformRequestId");

export interface PlatformRequest extends Request {
  [PLATFORM_REQUEST_ID]?: string;
}

@Injectable()
export class PlatformRequestContextMiddleware implements NestMiddleware {
  use(request: PlatformRequest, response: Response, next: NextFunction): void {
    if (!isPlatformRequestPath(request.path)) {
      next();
      return;
    }

    const incoming = request.headers["x-request-id"];
    const parsed = platformUuidSchema.safeParse(typeof incoming === "string" ? incoming : null);
    const requestId = parsed.success ? parsed.data : randomUUID();
    request[PLATFORM_REQUEST_ID] = requestId;
    response.setHeader("x-request-id", requestId);
    platformRequestStorage.run({ requestId }, next);
  }
}

export function currentPlatformRequestId(request?: PlatformRequest): string | null {
  return platformRequestStorage.getStore()?.requestId ?? request?.[PLATFORM_REQUEST_ID] ?? null;
}

export function runWithPlatformRequestContext<T>(requestId: string, callback: () => T): T {
  return platformRequestStorage.run({ requestId }, callback);
}

export function isPlatformRequestPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized === "/platform" || normalized.startsWith("/platform/");
}
