/** Read-only local rehearsal transport. Never installed or production authority. */
import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { isAbsolute, normalize } from "node:path";
const reasons = new WeakMap();
function failure(reason) {
  const error = new Error("Rehearsal engine metadata read failed.");
  error.code = "ERR_REHEARSAL_ENGINE_READ";
  reasons.set(error, reason);
  return error;
}
export const rehearsalEngineReadReason = (error) => reasons.get(error) ?? null;
export function createRehearsalMetadataReader(endpoint) {
  assert.equal(typeof endpoint, "string");
  assert.ok(endpoint.startsWith("unix:///"));
  const socketPath = endpoint.slice(7);
  assert.ok(isAbsolute(socketPath) && normalize(socketPath) === socketPath);
  assert.equal(/[\r\n\0?#]/u.test(socketPath), false);
  const read = (path) =>
    new Promise((resolve, reject) => {
      const started = performance.now();
      let request;
      try {
        request = http.request({ socketPath, path, method: "GET", agent: false });
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
        Math.max(1, 120000 - (performance.now() - started)),
      );
      request.on("error", () => fail("engine-socket"));
      // Resolve/reject only after the request closes: allSettled must drain every
      // socket as well as the route subprocess before a command or cleanup.
      request.on("close", () => {
        closed = true;
        clearTimeout(timer);
        if (performance.now() - started > 120000) problem ??= failure("engine-timeout");
        if (problem) reject(problem);
        else if (!complete) reject(failure("engine-socket"));
        else resolve(value);
      });
      request.on("response", (response) => {
        if (response.statusCode !== 200) {
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
            const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
            value = JSON.parse(text);
            assert.ok(value && typeof value === "object" && !Array.isArray(value));
          } catch {
            fail("engine-invalid-json");
            return;
          }
          if (performance.now() - started > 120000) {
            fail("engine-timeout");
            return;
          }
          complete = true;
        });
        response.on("close", () => {
          if (!complete) fail("engine-socket");
        });
      });
      request.end();
    });
  return Object.freeze({
    container: async (id) => {
      assert.ok(typeof id === "string" && /^[a-f0-9]{64}$/u.test(id));
      return read(`/v1.41/containers/${id}/json`);
    },
    volume: async (name) => {
      assert.ok(
        typeof name === "string" &&
          /^markiro-upgrade-ci-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
            name,
          ),
      );
      return read(`/v1.41/volumes/${name}`);
    },
  });
}
// A single short-lived process reads both families; no route or result is cached
// across guards. -e refuses either ip failure, and NUL framing is exact.
export const rehearsalRouteCommand = Object.freeze([
  "sh",
  "-ceu",
  "ip -4 route show default; printf '\\0'; ip -6 route show default; printf '\\0'",
]);
export function parseRehearsalRoutes(output) {
  assert.equal(typeof output, "string");
  assert.ok(Buffer.byteLength(output) <= 4 * 1048576);
  const parts = output.split("\0");
  assert.equal(parts.length, 3);
  assert.equal(parts[2], "");
  return { ipv4: parts[0], ipv6: parts[1] };
}
export function rehearsalIsolationReaders({ container, volume, routes }) {
  for (const action of [container, volume, routes]) assert.equal(typeof action, "function");
  let routeResult;
  const readRoutes = () => (routeResult ??= Promise.resolve().then(routes));
  return {
    container,
    volume,
    ipv4: async () => (await readRoutes()).ipv4,
    ipv6: async () => (await readRoutes()).ipv6,
  };
}
