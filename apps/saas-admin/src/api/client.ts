export const PLATFORM_API_BASE = "/api/platform";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

interface PlatformResponseSchema<T> {
  parse(value: unknown): T;
}

export function platformApiFetch<T>(path: string, init?: RequestInit): Promise<T>;
export function platformApiFetch<T>(
  path: string,
  responseSchema: PlatformResponseSchema<T>,
  init?: RequestInit,
): Promise<T>;
export async function platformApiFetch<T>(
  path: string,
  responseSchemaOrInit: PlatformResponseSchema<T> | RequestInit = {},
  schemaInit: RequestInit = {},
): Promise<T> {
  let responseSchema: PlatformResponseSchema<T> | undefined;
  let init: RequestInit;
  if (isPlatformResponseSchema(responseSchemaOrInit)) {
    responseSchema = responseSchemaOrInit;
    init = schemaInit;
  } else {
    init = responseSchemaOrInit;
  }
  const response = await fetch(`${PLATFORM_API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) throw await apiErrorFromResponse(response);
  const value: unknown = response.status === 204 ? undefined : await response.json();
  return responseSchema ? responseSchema.parse(value) : (value as T);
}

function isPlatformResponseSchema<T>(
  value: PlatformResponseSchema<T> | RequestInit,
): value is PlatformResponseSchema<T> {
  return "parse" in value && typeof value.parse === "function";
}

async function apiErrorFromResponse(response: Response): Promise<ApiRequestError> {
  let code: string | null = null;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const rawCode = "code" in body ? body.code : null;
      const rawMessage = "message" in body ? body.message : null;
      if (typeof rawCode === "string") code = rawCode;
      if (typeof rawMessage === "string" && rawMessage.length > 0) message = rawMessage;
    }
  } catch {
    // Empty and non-JSON error bodies use the HTTP status text.
  }
  return new ApiRequestError(response.status, message, code);
}
