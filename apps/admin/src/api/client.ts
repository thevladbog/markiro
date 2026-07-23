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

const API_BASE = "/api";

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    // The admin app is always served from the same origin the Vite proxy
    // listens on, so "same-origin" (fetch's own default) already sends the
    // Better Auth session cookie -- credentials are set explicitly here
    // anyway so this wrapper's behavior doesn't depend on that default.
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorMessage(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "message" in body) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === "string") return message;
      if (Array.isArray(message) && message.every((m) => typeof m === "string")) {
        return message.join(", ");
      }
      // ZodValidationPipe (see ../../../api/src/zod.pipe.ts) reports 400s as
      // an array of `{ path, message }` issues rather than plain strings --
      // join their `message` fields so a validation error still surfaces as
      // readable text instead of falling through to the generic status text.
      if (
        Array.isArray(message) &&
        message.every((m) => m && typeof m === "object" && "message" in m)
      ) {
        const issues = message
          .map((m) => (m as { message?: unknown }).message)
          .filter((m): m is string => typeof m === "string");
        if (issues.length > 0) return issues.join(", ");
      }
    }
  } catch {
    // response body wasn't JSON (or was empty) -- fall through
  }
  return response.statusText || `HTTP ${response.status}`;
}
