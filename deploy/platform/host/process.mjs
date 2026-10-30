import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { assertPrivateRootSync } from "./files.mjs";

import { noteHostProcessFailure } from "./failure-diagnostic.mjs";

const termGraceMs = 2000;
const killReapMs = 2000;

function processError(reason, terminationConfirmed) {
  const error = new Error("Protected host process operation failed.");
  error.code = "ERR_HOST_PROCESS";
  error.reason = reason;
  error.terminationConfirmed = terminationConfirmed;
  return error;
}

function explicitEnvironment(env) {
  if (!env || ![Object.prototype, null].includes(Object.getPrototypeOf(env)))
    throw processError("spawn", true);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(env)) {
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    if (
      typeof key !== "string" ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(key) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string" ||
      descriptor.value.includes("\0")
    )
      throw processError("spawn", true);
    result[key] = descriptor.value;
  }
  return result;
}

// Trusted local executables only: a child that deliberately escapes its POSIX
// process group is outside this contract. A Docker CLI process group is NOT a
// Docker daemon-owned workload. Orchestration must independently stop/inspect
// its operation-labelled, deterministically named container before recovery.
// terminationConfirmed=false must retain unresolved operation state.
export async function runHostProcess(options) {
  return runBoundedHostProcess(options, 1048576);
}
// Separate trusted producer for a migration TAR only. Ordinary command/control
// output retains its 1 MiB ceiling; stderr never receives the archive budget.
export async function runHostArchiveProcess(options) {
  return runBoundedHostProcess(options, 16 * 1048576);
}
// Separate trusted producer for protected SSH/Node coordinators. The upgrade
// transport classifies their exact fixed argv before selecting this producer;
// ordinary commands/workloads and migration archives keep the one-hour ceiling.
export async function runHostCoordinatorProcess(options) {
  if (!["/usr/bin/node", "/usr/bin/ssh"].includes(options?.executable))
    throw processError("spawn", true);
  return runBoundedHostProcess(options, 1048576, 7200000);
}
async function runBoundedHostProcess(options, maxOutputBytes, maxTimeoutMs = 3600000) {
  let executable, args, cwd, env, timeoutMs, outputLimitBytes, signal;
  let childEnv;
  let childArgs;
  let input;
  try {
    ({ executable, args, cwd, env, timeoutMs, outputLimitBytes, signal, input } = options);
    if (
      !["linux", "darwin"].includes(process.platform) ||
      typeof executable !== "string" ||
      !isAbsolute(executable) ||
      executable.includes("\0") ||
      !Array.isArray(args) ||
      (input !== undefined && (!Buffer.isBuffer(input) || input.length > 1048576)) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > maxTimeoutMs ||
      !Number.isSafeInteger(outputLimitBytes) ||
      outputLimitBytes <= 0 ||
      outputLimitBytes > maxOutputBytes ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    )
      throw processError("spawn", true);
    childArgs = Array.from(args);
    if (input !== undefined) input = Buffer.from(input);
    if (childArgs.some((arg) => typeof arg !== "string" || arg.includes("\0")))
      throw processError("spawn", true);
    assertPrivateRootSync(cwd);
    childEnv = explicitEnvironment(env);
  } catch {
    throw processError("spawn", true);
  }
  if (signal?.aborted) throw processError("aborted", true);

  return new Promise((resolve, reject) => {
    let child;
    let exitStatus = null;
    let closed = false;
    let settled = false;
    let reason;
    let deadline;
    let termTimer;
    let reapTimer;
    let poll;
    const output = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };

    const groupGone = () => {
      if (!child.pid) return true;
      try {
        process.kill(-child.pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    };
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(termTimer);
      clearTimeout(reapTimer);
      clearInterval(poll);
      signal?.removeEventListener("abort", abort);
      if (!confirmed) {
        // Bound our handles even when the OS cannot confirm workload termination.
        child.stdin?.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      if (reason || !confirmed) {
        output.stdout.length = 0;
        output.stderr.length = 0;
        reject(
          noteHostProcessFailure(
            processError(confirmed ? reason : "termination", confirmed),
            executable,
            exitStatus,
          ),
        );
      } else {
        resolve({ stdout: Buffer.concat(output.stdout), stderr: Buffer.concat(output.stderr) });
      }
    };
    const checkStopped = () => {
      if (closed && groupGone()) finish(true);
    };
    const send = (name) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch {
        // A signal attempt is not proof. Only close + an absent group confirms it.
      }
    };
    const stop = (why) => {
      if (reason || settled) return;
      reason = why;
      output.stdout.length = 0;
      output.stderr.length = 0;
      clearTimeout(deadline);
      send("SIGTERM");
      poll = setInterval(checkStopped, 25);
      termTimer = setTimeout(() => {
        send("SIGKILL");
        reapTimer = setTimeout(() => {
          if (closed && groupGone()) finish(true);
          else finish(false);
        }, killReapMs);
        checkStopped();
      }, termGraceMs);
      checkStopped();
    };
    const abort = () => stop("aborted");
    try {
      child = spawn(executable, childArgs, {
        cwd,
        env: childEnv,
        shell: false,
        detached: true,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch {
      reject(processError("spawn", true));
      return;
    }
    if (input !== undefined) {
      child.stdin.on("error", () => stop("stdin"));
      // One bounded write: Node owns backpressure and end closes stdin after flush.
      child.stdin.end(input, (error) => {
        if (error) stop("stdin");
      });
    }
    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", (bytes) => {
        if (reason || settled) return;
        sizes[stream] += bytes.length;
        if (
          sizes[stream] >
          (stream === "stderr" ? Math.min(outputLimitBytes, 1048576) : outputLimitBytes)
        )
          stop("output-limit");
        else output[stream].push(bytes);
      });
      child[stream].on("error", () => stop("stream"));
    }
    child.on("error", () => stop("spawn"));
    child.on("exit", (code, exitSignal) => {
      exitStatus = code;
      if (exitSignal !== null) stop("signal");
      else if (code !== 0) stop("exit");
    });
    child.on("close", () => {
      closed = true;
      if (groupGone()) finish(true);
      else stop("termination");
    });
    deadline = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
