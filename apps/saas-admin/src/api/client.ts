import { platformErrorSchema, platformUuidSchema } from "@markiro/platform-contracts";
import type { z } from "zod";

import { recordContractDiagnostic } from "./diagnostics.js";

export const PLATFORM_API_BASE = "/api/platform";

export type ApiErrorKind = "network" | "authorization" | "domain" | "contract";
export type ApiIssuePath = Array<string | number>;

interface ApiRequestErrorDetails {
  kind?: ApiErrorKind;
  endpoint?: string;
  requestId?: string | null;
  releaseSha?: string | null;
  issuePath?: ApiIssuePath | null;
}

export class ApiRequestError extends Error {
  readonly kind: ApiErrorKind;
  readonly endpoint: string;
  readonly status: number | null;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly releaseSha: string | null;
  readonly issuePath: ApiIssuePath | null;

  constructor(
    status: number | null,
    message: string,
    code: string | null = null,
    details: ApiRequestErrorDetails = {},
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.kind = details.kind ?? (status === 401 || status === 403 ? "authorization" : "domain");
    this.endpoint = details.endpoint ?? "";
    this.status = status;
    this.code = code;
    this.requestId = details.requestId ?? null;
    this.releaseSha = details.releaseSha ?? null;
    this.issuePath = details.issuePath ?? null;
  }

  static contract(details: {
    endpoint: string;
    status: number | null;
    issuePath: ApiIssuePath;
    requestId: string | null;
    releaseSha: string | null;
  }): ApiRequestError {
    recordContractDiagnostic(details);
    return new ApiRequestError(details.status, "Platform response contract mismatch", null, {
      ...details,
      kind: "contract",
    });
  }
}

export async function platformApiFetch<S extends z.ZodType>(
  path: string,
  options: RequestInit & { responseSchema: S },
): Promise<z.output<S>> {
  const { responseSchema, ...init } = options;
  const endpoint = safeEndpoint(path);
  let response: Response;
  try {
    response = await fetch(`${PLATFORM_API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch {
    throw new ApiRequestError(null, "Platform network request failed", null, {
      kind: "network",
      endpoint,
    });
  }

  const releaseSha = safeReleaseSha(response.headers.get("x-markiro-release-sha"));
  const rawHeaderRequestId = response.headers.get("x-request-id");
  const headerRequestId = safeRequestId(rawHeaderRequestId);
  if (rawHeaderRequestId !== null && headerRequestId === null) {
    throw ApiRequestError.contract({
      endpoint,
      status: response.status,
      issuePath: ["requestId"],
      requestId: null,
      releaseSha,
    });
  }

  const body =
    response.status === 204
      ? { parsed: true as const, value: undefined }
      : await readJson(response);
  if (!response.ok) {
    if (!body.parsed) {
      throw ApiRequestError.contract({
        endpoint,
        status: response.status,
        issuePath: [],
        requestId: headerRequestId,
        releaseSha,
      });
    }
    const parsedError = platformErrorSchema.safeParse(body.value);
    if (!parsedError.success) {
      throw ApiRequestError.contract({
        endpoint,
        status: response.status,
        issuePath: firstIssuePath(parsedError.error),
        requestId: headerRequestId,
        releaseSha,
      });
    }
    if (headerRequestId !== null && parsedError.data.requestId !== headerRequestId) {
      throw ApiRequestError.contract({
        endpoint,
        status: response.status,
        issuePath: ["requestId"],
        requestId: headerRequestId,
        releaseSha,
      });
    }
    const kind: ApiErrorKind =
      response.status === 401 || response.status === 403 ? "authorization" : "domain";
    throw new ApiRequestError(response.status, "Platform request failed", parsedError.data.code, {
      kind,
      endpoint,
      requestId: parsedError.data.requestId,
      releaseSha,
    });
  }

  if (!body.parsed) {
    throw ApiRequestError.contract({
      endpoint,
      status: response.status,
      issuePath: [],
      requestId: headerRequestId,
      releaseSha,
    });
  }
  const parsed = responseSchema.safeParse(body.value);
  if (!parsed.success) {
    throw ApiRequestError.contract({
      endpoint,
      status: response.status,
      issuePath: firstIssuePath(parsed.error),
      requestId: headerRequestId,
      releaseSha,
    });
  }
  return parsed.data;
}

async function readJson(
  response: Response,
): Promise<{ parsed: true; value: unknown } | { parsed: false }> {
  try {
    return { parsed: true, value: await response.json() };
  } catch {
    return { parsed: false };
  }
}

function firstIssuePath(error: z.ZodError): ApiIssuePath {
  return (error.issues[0]?.path ?? [])
    .slice(0, 16)
    .map((segment) => (typeof segment === "number" ? segment : String(segment).slice(0, 128)));
}

function safeEndpoint(path: string): string {
  const endpoint = path.split(/[?#]/u, 1)[0] ?? "/";
  return endpoint.slice(0, 512);
}

function safeRequestId(value: string | null): string | null {
  const parsed = platformUuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeReleaseSha(value: string | null): string | null {
  if (!value || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) return null;
  return value;
}
