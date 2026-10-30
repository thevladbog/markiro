/** Read-only local rehearsal metadata. Never installed or production authority. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  createRehearsalEngineRequest,
  rehearsalEngineReadFailure as failure,
  rehearsalEngineReadReason,
} from "./rehearsal-engine-request.mjs";
export {
  rehearsalEngineReadFailure,
  rehearsalEngineReadReason,
} from "./rehearsal-engine-request.mjs";
export function createRehearsalMetadataReader(endpoint) {
  const read = createRehearsalEngineRequest(endpoint);
  let routesFailed = false;
  return Object.freeze({
    routes: async (id) => {
      assert.ok(typeof id === "string" && /^[a-f0-9]{64}$/u.exec(id)?.[0] === id);
      if (routesFailed) throw failure("engine-socket");
      const began = performance.now();
      const remaining = () => {
        const ms = Math.floor(120000 - (performance.now() - began));
        if (ms <= 0) throw failure("engine-timeout");
        return ms;
      };
      let terminated = false;
      try {
        // Same fixed sh/ip argv as docker exec, fresh process on every guard.
        // Only the Docker CLI process is removed from the transport.
        const exec = await read(`/v1.41/containers/${id}/exec`, {
          method: "POST",
          status: 201,
          timeoutMs: remaining(),
          body: {
            AttachStdin: false,
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
            Privileged: false,
            Cmd: rehearsalRouteCommand,
          },
        });
        assert.ok(typeof exec.Id === "string" && /^[a-f0-9]{64}$/u.exec(exec.Id)?.[0] === exec.Id);
        const bytes = await read(`/v1.41/exec/${exec.Id}/start`, {
          method: "POST",
          raw: true,
          timeoutMs: remaining(),
          body: { Detach: false, Tty: false },
        });
        const state = await read(`/v1.41/exec/${exec.Id}/json`, { timeoutMs: remaining() });
        assert.equal(state.ID, exec.Id);
        assert.equal(state.ContainerID, id);
        assert.equal(state.Running, false);
        terminated = true;
        assert.equal(state.ExitCode, 0);
        const stdout = [];
        for (let offset = 0; offset < bytes.length;) {
          assert.ok(offset + 8 <= bytes.length);
          const h = bytes.subarray(offset, offset + 8),
            size = h.readUInt32BE(4);
          assert.ok([1, 2].includes(h[0]) && h.subarray(1, 4).every((b) => b === 0));
          offset += 8;
          assert.ok(offset + size <= bytes.length);
          // Successful ip must not report errors on stderr, even with exit 0.
          assert.ok(h[0] === 1 || size === 0);
          if (h[0] === 1) stdout.push(bytes.subarray(offset, offset + size));
          offset += size;
        }
        const value = parseRehearsalRoutes(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)),
        );
        remaining();
        return value;
      } catch (error) {
        routesFailed = true;
        const problem = rehearsalEngineReadReason(error) ? error : failure("engine-invalid-json");
        // A lost exec response never proves the remote process stopped. The
        // namespace owner must remove its exact daemon before any acceptance.
        if (!terminated) problem.terminationConfirmed = false;
        throw problem;
      }
    },
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
