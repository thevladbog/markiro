import { APIError } from "better-auth/api";

/**
 * The API's legacy node10 resolution cannot follow better-call/error's export
 * types. Validate the real Error instance instead of casting or relaxing lint.
 */
export function usAuthError(
  status: "FORBIDDEN" | "CONFLICT" | "BAD_REQUEST" | "TOO_MANY_REQUESTS",
  message: string,
): Error {
  const error: unknown = new APIError(status, { message });
  if (!(error instanceof Error)) throw new Error("Invalid auth error instance");
  return error;
}

export function usAuthErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("body" in error)) return;
  const body: unknown = error.body;
  if (body && typeof body === "object" && "code" in body && typeof body.code === "string")
    return body.code;
}
