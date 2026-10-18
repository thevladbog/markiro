import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { helloSchema, type Hello } from "./protocol.js";

export type HostProbeErrorCode =
  "unreachable" | "not_markiro_host" | "invalid_response" | "host_too_old" | "app_too_old";

const ERROR_CODES: readonly HostProbeErrorCode[] = [
  "unreachable",
  "not_markiro_host",
  "invalid_response",
  "host_too_old",
  "app_too_old",
];

export class HostProbeError extends Error {
  readonly code: HostProbeErrorCode;

  constructor(code: HostProbeErrorCode, message: string) {
    super(message);
    this.name = "HostProbeError";
    this.code = code;
  }
}

export interface HelloObservation {
  hello: Hello;
  /** Lower-case hex SHA-256 of the certificate the host presented. */
  fingerprint: string;
}

export interface HostProbe {
  hello(address: string): Promise<HelloObservation>;
}

const observationSchema = z
  .object({ hello: helloSchema, fingerprint: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Asks the Rust shell to fetch `/v1/hello`: the webview never performs HTTP
 * itself. The shell rejects with one of the `HostProbeErrorCode` strings.
 */
export function createTauriHostProbe(call: Invoke = invoke): HostProbe {
  return {
    async hello(address) {
      let raw: unknown;
      try {
        raw = await call("host_hello", { address });
      } catch (error) {
        const code = ERROR_CODES.find((candidate) => candidate === error) ?? "unreachable";
        throw new HostProbeError(code, `host_hello failed: ${String(error)}`);
      }
      const parsed = observationSchema.safeParse(raw);
      if (!parsed.success) {
        throw new HostProbeError("invalid_response", parsed.error.message);
      }
      return parsed.data;
    },
  };
}
