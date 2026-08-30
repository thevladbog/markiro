import { Injectable } from "@nestjs/common";

import {
  productionTrueApiClientDependencies,
  type CisInfo,
  type CreateDispenserTaskInput,
  type DispenserResult,
  type DispenserTaskSummary,
  type TrueApiAuth,
  type TrueApiClientDependencies,
  type TrueApiResult,
} from "./true-api.types";

// Re-exported because the test file (per the brief) imports this type from
// the client module rather than from true-api.types directly.
export type { TrueApiClientDependencies } from "./true-api.types";

const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * `packageType` is required by `FILTERED_CIS_REPORT` and selects the packaging
 * level the report covers. The cabinet export the operators use today is the
 * unit-level one, which is what an inventory counts.
 *
 * KNOWN UNKNOWN: the exact enum spelling is not verifiable from here. It is
 * settled against the sandbox by the runbook step this plan's Task 9 adds; if
 * the sandbox rejects it, only this constant changes.
 */
const PACKAGE_TYPE = "UNIT";

/** True API's documented ceiling for one `cises/info` call. */
export const CISES_INFO_BATCH_LIMIT = 1000;

@Injectable()
export class TrueApiClient {
  constructor(
    private readonly dependencies: TrueApiClientDependencies = productionTrueApiClientDependencies,
  ) {}

  async createDispenserTask(
    auth: TrueApiAuth,
    input: CreateDispenserTaskInput,
  ): Promise<TrueApiResult<{ taskId: string }>> {
    // `params` is a STRING-encoded object, not a nested one. This is the
    // dispenser's contract, and getting it wrong is silent: ЧЗ accepts the task
    // and returns an unfiltered report.
    const params = JSON.stringify({
      participantInn: input.participantInn,
      packageType: PACKAGE_TYPE,
      status: input.chzStatus,
      ...(input.gtins.length > 0 ? { includeGtin: input.gtins } : {}),
    });
    return this.request(
      auth,
      "/dispenser/tasks",
      REQUEST_TIMEOUT_MS,
      {
        method: "POST",
        body: JSON.stringify({
          reportId: "FILTERED_CIS_REPORT",
          productGroupCode: input.productGroupCode,
          periodicity: "SINGLE",
          params,
        }),
      },
      async (response) => {
        const payload = (await response.json()) as { taskId?: unknown; id?: unknown };
        const taskId = payload.taskId ?? payload.id;
        return typeof taskId === "string" && taskId.length > 0 ? { taskId } : null;
      },
    );
  }

  async listDispenserTasks(
    auth: TrueApiAuth,
    productGroupCode: number,
  ): Promise<TrueApiResult<DispenserTaskSummary[]>> {
    const query = new URLSearchParams({ productGroupCode: String(productGroupCode) });
    return this.request(
      auth,
      `/dispenser/tasks?${query.toString()}`,
      REQUEST_TIMEOUT_MS,
      {},
      async (response) => {
        const payload: unknown = await response.json();
        const rows = Array.isArray(payload) ? payload : [];
        return rows.map((row) => {
          const record = row as Record<string, unknown>;
          return {
            taskId: typeof record.taskId === "string" ? record.taskId : stringOrEmpty(record.id),
            status: stringOrEmpty(record.status),
            createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
          };
        });
      },
    );
  }

  async listDispenserResults(
    auth: TrueApiAuth,
    taskIds: string[],
  ): Promise<TrueApiResult<DispenserResult[]>> {
    const query = new URLSearchParams();
    for (const taskId of taskIds) query.append("task_ids", taskId);
    return this.request(
      auth,
      `/dispenser/results?${query.toString()}`,
      REQUEST_TIMEOUT_MS,
      {},
      async (response) => {
        const payload: unknown = await response.json();
        const rows = Array.isArray(payload) ? payload : [];
        return rows.map((row) => {
          const record = row as Record<string, unknown>;
          return {
            taskId: stringOrEmpty(record.taskId),
            resultId: typeof record.resultId === "string" ? record.resultId : null,
            status: stringOrEmpty(record.status),
          };
        });
      },
    );
  }

  async downloadDispenserResult(
    auth: TrueApiAuth,
    resultId: string,
  ): Promise<TrueApiResult<Uint8Array>> {
    return this.request(
      auth,
      `/dispenser/results/${encodeURIComponent(resultId)}/file`,
      DOWNLOAD_TIMEOUT_MS,
      {},
      async (response) => new Uint8Array(await response.arrayBuffer()),
    );
  }

