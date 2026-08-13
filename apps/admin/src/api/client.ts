/**
 * Thin fetch wrapper for the Markiro API's data endpoints (counterparties,
 * products, lines, shifts, org profile -- wired up by later plan-03 tasks).
 * Not used by the auth pages themselves, which talk to the API exclusively
 * through the Better Auth client (see ../auth/client.ts).
 *
 * All calls are prefixed with `/api` and go through the Vite dev proxy (see
 * vite.config.ts), which strips that prefix before forwarding to the API
 * server's root-mounted routes.
 */

export const API_BASE = "/api";

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

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isMultipart = typeof FormData !== "undefined" && init.body instanceof FormData;
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    // The admin app is always served from the same origin the Vite proxy
    // listens on, so "same-origin" (fetch's own default) already sends the
    // Better Auth session cookie -- credentials are set explicitly here
    // anyway so this wrapper's behavior doesn't depend on that default.
    credentials: "include",
    ...(isMultipart
      ? init.headers
        ? { headers: init.headers }
        : {}
      : { headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } }),
  });

  if (!response.ok) {
    throw await apiErrorFromResponse(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function apiErrorFromResponse(response: Response): Promise<ApiRequestError> {
  let code: string | null = null;
  let message: string | null = null;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      if ("code" in body && typeof (body as { code?: unknown }).code === "string") {
        code = (body as { code: string }).code;
      }
      const rawMessage = "message" in body ? (body as { message?: unknown }).message : null;
      if (typeof rawMessage === "string" && rawMessage.length > 0) message = rawMessage;
      if (
        Array.isArray(rawMessage) &&
        rawMessage.length > 0 &&
        rawMessage.every((item) => typeof item === "string")
      ) {
        message = rawMessage.join(", ");
      }
      // ZodValidationPipe (see ../../../api/src/zod.pipe.ts) reports 400s as
      // an array of `{ path, message }` issues rather than plain strings --
      // join their `message` fields so a validation error still surfaces as
      // readable text instead of falling through to the generic status text.
      if (
        Array.isArray(rawMessage) &&
        rawMessage.every((item) => item && typeof item === "object" && "message" in item)
      ) {
        const issues = rawMessage
          .map((m) => (m as { message?: unknown }).message)
          .filter((m): m is string => typeof m === "string");
        if (issues.length > 0) message = issues.join(", ");
      }
    }
  } catch {
    // response body wasn't JSON (or was empty) -- fall through
  }
  return new ApiRequestError(
    response.status,
    message ?? (response.statusText || `HTTP ${response.status}`),
    code,
  );
}
