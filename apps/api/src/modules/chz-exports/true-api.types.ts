export interface TrueApiClientDependencies {
  fetch: typeof fetch;
  scheduleAbort: (controller: AbortController, timeoutMs: number) => () => void;
}

export const productionTrueApiClientDependencies: TrueApiClientDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  scheduleAbort: (controller, timeoutMs) => {
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return () => clearTimeout(timeout);
  },
};

export interface TrueApiAuth {
  baseUrl: string;
  token: string;
}

/**
 * Four outcomes rather than exceptions, following the DaData client: the job
 * layer owns retry policy, and it needs to tell "ЧЗ said no" (terminal) from
 * "ЧЗ was unreachable" (retryable) without unwrapping error subclasses.
 */
export type TrueApiResult<T> =
  | { status: "ok"; value: T }
  | { status: "unauthorized" }
  | {
      status: "rejected";
      code: string;
      message: string;
      /** Present when the refusal came from ЧЗ rather than local response validation. */
      source?: "http" | "element";
    }
  | { status: "unavailable" };

export interface CreateDispenserTaskInput {
  participantInn: string;
  productGroupCode: number;
  chzStatus: string;
  gtins: string[];
}

export interface DispenserTaskSummary {
  taskId: string;
  status: string;
  createdAt: string | null;
}

export interface DispenserResult {
  taskId: string;
  resultId: string | null;
  status: string;
  errorMessage?: string | null;
  archiveSize?: number | null;
  available?: string | null;
  fileDeleteDate?: string | null;
}

export interface CisInfo {
  cis: string;
  status: string;
  statusEx: string | null;
  ownerInn: string | null;
  withdrawReason: string | null;
}

export interface CisInfoError {
  cis: string | null;
  code: string;
  message: string;
}

export interface CisesInfoBatch {
  values: CisInfo[];
  errors: CisInfoError[];
}
