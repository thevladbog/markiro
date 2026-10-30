/** Fixed generated-file commands in the exact owned forward-rehearsal daemon. */
import assert from "node:assert/strict";
import { isAbsolute, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { assertPrivateRootSync } from "./host/files.mjs";
import {
  createRehearsalEngineRequest,
  rehearsalEngineReadFailure as failure,
  rehearsalEngineReadReason,
} from "./rehearsal-engine-request.mjs";
const COMMAND_TIMEOUT_MS = 120000;
function decodeOutput(bytes) {
  const stdout = [],
    stderr = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(offset + 8 <= bytes.length);
    const header = bytes.subarray(offset, offset + 8),
      size = header.readUInt32BE(4);
    assert.ok([1, 2].includes(header[0]) && header.subarray(1, 4).every((value) => value === 0));
    offset += 8;
    assert.ok(offset + size <= bytes.length);
    (header[0] === 1 ? stdout : stderr).push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}
export function createRehearsalFilesystemReader({ endpoint, containerId, root }) {
  assert.match(containerId, /^[a-f0-9]{64}$/u);
  assert.ok(isAbsolute(root) && normalize(root) === root && root !== "/");
  assertPrivateRootSync(root);
  const read = createRehearsalEngineRequest(endpoint);
  const ownedPath = (value) =>
    typeof value === "string" &&
    Buffer.byteLength(value) <= 4096 &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    isAbsolute(value) &&
    normalize(value) === value &&
    (value === root || value.startsWith(root + "/"));
  const supports = (args) => {
    if (!Array.isArray(args)) return false;
    for (const value of args) if (typeof value !== "string") return false;
    if (args[0] === "mkdir")
      return (
        (args.length === 3 && args[1] === "-p" && ownedPath(args[2])) ||
        (args.length === 5 &&
          args[1] === "-p" &&
          args[2] === "-m" &&
          args[3] === "700" &&
          ownedPath(args[4]))
      );
    if (args[0] === "chmod") return args.length === 3 && args[1] === "700" && ownedPath(args[2]);
    if (args[0] === "chown")
      return (
        args.length >= 3 &&
        args.length <= 10 &&
        /^(?:0|[1-9][0-9]{0,9}):(?:0|[1-9][0-9]{0,9})$/u.test(args[1]) &&
        args[1].split(":").every((value) => Number(value) <= 4294967295) &&
        args.slice(2).every(ownedPath)
      );
    if (args[0] === "sha256sum") return args.length === 2 && ownedPath(args[1]);
    return (
      args[0] === "stat" &&
      args.length === 4 &&
      args[1] === "-c" &&
      ["%a:%F", "%a:%s", "%u:%g:%a:%s"].includes(args[2]) &&
      ownedPath(args[3])
    );
  };
  let poisoned = false,
    busy = false;
  return Object.freeze({
    supports,
    run: async (args) => {
      const command = Array.isArray(args) ? [...args] : [];
      assert.ok(supports(command));
      if (poisoned || busy) throw failure("engine-socket");
      busy = true;
      const began = performance.now();
      const remaining = () => {
        const ms = Math.floor(COMMAND_TIMEOUT_MS - (performance.now() - began));
        if (ms <= 0) throw failure("engine-timeout");
        return ms;
      };
      let terminated = false;
      try {
        const created = await read(`/v1.41/containers/${containerId}/exec`, {
          method: "POST",
          status: 201,
          timeoutMs: remaining(),
          body: {
            AttachStdin: false,
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
            Privileged: false,
            Cmd: command,
          },
        });
        assert.ok(typeof created.Id === "string" && /^[a-f0-9]{64}$/u.test(created.Id));
        const bytes = await read(`/v1.41/exec/${created.Id}/start`, {
          method: "POST",
          raw: true,
          timeoutMs: remaining(),
          body: { Detach: false, Tty: false },
        });
        const state = await read(`/v1.41/exec/${created.Id}/json`, { timeoutMs: remaining() });
        assert.equal(state.ID, created.Id);
        assert.equal(state.ContainerID, containerId);
        assert.equal(state.Running, false);
        // Moby retains the historical process PID after exit; Running/ExitCode
        // establish terminal state, as in the existing route-exec transport.
        assert.ok(Number.isInteger(state.ExitCode) && state.ExitCode >= 0 && state.ExitCode <= 255);
        terminated = true;
        const output = decodeOutput(bytes);
        remaining();
        if (state.ExitCode !== 0) {
          const error = new Error("Rehearsal filesystem command failed.");
          Object.assign(error, { code: state.ExitCode, ...output, terminationConfirmed: true });
          throw error;
        }
        return output;
      } catch (error) {
        poisoned = true;
        const problem =
          Number.isInteger(error.code) || rehearsalEngineReadReason(error)
            ? error
            : failure("engine-invalid-json");
        if (!terminated) problem.terminationConfirmed = false;
        throw problem;
      } finally {
        busy = false;
      }
    },
  });
}
/** Select before execution; a selected failure never falls back to CLI. */
export function createRehearsalShell({ forward, runCli, ...settings }) {
  assert.equal(typeof runCli, "function");
  assert.equal(typeof forward, "boolean");
  if (!forward) return runCli;
  const reader = createRehearsalFilesystemReader(settings);
  let failed = false,
    uncertain = false;
  return async (args) => {
    if (failed) {
      const error = failure("engine-socket");
      if (uncertain) error.terminationConfirmed = false;
      throw error;
    }
    if (!reader.supports(args)) return runCli(args);
    try {
      return await reader.run(args);
    } catch (error) {
      failed = true;
      uncertain = error.terminationConfirmed === false;
      error.rehearsalExecutable = "docker";
      error.rehearsalCommand = "docker exec";
      throw error;
    }
  };
}
