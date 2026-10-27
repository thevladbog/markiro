/** CI-only fresh metadata reads through one owned, local DinD connection. */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { assertPrivateRootSync } from "./host/files.mjs";
import {
  rehearsalEngineReadFailure as failure,
  rehearsalEngineReadReason,
} from "./rehearsal-isolation-readers.mjs";

// Docker's pinned IndentedInspector indents the raw response inside an array.
// Preserve raw JSON tokens (including large integers and escapes), not a JS
// parse/stringify round trip. Bound indentation BEFORE allocating it as well.
function inspectOutput(raw, limit) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const value = JSON.parse(text);
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const tokens = ("[" + text + "]").match(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:]+/gu);
  const chunks = [];
  let bytes = 0,
    depth = 0;
  const append = (part) => {
    bytes += Buffer.byteLength(part);
    if (bytes > limit) throw failure("engine-response-size");
    chunks.push(part);
  };
  const newline = () => {
    if (bytes + 1 + depth * 4 > limit) throw failure("engine-response-size");
    append("\n" + " ".repeat(depth * 4));
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{" || token === "[") {
      append(token);
      depth++;
      if (tokens[i + 1] !== (token === "{" ? "}" : "]")) newline();
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[i - 1] !== (token === "}" ? "{" : "[")) newline();
      append(token);
    } else if (token === ",") {
      append(token);
      newline();
    } else if (token === ":") append(": ");
    else append(token);
  }
  append("\n");
  return Buffer.from(chunks.join(""));
}

// Deliberately exclude images: the CLI transforms their Config representation.
// No names, formats, lists, writes, arbitrary URLs or version negotiation.
export function rehearsalInspectPath(args) {
  if (!Array.isArray(args) || args.length !== 3 || args[1] !== "inspect") return null;
  const [kind, , key] = args;
  if (["container", "network"].includes(kind) && /^[a-f0-9]{64}$/u.test(key))
    return kind === "container" ? `/v1.51/containers/${key}/json` : `/v1.51/networks/${key}`;
  if (kind === "volume" && key === "markiro-platform_postgres-data") return `/v1.51/volumes/${key}`;
  return null;
}
export function createRehearsalInspectReader(open) {
  assert.equal(typeof open, "function");
  let channel,
    agent,
    current,
    closing,
    closed = false,
    busy = false;
  const close = () => {
    closed = true;
    if (!closing) {
      current?.destroy();
      agent?.destroy();
      closing = Promise.resolve().then(() => channel?.close());
    }
    return closing;
  };
  return Object.freeze({
    close,
    read: async ({ args, timeoutMs, outputLimitBytes, signal }) => {
      const path = rehearsalInspectPath(args);
      assert.ok(path);
      assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3600000);
      assert.ok(
        Number.isSafeInteger(outputLimitBytes) &&
          outputLimitBytes > 3 &&
          outputLimitBytes <= 1048576,
      );
      assert.ok(signal === undefined || signal instanceof AbortSignal);
      if (closed || busy || signal?.aborted) throw failure("engine-socket");
      busy = true;
      const started = performance.now();
      try {
        if (!channel) {
          channel = open();
          assert.ok(channel?.socket instanceof Duplex && typeof channel.close === "function");
          agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
          let connected = false;
          agent.createConnection = (_options, callback) => {
            if (connected) {
              callback(failure("engine-socket"));
              return;
            }
            connected = true;
            return channel.socket;
          };
          channel.socket.on("error", () => {});
        }
        return await new Promise((resolve, reject) => {
          let complete = false,
            problem,
            result,
            bytes = 0;
          const chunks = [];
          const q = http.request({ host: "localhost", method: "GET", path, agent });
          current = q;
          const fail = (reason) => {
            if (!problem) problem = failure(reason);
            q.destroy();
          };
          const timer = setTimeout(
            () => fail("engine-timeout"),
            Math.max(1, timeoutMs - (performance.now() - started)),
          );
          const abort = () => fail("engine-socket");
          signal?.addEventListener("abort", abort, { once: true });
          q.on("error", () => fail("engine-socket"));
          q.on("close", () => {
            current = undefined;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (performance.now() - started > timeoutMs) problem ??= failure("engine-timeout");
            if (problem) reject(problem);
            else if (!complete || closed) reject(failure("engine-socket"));
            else resolve(result);
          });
          q.on("response", (response) => {
            if (response.statusCode !== 200 || response.headers["content-encoding"]) {
              fail("engine-http-status");
              return;
            }
            response.on("error", () => fail("engine-socket"));
            response.on("aborted", () => fail("engine-socket"));
            response.on("data", (chunk) => {
              if (problem) return;
              bytes += chunk.length;
              if (bytes > outputLimitBytes - 3) fail("engine-response-size");
              else chunks.push(chunk);
            });
            response.on("end", () => {
              if (problem) return;
              try {
                const stdout = inspectOutput(Buffer.concat(chunks), outputLimitBytes);
                result = { stdout, stderr: Buffer.alloc(0) };
                complete = true;
              } catch (error) {
                fail(rehearsalEngineReadReason(error) ?? "engine-invalid-json");
              }
            });
            response.on("close", () => {
              if (!complete) fail("engine-socket");
            });
          });
          q.end();
          if (signal?.aborted) abort();
        });
      } catch (error) {
        const primary = rehearsalEngineReadReason(error) ? error : failure("engine-socket");
        try {
          await close();
        } catch {
          // Keep first origin. close() remains rejected for the namespace owner,
          // which must still perform exact cleanup and refuse completed evidence.
          primary.terminationConfirmed = false;
        }
        throw primary;
      } finally {
        busy = false;
      }
    },
  });
}

