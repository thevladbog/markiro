import { z } from "zod";
import {
  platformUuidSchema,
  usRequestListQuerySchema,
  usRequestHistoryQuerySchema,
  usTraceRequestCreateBodySchema,
  usTraceRequestUpdateBodySchema,
  usTraceRequestCloseBodySchema,
  usRequestValidateHttpBodySchema,
  usRequestWarningAckHttpBodySchema,
  usRequestPrepareHttpBodySchema,
  usRequestRetryHttpBodySchema,
  usRequestListResponseSchema,
  usRequestDetailResponseSchema,
  usRequestCommandResponseSchema,
  usRequestValidationHttpResponseSchema,
  usRequestPrepareResponseSchema,
  usRequestRunListResponseSchema,
  usRequestRunDetailSchema,
  usRequestAttemptListResponseSchema,
  usRequestRetryResponseSchema,
} from "@markiro/platform-contracts";
import { usRequestsResponseErrorCode, type UsRequestsClientErrorCode } from "./error-codes.js";
import { readUsRequestArtifactResponse } from "./artifact-transport.js";
import type { UsRequestsClient } from "./types.js";

const root = "/api/us/traceability";
const requestsPath = `${root}/requests`;
const runsPath = `${root}/export-runs`;
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .pipe(platformUuidSchema);
const jsonMime = (response: Response) =>
  /^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "");

