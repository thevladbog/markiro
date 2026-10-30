/** Bounded Unix Engine transport for local synthetic rehearsals only. */
import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { isAbsolute, normalize } from "node:path";
const reasons = new WeakMap();
export function rehearsalEngineReadFailure(reason) {
  const error = new Error("Rehearsal engine metadata read failed.");
  error.code = "ERR_REHEARSAL_ENGINE_READ";
  reasons.set(error, reason);
  return error;
}
const failure = rehearsalEngineReadFailure;
export const rehearsalEngineReadReason = (error) => reasons.get(error) ?? null;
export function createRehearsalEngineRequest(endpoint) {
  assert.equal(typeof endpoint, "string");
  assert.ok(endpoint.startsWith("unix:///"));
  const socketPath = endpoint.slice(7);
  assert.ok(isAbsolute(socketPath) && normalize(socketPath) === socketPath);
  assert.equal(/[\r\n\0?#]/u.test(socketPath), false);
  // Private transport: callers can select only the fixed methods below.
  const read = (
    path,
    { method = "GET", body, status = 200, raw = false, timeoutMs = 120000 } = {},
  ) =>
    new Promise((resolve, reject) => {
      const started = performance.now();
      let request;
      try {
        request = http.request({
          socketPath,
          path,
          method,
          agent: false,
          ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" } }),
        });
      } catch {
        reject(failure("engine-socket"));
        return;
      }
      let closed = false,
        complete = false,
        problem,
        value,
        length = 0;
      const chunks = [];
      const fail = (reason) => {
        if (closed || problem) return;
        problem = failure(reason);
        request.destroy();
      };
      const timer = setTimeout(
        () => fail("engine-timeout"),
        Math.max(1, timeoutMs - (performance.now() - started)),
      );
      request.on("error", () => fail("engine-socket"));
      // Resolve/reject only after the request closes: allSettled must drain every
      // socket as well as the route subprocess before a command or cleanup.
      request.on("close", () => {
        closed = true;
        clearTimeout(timer);
        if (performance.now() - started > timeoutMs) problem ??= failure("engine-timeout");
        if (problem) reject(problem);
        else if (!complete) reject(failure("engine-socket"));
        else resolve(value);
      });
      request.on("response", (response) => {
        if (response.statusCode !== status || response.headers["content-encoding"]) {
          fail("engine-http-status");
          return;
        }
        response.on("aborted", () => fail("engine-socket"));
        response.on("error", () => fail("engine-socket"));
        response.on("data", (bytes) => {
          if (problem) return;
          length += bytes.length;
          if (length > 4 * 1048576) {
            fail("engine-response-size");
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          if (problem) return;
          try {
            const bytes = Buffer.concat(chunks);
            if (raw) value = bytes;
            else {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              value = JSON.parse(text);
              assert.ok(value && typeof value === "object" && !Array.isArray(value));
            }
          } catch {
            fail("engine-invalid-json");
            return;
          }
          if (performance.now() - started > timeoutMs) {
            fail("engine-timeout");
            return;
          }
          complete = true;
        });
        response.on("close", () => {
          if (!complete) fail("engine-socket");
        });
      });
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return read;
}
