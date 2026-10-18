import { invoke } from "@tauri-apps/api/core";
import type { z } from "zod";

import {
  credentialSchema,
  errorBodySchema,
  hostResponseSchema,
  type Credential,
} from "./protocol.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Codes the shell rejects `host_request` with (`DeviceError::code` in src-tauri). */
export const TRANSPORT_CODES = [
  "unreachable",
  "certificate_mismatch",
  "invalid_response",
  "invalid_request",
  "not_paired",
  "config_unreadable",
  "timeout",
  "dataset_reset_required",
] as const;
export type TransportCode = (typeof TRANSPORT_CODES)[number];

interface HostErrorInit {
  kind: "transport" | "api";
  code: string;
  message: string;
  status?: number;
  details?: Record<string, unknown>;
}

/**
 * A failed host call: the shell got no usable answer (`transport`), or the
 * host answered with an error body (`api`). Screens choose text by `code`.
 */
export class HostError extends Error {
  readonly kind: "transport" | "api";
  readonly code: string;
  readonly status: number | null;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(init: HostErrorInit) {
    super(init.message);
    this.name = "HostError";
    this.kind = init.kind;
    this.code = init.code;
    this.status = init.status ?? null;
    this.details = init.details ?? {};
  }

  /** The credential an `unauthorized` answer rejected. */
  get credential(): Credential | null {
    if (this.code !== "unauthorized") return null;
    const parsed = credentialSchema.safeParse(this.details.credential);
    return parsed.success ? parsed.data : null;
  }

  /** The request field a `validation_failed` answer names (`org.gln`, `lines.1`). */
  get field(): string | null {
    const field = this.details.field;
    return this.code === "validation_failed" && typeof field === "string" ? field : null;
  }
}

/** The bounds of `timeoutMs`, as the shell checks them (`MIN_TIMEOUT_MS`, `MAX_TIMEOUT_MS`). */
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

export interface HostRequestOptions<T> {
  body?: unknown;
  officeToken?: string;
  /**
   * Limits this request to 100–10 000 ms instead of the shell's 10 s (the scan
   * pipeline's 300 ms code check). When this limit ends the call first —
   * connecting and the TLS handshake count — it fails with the transport code
   * `timeout`; a limit above the shell's own 2 s to connect leaves a host that
   * never connects to that 2 s, which is `unreachable`. A number that is not
   * a whole number of milliseconds in the bounds fails with `invalid_request`
   * before the shell is called (`NaN` and `Infinity` would otherwise reach it
   * as JSON `null`, which means no limit).
   */
  timeoutMs?: number;
  /** Parses a 2xx body; a 204 answer parses as `null`. */
  schema: z.ZodType<T>;
}

export interface HostClient {
  request<T>(method: HttpMethod, path: string, options: HostRequestOptions<T>): Promise<T>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** Calls the host through the shell's `host_request`: the webview never performs HTTP. */
export function createTauriHostClient(call: Invoke = invoke): HostClient {
  return {
    async request(method, path, { body, officeToken, timeoutMs, schema }) {
      if (
        timeoutMs !== undefined &&
        !(Number.isInteger(timeoutMs) && timeoutMs >= MIN_TIMEOUT_MS && timeoutMs <= MAX_TIMEOUT_MS)
      ) {
        throw new HostError({
          kind: "transport",
          code: "invalid_request",
          message: `${method} ${path}: timeoutMs ${String(timeoutMs)} is not a whole number of milliseconds from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`,
        });
      }
      let raw: unknown;
      try {
        raw = await call("host_request", {
          method,
          path,
          body: body ?? null,
          officeToken: officeToken ?? null,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      } catch (error) {
        const code = TRANSPORT_CODES.find((candidate) => candidate === error) ?? "unreachable";
        throw new HostError({
          kind: "transport",
          code,
          message: `${method} ${path}: ${String(error)}`,
        });
      }
      const answer = hostResponseSchema.safeParse(raw);
      if (!answer.success) throw invalidResponse(method, path, answer.error.message);
      const { status } = answer.data;
      if (status >= 200 && status < 300) {
        const parsed = schema.safeParse(answer.data.body ?? null);
        if (!parsed.success) throw invalidResponse(method, path, parsed.error.message);
        return parsed.data;
      }
      const failure = errorBodySchema.safeParse(answer.data.body);
      if (!failure.success) {
        throw invalidResponse(method, path, `HTTP ${status} without an error body`);
      }
      throw new HostError({
        kind: "api",
        code: failure.data.error.code,
        message: failure.data.error.message,
        status,
        details: failure.data.error.details ?? {},
      });
    },
  };
}

function invalidResponse(method: string, path: string, reason: string): HostError {
  return new HostError({
    kind: "transport",
    code: "invalid_response",
    message: `${method} ${path}: ${reason}`,
  });
}