// The connection helper is fixed Docker CLI code from the pinned DinD image.
// It opens only the inner Unix socket. No port, host socket mount or network is
// introduced. EOF/close drains its local process group before namespace cleanup;
// the outer cleanup independently removes the exact owned daemon and its helpers.
export function createDockerInspectChannel({ executable, endpoint, containerId, cwd, env }) {
  assert.ok(isAbsolute(executable));
  assert.match(endpoint, /^unix:\/\/\/[^\r\n\0?#]+$/u);
  assert.match(containerId, /^[a-f0-9]{64}$/u);
  assertPrivateRootSync(cwd);
  return createRehearsalInspectReader(() => {
    const child = spawn(
      executable,
      [
        "--host",
        endpoint,
        "exec",
        "-i",
        containerId,
        "/usr/local/bin/docker",
        "--host",
        "unix:///var/run/docker.sock",
        "system",
        "dial-stdio",
      ],
      { cwd, env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let closed = false,
      closing,
      stderrBytes = 0;
    child.once("close", () => {
      closed = true;
    });
    const socket = Duplex.from({ readable: child.stdout, writable: child.stdin });
    // Agent uses these only to manage idle handles; request deadlines above are
    // monotonic wall deadlines, including response bodies, not idle timeouts.
    socket.setTimeout = () => socket;
    socket.setKeepAlive = () => socket;
    socket.setNoDelay = () => socket;
    socket.ref = () => socket;
    socket.unref = () => socket;
    const signal = (name) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, name);
        } catch {
          // Only close plus the group probe below establishes termination.
        }
      }
    };
    const gone = () => {
      if (!child.pid) return true;
      try {
        process.kill(-child.pid, 0);
        return false;
      } catch (e) {
        return e.code === "ESRCH";
      }
    };
    child.on("error", () => socket.destroy(failure("engine-socket")));
    child.stderr.on("error", () => socket.destroy(failure("engine-socket")));
    child.stderr.on("data", (bytes) => {
      stderrBytes += bytes.length;
      if (stderrBytes > 1048576) {
        signal("SIGTERM");
        socket.destroy(failure("engine-response-size"));
      }
    });
    return {
      socket,
      close: () =>
        (closing ??= (async () => {
          socket.destroy();
          child.stdin.destroy();
          const term = setTimeout(() => signal("SIGTERM"), 1000);
          const kill = setTimeout(() => signal("SIGKILL"), 3000);
          let bound, poll;
          try {
            await new Promise((resolve) => {
              const check = () => {
                if (closed && gone()) resolve();
              };
              poll = setInterval(check, 25);
              bound = setTimeout(resolve, 5000);
              check();
            });
            if (!closed || !gone()) throw failure("engine-socket");
          } finally {
            clearTimeout(term);
            clearTimeout(kill);
            clearTimeout(bound);
            clearInterval(poll);
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
          }
        })()),
    };
  });
}