  async cisesInfo(
    auth: TrueApiAuth,
    productGroupCode: number,
    cises: string[],
  ): Promise<TrueApiResult<CisInfo[]>> {
    // A RangeError rather than a silent slice: the caller batches, and a
    // truncated request would look like ЧЗ having no opinion about the codes
    // that were dropped.
    if (cises.length > CISES_INFO_BATCH_LIMIT) {
      throw new RangeError(`cises/info accepts at most ${CISES_INFO_BATCH_LIMIT} codes`);
    }
    const query = new URLSearchParams({ pg: String(productGroupCode) });
    return this.request(
      auth,
      `/cises/info?${query.toString()}`,
      REQUEST_TIMEOUT_MS,
      { method: "POST", body: JSON.stringify(cises) },
      async (response) => {
        const payload: unknown = await response.json();
        // A non-array response is a parse failure. Treating it as an empty
        // answer would mark every code in the batch unknown, potentially
        // backing off a whole product group on a single malformed response.
        if (!Array.isArray(payload)) {
          return null;
        }
        return payload.flatMap((row) => {
          // A `null`/`undefined`/non-object row cannot carry a `cis` at all --
          // reading `.cis` off it would throw, and `request()` turns any
          // throw from `parse` into `unavailable` for the WHOLE batch, losing
          // the answers for every other code in it over one malformed row.
          if (row === null || typeof row !== "object") return [];
          const record = row as Record<string, unknown>;
          const cis = typeof record.cis === "string" ? record.cis : "";
          // A row we cannot attribute to a code we asked about is worse than
          // absent: the caller matches on `cis`, and an empty string would
          // match nothing while looking like an answer.
          if (cis.length === 0) return [];
          // Same reasoning for `status`: an absent/non-string status is not
          // ЧЗ answering "" -- it is ЧЗ not answering. `stringOrEmpty` would
          // turn it into a persisted `status: ""`, which `intervalFor` reads
          // as freshly in-circulation and the refresh service writes down as
          // though ЧЗ had responded. Dropping the row instead leaves it
          // exactly where the caller's "unknown" handling already expects an
          // absent answer to be.
          const status =
            typeof record.status === "string" && record.status.length > 0 ? record.status : "";
          if (status.length === 0) return [];
          return [
            {
              cis,
              status,
              statusEx: typeof record.statusEx === "string" ? record.statusEx : null,
              ownerInn: typeof record.ownerInn === "string" ? record.ownerInn : null,
              withdrawReason:
                typeof record.withdrawReason === "string" ? record.withdrawReason : null,
            },
          ];
        });
      },
    );
  }

  private async request<T>(
    auth: TrueApiAuth,
    path: string,
    timeoutMs: number,
    init: RequestInit,
    parse: (response: Response) => Promise<T | null>,
  ): Promise<TrueApiResult<T>> {
    const controller = new AbortController();
    const cancelAbort = this.dependencies.scheduleAbort(controller, timeoutMs);
    try {
      const response = await this.dependencies.fetch(`${auth.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${auth.token}`,
        },
        signal: controller.signal,
      });
      // 401 alone means the bearer is bad: that is the token path, and the
      // runner retries once a fresh one is available. 403 is deliberately
      // NOT folded in here even though it is also an auth-shaped status: True
      // API answers 403 for "no active contract for the product group",
      // which no token refresh will ever fix. Treating it as `unauthorized`
      // would send a terminal, operator-actionable refusal down the
      // token-retry path, discarding ЧЗ's own message in the process. It
      // falls through to the generic 4xx branch below instead, which is
      // `rejected` and carries the message verbatim.
      if (response.status === 401) return { status: "unauthorized" };
      // 429 is a rate limit signal, not a refusal: the caller retries with backoff
      // (classed as transient alongside network errors and 5xx per the spec).
      if (response.status === 429) return { status: "unavailable" };
      if (response.status >= 400 && response.status < 500) {
        return {
          status: "rejected",
          code: String(response.status),
          message: await this.rejectionMessage(response),
        };
      }
      if (!response.ok) return { status: "unavailable" };
      const value = await parse(response);
      return value === null ? { status: "unavailable" } : { status: "ok", value };
    } catch {
      return { status: "unavailable" };
    } finally {
      cancelAbort();
    }
  }

  private async rejectionMessage(response: Response): Promise<string> {
    try {
      const payload = (await response.json()) as Record<string, unknown>;
      const message = payload.error_message ?? payload.errorMessage ?? payload.message;
      return typeof message === "string" && message.length > 0 ? message.slice(0, 500) : "";
    } catch {
      return "";
    }
  }
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
