import { ApiRequestError } from "../../api/client.js";

export type ServiceAttempt<T> =
  | { notice: "uncertain"; requestId: string; input: Readonly<T> }
  | { notice: "domain"; requestId: string; input: Readonly<T>; code: string };

export function serviceAttemptNotice(error: unknown): "domain" | "authorization" | "uncertain" {
  if (!(error instanceof ApiRequestError)) return "uncertain";
  if (error.kind === "domain" && error.status === 409) return "domain";
  if (error.kind === "authorization" && (error.status === 401 || error.status === 403))
    return "authorization";
  return "uncertain";
}