export function createUsRequestsClient(
  send: typeof fetch,
  makeError: (code: UsRequestsClientErrorCode) => Error,
): UsRequestsClient {
  const safeErrors = new WeakSet<Error>();
  function fail(code: UsRequestsClientErrorCode): never {
    const error = makeError(code);
    safeErrors.add(error);
    throw error;
  }
  function checked<S extends z.ZodType>(
    schema: S,
    value: unknown,
    code: "invalid_input" | "invalid_response",
  ): z.output<S> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return fail(code);
    return parsed.data;
  }
  function queryString(
    schema: typeof usRequestListQuerySchema | typeof usRequestHistoryQuerySchema,
    input: unknown,
  ): string {
    const query = checked(schema, input === undefined ? {} : input, "invalid_input");
    const params = new URLSearchParams();
    if ("requestNumber" in query && query.requestNumber !== undefined)
      params.set("requestNumber", query.requestNumber);
    if ("status" in query && query.status !== undefined) params.set("status", query.status);
    params.set("limit", String(query.limit));
    params.set("offset", String(query.offset));
    return `?${params}`;
  }
  async function readJson(response: Response, maximum: number): Promise<unknown> {
    if (!response.body) return fail("invalid_response");
    const length = response.headers.get("content-length");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (length !== null && (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > maximum))
        return fail("invalid_response");
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maximum) return fail("invalid_response");
        chunks.push(next.value);
      }
      if (length !== null && Number(length) !== size) return fail("invalid_response");
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return fail("invalid_response");
    }
  }
  async function json<T>(
    path: string,
    method: string,
    body: unknown,
    maxBytes: number,
    decode: (response: Response) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > maxBytes)
      return fail("invalid_input");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await send(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        ...(serialized === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: serialized }),
      });
      const result = await decode(response);
      if (controller.signal.aborted) return fail("unavailable");
      return result;
    } catch (error) {
      if (error instanceof Error && safeErrors.has(error)) throw error;
      return fail("unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }
  function response<S extends z.ZodType>(
    schema: S,
    status = 200,
    matches: (value: z.output<S>) => boolean = () => true,
  ) {
    return async (value: Response): Promise<z.output<S>> => {
      if (
        value.redirected ||
        (value.status >= 200 && value.status < 400 && value.status !== status)
      )
        return fail("invalid_response");
      if (value.status !== status) {
        if ([401, 403, 429].includes(value.status))
          return fail(usRequestsResponseErrorCode(value.status, undefined));
        let errorBody: unknown;
        try {
          if (jsonMime(value)) errorBody = await readJson(value, 16 * 1024);
        } catch {
          /* raw/oversize/malformed errors remain opaque */
        }
        return fail(usRequestsResponseErrorCode(value.status, errorBody));
      }
      if (!jsonMime(value)) return fail("invalid_response");
      // Snapshot findings are bounded to 16 MiB by contract; allow 1 MiB for
      // surrounding detail/scope evidence without accepting unbounded JSON.
      const decoded = checked(schema, await readJson(value, 17 * 1024 * 1024), "invalid_response");
      if (!matches(decoded)) return fail("invalid_response");
      return decoded;
    };
  }
  const requestId = (id: string) => checked(uuid, id, "invalid_input");
  return {
    async download(id, descriptor, signal) {
      const target = requestId(id);
      const evidence = checked(
        usRequestRunDetailSchema.shape.artifacts.element,
        descriptor,
        "invalid_input",
      );
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      signal?.addEventListener("abort", forwardAbort, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const downloadError = (code: UsRequestsClientErrorCode) => {
        const error = makeError(code);
        safeErrors.add(error);
        return error;
      };
      try {
        if (controller.signal.aborted) return fail("unavailable");
        const value = await send(`${runsPath}/${target}/artifacts/${evidence.kind}`, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        const result = await readUsRequestArtifactResponse(value, evidence, {
          signal: controller.signal,
          makeError: downloadError,
        });
        if (controller.signal.aborted) return fail("unavailable");
        return result;
      } catch (error) {
        if (error instanceof Error && safeErrors.has(error)) throw error;
        return fail("unavailable");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", forwardAbort);
      }
    },
    async list(query, signal) {
      return json(
        requestsPath + queryString(usRequestListQuerySchema, query),
        "GET",
        undefined,
        0,
        response(usRequestListResponseSchema),
        signal,
      );
    },
    async get(id, signal) {
      const target = requestId(id);
      return json(
        `${requestsPath}/${target}`,
        "GET",
        undefined,
        0,
        response(usRequestDetailResponseSchema, 200, (r) => r.id === target),
        signal,
      );
    },
    async create(body, signal) {
      return json(
        requestsPath,
        "POST",
        checked(usTraceRequestCreateBodySchema, body, "invalid_input"),
        256 * 1024,
        response(usRequestCommandResponseSchema, 201),
        signal,
      );
    },
    async update(id, body, signal) {
      const target = requestId(id);
      const input = checked(usTraceRequestUpdateBodySchema, body, "invalid_input");
      return json(
        `${requestsPath}/${target}`,
        "PATCH",
        input,
        256 * 1024,
        response(usRequestCommandResponseSchema, 200, (r) => r.requestId === target),
        signal,
      );
    },
    async close(id, body, signal) {
      const target = requestId(id);
      return json(
        `${requestsPath}/${target}/close`,
        "POST",
        checked(usTraceRequestCloseBodySchema, body, "invalid_input"),
        16 * 1024,
        response(
          usRequestCommandResponseSchema,
          200,
          (r) => r.requestId === target && r.status === "closed",
        ),
        signal,
      );
    },
    async validate(id, body, signal) {
      const target = requestId(id);
      const input = checked(usRequestValidateHttpBodySchema, body, "invalid_input");
      return json(
        `${requestsPath}/${target}/validate`,
        "POST",
        input,
        16 * 1024,
        response(
          usRequestValidationHttpResponseSchema,
          200,
          (r) => r.requestId === target && r.revision === input.expectedRevision,
        ),
        signal,
      );
    },
    async acknowledgeWarnings(id, body, signal) {
      const target = requestId(id);
      const input = checked(usRequestWarningAckHttpBodySchema, body, "invalid_input");
      return json(
        `${requestsPath}/${target}/acknowledge-warnings`,
        "POST",
        input,
        16 * 1024,
        response(
          usRequestCommandResponseSchema,
          200,
          (r) => r.requestId === target && r.revision === input.expectedRevision,
        ),
        signal,
      );
    },
    async prepare(id, body, signal) {
      const target = requestId(id);
      const input = checked(usRequestPrepareHttpBodySchema, body, "invalid_input");
      return json(
        `${requestsPath}/${target}/prepare`,
        "POST",
        input,
        16 * 1024,
        response(
          usRequestPrepareResponseSchema,
          200,
          (r) =>
            r.requestId === target &&
            r.requestRevision === input.expectedRevision &&
            r.mode === input.mode &&
            r.idempotencyKey === input.idempotencyKey &&
            r.scopedContentDigest === input.validationDigest,
        ),
        signal,
      );
    },
    async listRuns(id, query, signal) {
      const target = requestId(id);
      return json(
        `${requestsPath}/${target}/runs${queryString(usRequestHistoryQuerySchema, query)}`,
        "GET",
        undefined,
        0,
        response(usRequestRunListResponseSchema, 200, (r) =>
          r.items.every((item) => item.requestId === target),
        ),
        signal,
      );
    },
    async getRun(id, signal) {
      const target = requestId(id);
      return json(
        `${runsPath}/${target}`,
        "GET",
        undefined,
        0,
        response(usRequestRunDetailSchema, 200, (r) => r.runId === target),
        signal,
      );
    },
    async listAttempts(id, query, signal) {
      const target = requestId(id);
      return json(
        `${runsPath}/${target}/attempts${queryString(usRequestHistoryQuerySchema, query)}`,
        "GET",
        undefined,
        0,
        response(usRequestAttemptListResponseSchema),
        signal,
      );
    },
    async retry(id, body, signal) {
      const target = requestId(id);
      const input = checked(usRequestRetryHttpBodySchema, body, "invalid_input");
      return json(
        `${runsPath}/${target}/retry`,
        "POST",
        input,
        16 * 1024,
        response(
          usRequestRetryResponseSchema,
          200,
          (r) => r.runId === target && r.idempotencyKey === input.idempotencyKey,
        ),
        signal,
      );
    },
  };
}
