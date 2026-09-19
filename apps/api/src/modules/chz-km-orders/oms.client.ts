import { Injectable } from "@nestjs/common";

import { productionTrueApiClientDependencies } from "../chz-exports/true-api.types";

import type {
  OmsAuth,
  OmsBlockSummary,
  OmsBufferInfo,
  OmsClientDependencies,
  OmsCodesBlock,
  OmsCreatedOrder,
  OmsResult,
} from "./oms.types";

export type { OmsClientDependencies } from "./oms.types";

const REQUEST_TIMEOUT_MS = 15_000;
const CODES_TIMEOUT_MS = 120_000;
/** СУЗ's documented ceiling for one `GET /codes` call. */
export const OMS_CODES_CALL_LIMIT = 150_000;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

@Injectable()
export class OmsClient {
  constructor(
    private readonly dependencies: OmsClientDependencies = productionTrueApiClientDependencies,
  ) {}

  /** `body` is sent byte-for-byte: it is what the detached signature covers. */
  createOrder(
    auth: OmsAuth,
    body: string,
    signatureBase64: string,
  ): Promise<OmsResult<OmsCreatedOrder>> {
    return this.request(
      auth,
      `/order?omsId=${encodeURIComponent(auth.omsId)}`,
      REQUEST_TIMEOUT_MS,
      { method: "POST", body, headers: { "X-Signature": signatureBase64 } },
      async (response) => {
        const payload = (await response.json()) as Record<string, unknown>;
        const orderId = payload.orderId;
        const expected = payload.expectedCompleteTimestamp;
        if (typeof orderId !== "string" || !UUID.test(orderId)) return null;
        return { orderId, expectedCompleteMs: typeof expected === "number" ? expected : 0 };
      },
    );
  }

  getBufferStatus(
    auth: OmsAuth,
    orderId: string,
    gtin14: string,
  ): Promise<OmsResult<OmsBufferInfo>> {
    const query = new URLSearchParams({ omsId: auth.omsId, orderId, gtin: gtin14 });
    return this.request(
      auth,
      `/order/status?${query}`,
      REQUEST_TIMEOUT_MS,
      {},
      async (response) => {
        const payload: unknown = await response.json();
        const row = Array.isArray(payload)
          ? (payload[0] as Record<string, unknown> | undefined)
          : undefined;
        if (!row || typeof row.bufferStatus !== "string") return null;
        return {
          bufferStatus: row.bufferStatus,
          availableCodes: intOr(row.availableCodes, -1),
          totalPassed: intOr(row.totalPassed, -1),
          expiredDate: typeof row.expiredDate === "number" ? row.expiredDate : null,
          rejectionReason:
            typeof row.rejectionReason === "string" && row.rejectionReason.length > 0
              ? row.rejectionReason.slice(0, 500)
              : null,
        };
      },
    );
  }

  async getCodes(
    auth: OmsAuth,
    orderId: string,
    gtin14: string,
    quantity: number,
  ): Promise<OmsResult<OmsCodesBlock>> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > OMS_CODES_CALL_LIMIT) {
      throw new RangeError(`GET /codes accepts 1..${OMS_CODES_CALL_LIMIT} codes`);
    }
    const query = new URLSearchParams({
      omsId: auth.omsId,
      orderId,
      gtin: gtin14,
      quantity: String(quantity),
    });
    return this.request(auth, `/codes?${query}`, CODES_TIMEOUT_MS, {}, parseCodesBlock);
  }

  listBlocks(
    auth: OmsAuth,
    orderId: string,
    gtin14: string,
  ): Promise<OmsResult<OmsBlockSummary[]>> {
    const query = new URLSearchParams({ omsId: auth.omsId, orderId, gtin: gtin14 });
    return this.request(
      auth,
      `/order/codes/blocks?${query}`,
      REQUEST_TIMEOUT_MS,
      {},
      async (response) => {
        const payload = (await response.json()) as Record<string, unknown>;
        if (!Array.isArray(payload.blocks)) return null;
        return payload.blocks.flatMap((block) => {
          const record = block as Record<string, unknown>;
          return typeof record.blockId === "string" && UUID.test(record.blockId)
            ? [{ blockId: record.blockId, quantity: intOr(record.quantity, 0) }]
            : [];
        });
      },
    );
  }

  retryBlock(auth: OmsAuth, blockId: string): Promise<OmsResult<OmsCodesBlock>> {
    const query = new URLSearchParams({ omsId: auth.omsId, blockId });
    return this.request(auth, `/order/codes/retry?${query}`, CODES_TIMEOUT_MS, {}, parseCodesBlock);
  }

  private async request<T>(
    auth: OmsAuth,
    path: string,
    timeoutMs: number,
    init: RequestInit,
    parse: (response: Response) => Promise<T | null>,
  ): Promise<OmsResult<T>> {
    const controller = new AbortController();
    const cancelAbort = this.dependencies.scheduleAbort(controller, timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      if (init.body) headers.set("Content-Type", "application/json");
      headers.set("clientToken", auth.clientToken);
      const response = await this.dependencies.fetch(`${auth.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (response.status === 401) return { status: "unauthorized" };
      if (response.status === 429) return { status: "unavailable" };
      if (response.status >= 400 && response.status < 500) {
        return {
          status: "rejected",
          code: String(response.status),
          message: await rejectionMessage(response),
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
}

async function parseCodesBlock(response: Response): Promise<OmsCodesBlock | null> {
  const payload = (await response.json()) as Record<string, unknown>;
  const codes = payload.codes;
  const blockId = payload.blockId;
  if (!Array.isArray(codes) || typeof blockId !== "string" || !UUID.test(blockId)) return null;
  if (!codes.every((code) => typeof code === "string" && code.length > 0 && code.length <= 1024))
    return null;
  return { codes: codes as string[], blockId };
}

/** СУЗ error bodies: `{fieldErrors:[{fieldName,fieldError}], globalErrors:[…]}` or `{error_message}`; joined, capped, no token echo possible. */
async function rejectionMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as Record<string, unknown>;
    const parts: string[] = [];
    if (Array.isArray(payload.globalErrors))
      parts.push(...payload.globalErrors.filter((e): e is string => typeof e === "string"));
    if (Array.isArray(payload.fieldErrors)) {
      for (const error of payload.fieldErrors) {
        const record = error as Record<string, unknown>;
        if (typeof record.fieldError === "string") {
          const fieldName = typeof record.fieldName === "string" ? record.fieldName : "";
          parts.push(`${fieldName}: ${record.fieldError}`);
        }
      }
    }
    const single = payload.error_message ?? payload.errorMessage ?? payload.message;
    if (typeof single === "string") parts.push(single);
    return parts.join("; ").slice(0, 500);
  } catch {
    return "";
  }
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}
