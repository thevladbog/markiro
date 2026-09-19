import type { TrueApiClientDependencies } from "../chz-exports/true-api.types";

export type OmsClientDependencies = TrueApiClientDependencies;

export interface OmsAuth {
  baseUrl: string;
  clientToken: string;
  omsId: string;
}

/**
 * Four outcomes rather than exceptions, mirroring `TrueApiResult`: the layer
 * above owns retry policy and needs to tell "СУЗ said no" from "СУЗ was
 * unreachable" without unwrapping exception subclasses.
 */
export type OmsResult<T> =
  | { status: "ok"; value: T }
  | { status: "unauthorized" }
  | { status: "rejected"; code: string; message: string }
  | { status: "unavailable" };

export interface OmsCreatedOrder {
  orderId: string;
  expectedCompleteMs: number;
}

/**
 * The subset of СУЗ's order-status row the runner acts on or stores. The
 * response also carries `leftInBuffer`, `totalCodes` and `unavailableCodes`;
 * they are deliberately not parsed, because nothing reads them and a parsed
 * field invites a reader to believe it is checked somewhere.
 */
export interface OmsBufferInfo {
  bufferStatus: string;
  availableCodes: number;
  totalPassed: number;
  expiredDate: number | null;
  rejectionReason: string | null;
}

export interface OmsCodesBlock {
  codes: string[];
  blockId: string;
}

export interface OmsBlockSummary {
  blockId: string;
  quantity: number;
}
