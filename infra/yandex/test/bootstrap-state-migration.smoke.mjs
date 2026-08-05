import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertManagedResourceInState } from "./bootstrap-state.mjs";

const terraform =
  process.env.MARKIRO_TERRAFORM_BIN ?? "/private/tmp/markiro-terraform-1.15.8.HkkrjU/terraform";

function terraformCommand(directory, ...args) {
  execFileSync(terraform, [`-chdir=${directory}`, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: randomUUID(),
      AWS_SECRET_ACCESS_KEY: randomUUID(),
    },
    stdio: "pipe",
  });
}

async function startDisposableS3(statePath) {
  const server = spawn(process.execPath, [
    path.join(import.meta.dirname, "disposable-s3-server.mjs"),
    statePath,
  ]);
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("exit", (code) =>
      reject(new Error(`disposable S3 server exited before binding (${code})`)),
    );
    server.stdout.once("data", (chunk) => {
      const value = chunk.toString("utf8").trim();
      if (value.startsWith("ERROR:")) reject(new Error(value));
      else resolve(Number(value));
    });
  });
  if (!Number.isInteger(port) || port < 1) throw new Error("disposable S3 server did not bind");

  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.once("exit", resolve);
        server.kill("SIGTERM");
      }),
  };
}

const root = await mkdtemp(path.join(tmpdir(), "markiro-bootstrap-state-smoke-"));
const statePath = path.join(root, "remote-state.json");
const s3 = await startDisposableS3(statePath);

try {
  await writeFile(
    path.join(root, "main.tf"),
    'terraform { required_version = "= 1.15.8" }\nresource "terraform_data" "bootstrap" { input = "local-first" }\n',
  );

  // Exact clean-directory lifecycle: default local backend before backend.tf.
  terraformCommand(root, "init", "-input=false");
  terraformCommand(root, "apply", "-input=false", "-auto-approve");
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
    root,
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
} finally {
  await s3.close();
  await rm(root, { recursive: true, force: true });
}
