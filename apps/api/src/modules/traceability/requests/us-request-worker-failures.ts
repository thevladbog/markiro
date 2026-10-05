import { HttpException, ServiceUnavailableException } from "@nestjs/common";
import {
  isUsWorkerTransientCode,
  usWorkerFailureCodeSchema,
  type UsWorkerFailure,
} from "./us-request-worker-types";

function own(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Allowlisted boundaries only. Plan reader's opaque cause is never inspected.
 * Classification is NOT proof that a publication COMMIT rolled back; the
 * publication caller must reconcile persisted references before transitioning. */
export function classifyUsWorkerFailure(error: unknown): UsWorkerFailure {
  try {
    const code = own(error instanceof HttpException ? error.getResponse() : error, "code");
    const known = usWorkerFailureCodeSchema.safeParse(code);
    if (known.success) return { code: known.data, retryable: isUsWorkerTransientCode(known.data) };
    if (error instanceof HttpException)
      return { code: "us_request_worker_unknown_failure", retryable: false };
    const databaseCode = typeof code === "string" ? code : own(own(error, "cause"), "code");
    if (databaseCode === "40001" || databaseCode === "40P01")
      return { code: "us_request_worker_database_retryable", retryable: true };
    if (
      typeof databaseCode === "string" &&
      ["08000", "08001", "08003", "08006", "08007", "57P01", "57P02", "57P03"].includes(
        databaseCode,
      )
    )
      return { code: "us_request_worker_database_unavailable", retryable: true };
  } catch {
    /* hostile/opaque inputs grant no retry authority */
  }
  return { code: "us_request_worker_unknown_failure", retryable: false };
}

export function sanitizedUsWorkerError(error: unknown): HttpException {
  const failure = classifyUsWorkerFailure(error);
  if (error instanceof HttpException && failure.code !== "us_request_worker_unknown_failure")
    return new HttpException({ code: failure.code }, error.getStatus());
  return new ServiceUnavailableException({ code: failure.code });
}
