import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { assertPrivateRootSync } from "./files.mjs";

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
  let executable, args, cwd, env, timeoutMs, outputLimitBytes, signal;
  let childEnv;
  let childArgs;
  try {
    ({ executable, args, cwd, env, timeoutMs, outputLimitBytes, signal } = options);
    if (
      !["linux", "darwin"].includes(process.platform) ||
      typeof executable !== "string" ||
      !isAbsolute(executable) ||
      executable.includes("\0") ||
      !Array.isArray(args) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 3600000 ||
      !Number.isSafeInteger(outputLimitBytes) ||
      outputLimitBytes <= 0 ||
      outputLimitBytes > 1048576 ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    )
      throw processError("spawn", true);
    childArgs = Array.from(args);
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
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      if (reason || !confirmed) {
        output.stdout.length = 0;
        output.stderr.length = 0;
        reject(processError(confirmed ? reason : "termination", confirmed));
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
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(processError("spawn", true));
      return;
    }
    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", (bytes) => {
        if (reason || settled) return;
        sizes[stream] += bytes.length;
        if (sizes[stream] > outputLimitBytes) stop("output-limit");
        else output[stream].push(bytes);
      });
      child[stream].on("error", () => stop("exit"));
    }
    child.on("error", () => stop("spawn"));
    child.on("exit", (code, exitSignal) => {
      if (code !== 0 || exitSignal !== null) stop("exit");
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
