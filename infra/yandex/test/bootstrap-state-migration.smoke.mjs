import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isMainModule } from "../../../deploy/yandex/cli-main.mjs";
import { assertManagedResourceInState } from "./bootstrap-state.mjs";

const SUCCESS_MARKER = "MIGRATION_VERIFIED";
const LISTENER_ERROR = /^DISPOSABLE_S3_LISTENER_ERROR:(EPERM|EACCES)\n?$/;

class DisposableS3ListenerError extends Error {
  constructor(code) {
    super(`disposable S3 listener failed with ${code}`);
    this.code = code;
    this.name = "DisposableS3ListenerError";
  }
}

function errorText(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

export function listenerPolicyErrorCode(error) {
  if (
    error instanceof DisposableS3ListenerError &&
    (error.code === "EPERM" || error.code === "EACCES")
  )
    return error.code;
  return LISTENER_ERROR.exec(errorText(error?.stderr))?.[1];
}

export function shouldSkipListenerFailure(error, environment = process.env) {
  return environment.CI !== "true" && listenerPolicyErrorCode(error) !== undefined;
}

function terraformCommand(terraform, directory, environment, ...args) {
  execFileSync(terraform, [`-chdir=${directory}`, ...args], {
    encoding: "utf8",
    env: {
      ...environment,
      AWS_ACCESS_KEY_ID: randomUUID(),
      AWS_SECRET_ACCESS_KEY: randomUUID(),
    },
    stdio: "pipe",
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

export async function stopChildProcess(
  child,
  { killTimeoutMs = 1_000, termTimeoutMs = 1_000 } = {},
) {
  if (await waitForExit(child, 0)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, termTimeoutMs)) return;
  child.kill("SIGKILL");
  if (await waitForExit(child, killTimeoutMs)) return;
  throw new Error("disposable S3 server did not stop within the cleanup bound");
}

export async function startDisposableS3(
  statePath,
  {
    environment = process.env,
    killTimeoutMs = 1_000,
    startupTimeoutMs = 5_000,
    termTimeoutMs = 1_000,
  } = {},
) {
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "disposable-s3-server.mjs"), statePath],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    const port = await new Promise((resolve, reject) => {
      let output = "";
      const finish = (callback, value) => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        child.stdout.off("data", onData);
        callback(value);
      };
      const onError = (error) => finish(reject, error);
      const onExit = (code) =>
        finish(reject, new Error(`disposable S3 server exited before binding (${code})`));
      const onData = (chunk) => {
        output += chunk.toString("utf8");
        const newline = output.indexOf("\n");
        if (newline === -1) return;
        const line = output.slice(0, newline);
        const listenerError = /^ERROR: (\S+)$/.exec(line);
        if (listenerError) finish(reject, new DisposableS3ListenerError(listenerError[1]));
        else finish(resolve, Number(line));
      };
      const timer = setTimeout(
        () =>
          finish(reject, new Error("disposable S3 server did not bind within the startup bound")),
        startupTimeoutMs,
      );
      child.once("error", onError);
      child.once("exit", onExit);
      child.stdout.on("data", onData);
    });
    if (!Number.isInteger(port) || port < 1)
      throw new Error("disposable S3 server did not bind to a valid port");

    return {
      endpoint: `http://127.0.0.1:${port}`,
      close: () => stopChildProcess(child, { killTimeoutMs, termTimeoutMs }),
    };
  } catch (error) {
    await stopChildProcess(child, { killTimeoutMs, termTimeoutMs });
    throw error;
  }
}

export async function runBootstrapStateMigrationSmoke({
  environment = process.env,
  temporaryDirectory = tmpdir(),
  terraform = environment.MARKIRO_TERRAFORM_BIN ?? "terraform",
} = {}) {
  execFileSync(terraform, ["version", "-json"], {
    encoding: "utf8",
    env: environment,
    stdio: "pipe",
  });

  let failure;
  let root;
  let s3;
  try {
    root = await mkdtemp(path.join(temporaryDirectory, "markiro-bootstrap-state-smoke-"));
    const statePath = path.join(root, "remote-state.json");
    s3 = await startDisposableS3(statePath, { environment });

    await writeFile(
      path.join(root, "main.tf"),
      'terraform { required_version = "= 1.15.8" }\nresource "terraform_data" "bootstrap" { input = "local-first" }\n',
    );

    // Exact clean-directory lifecycle: default local backend before backend.tf.
    terraformCommand(terraform, root, environment, "init", "-input=false");
    terraformCommand(terraform, root, environment, "apply", "-input=false", "-auto-approve");
    assertManagedResourceInState(
      await readFile(path.join(root, "terraform.tfstate"), "utf8"),
      "terraform_data",
      "bootstrap",
      "local bootstrap state",
    );

    await writeFile(path.join(root, "backend.tf"), 'terraform {\n  backend "s3" {}\n}\n');
    await writeFile(
      path.join(root, "backend.hcl"),
      [
        `endpoints = { s3 = "${s3.endpoint}" }`,
        'bucket = "markiro-bootstrap-smoke"',
        'key = "bootstrap/terraform.tfstate"',
        'region = "ru-central1"',
        "skip_region_validation = true",
        "skip_credentials_validation = true",
        "skip_requesting_account_id = true",
        "skip_s3_checksum = true",
        "use_path_style = true",
      ].join("\n"),
    );
    terraformCommand(
      terraform,
      root,
      environment,
      "init",
      "-migrate-state",
      "-force-copy",
      "-input=false",
      "-backend-config=backend.hcl",
    );
    assertManagedResourceInState(
      await readFile(statePath, "utf8"),
      "terraform_data",
      "bootstrap",
      "migrated S3 state",
    );
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors = [];
    try {
      if (s3) await s3.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (root) await rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (failure && cleanupErrors.length > 0)
      throw new AggregateError([failure, ...cleanupErrors], "state smoke and cleanup failed");
    if (failure) throw failure;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1)
      throw new AggregateError(cleanupErrors, "state smoke cleanup failed");
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await runBootstrapStateMigrationSmoke();
    process.stdout.write(`${SUCCESS_MARKER}\n`);
  } catch (error) {
    const listenerCode = listenerPolicyErrorCode(error);
    process.stderr.write(
      listenerCode
        ? `DISPOSABLE_S3_LISTENER_ERROR:${listenerCode}\n`
        : `BOOTSTRAP_STATE_SMOKE_FAILED:${error?.code ?? "UNKNOWN"}\n`,
    );
    process.exitCode = 1;
  }
}
