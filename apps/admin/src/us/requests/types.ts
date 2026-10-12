import type { z } from "zod";
import type {
  usRequestListQuerySchema,
  usRequestHistoryQuerySchema,
  UsTraceRequestCreateBody,
  UsTraceRequestUpdateBody,
  UsTraceRequestCloseBody,
  UsRequestValidateHttpBody,
  UsRequestWarningAckHttpBody,
  UsRequestPrepareHttpBody,
  UsRequestRetryHttpBody,
  UsRequestListResponse,
  UsRequestDetailResponse,
  UsRequestCommandResponse,
  UsRequestValidationHttpResponse,
  UsRequestPrepareResponse,
  UsRequestRunListResponse,
  UsRequestRunDetail,
  UsRequestAttemptListResponse,
  UsRequestRetryResponse,
} from "@markiro/platform-contracts";

export type UsRequestListInput = z.input<typeof usRequestListQuerySchema>;
export type UsRequestHistoryInput = z.input<typeof usRequestHistoryQuerySchema>;
export type UsRequestArtifact = UsRequestRunDetail["artifacts"][number];
export type VerifiedUsRequestDownload = { bytes: Uint8Array; filename: string; sha256: string };

export interface UsRequestsClient {
  download(
    runId: string,
    descriptor: UsRequestArtifact,
    signal?: AbortSignal,
  ): Promise<VerifiedUsRequestDownload>;
  list(query?: UsRequestListInput, signal?: AbortSignal): Promise<UsRequestListResponse>;
  get(requestId: string, signal?: AbortSignal): Promise<UsRequestDetailResponse>;
  create(body: UsTraceRequestCreateBody, signal?: AbortSignal): Promise<UsRequestCommandResponse>;
  update(
    requestId: string,
    body: UsTraceRequestUpdateBody,
    signal?: AbortSignal,
  ): Promise<UsRequestCommandResponse>;
  close(
    requestId: string,
    body: UsTraceRequestCloseBody,
    signal?: AbortSignal,
  ): Promise<UsRequestCommandResponse>;
  validate(
    requestId: string,
    body: UsRequestValidateHttpBody,
    signal?: AbortSignal,
  ): Promise<UsRequestValidationHttpResponse>;
  acknowledgeWarnings(
    requestId: string,
    body: UsRequestWarningAckHttpBody,
    signal?: AbortSignal,
  ): Promise<UsRequestCommandResponse>;
  prepare(
    requestId: string,
    body: UsRequestPrepareHttpBody,
    signal?: AbortSignal,
  ): Promise<UsRequestPrepareResponse>;
  listRuns(
    requestId: string,
    query?: UsRequestHistoryInput,
    signal?: AbortSignal,
  ): Promise<UsRequestRunListResponse>;
  getRun(runId: string, signal?: AbortSignal): Promise<UsRequestRunDetail>;
  listAttempts(
    runId: string,
    query?: UsRequestHistoryInput,
    signal?: AbortSignal,
  ): Promise<UsRequestAttemptListResponse>;
  retry(
    runId: string,
    body: UsRequestRetryHttpBody,
    signal?: AbortSignal,
  ): Promise<UsRequestRetryResponse>;
}
