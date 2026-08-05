#!/usr/bin/env node

import process from "node:process";

import { validateWorkloadIdentityIds } from "./validate-workload-identities.mjs";

const REQUEST_TIMEOUT_MS = 5_000;
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_DOCUMENT_BYTES = 128 * 1024;
const ROLES = Object.freeze(["app", "audit", "controller", "runner", "terraform"]);
const EXPECTED_NAMES = Object.freeze({
  app: "markiro-production-app",
  audit: "markiro-production-audit",
  controller: "markiro-production-deployment-controller",
  runner: "markiro-production-runner",
  terraform: "markiro-production-terraform",
});

function invalid() {
  throw new Error("service account provenance is invalid");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return (
    isPlainObject(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function validateInputs(folderId, identities, accounts) {
  if (typeof folderId !== "string" || folderId.length === 0) invalid();
  try {
    validateWorkloadIdentityIds(identities);
  } catch {
    invalid();
  }
  if (!hasExactKeys(accounts, ROLES)) invalid();
}

async function readBoundedJsonResponse(response) {
  if (!response.ok || !response.body || typeof response.body.getReader !== "function") {
    await response.body?.cancel?.().catch(() => undefined);
    invalid();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        invalid();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    invalid();
  }
}

export function validateServiceAccountProvenance({ folderId, identities, accounts }) {
  validateInputs(folderId, identities, accounts);
  const canonical = {};
  for (const role of ROLES) {
    const account = accounts[role];
    if (
      !isPlainObject(account) ||
      account.id !== identities[role] ||
      account.name !== EXPECTED_NAMES[role] ||
      account.folderId !== folderId ||
      account.status !== "ACTIVE"
    )
      invalid();
    canonical[role] = {
      folderId: account.folderId,
      id: account.id,
      name: account.name,
      status: account.status,
    };
  }
  return canonical;
}

export function validateServiceAccountProvenanceDocument({ folderId, identities, document }) {
  if (!hasExactKeys(document, ROLES)) invalid();
  for (const role of ROLES) {
    if (!hasExactKeys(document[role], ["folderId", "id", "name", "status"])) invalid();
  }
  return validateServiceAccountProvenance({ folderId, identities, accounts: document });
}

export async function fetchServiceAccountProvenance({
  folderId,
  identities,
  token,
  fetchImpl = globalThis.fetch,
}) {
  validateInputs(folderId, identities, Object.fromEntries(ROLES.map((role) => [role, {}])));
  if (typeof token !== "string" || token.length === 0 || typeof fetchImpl !== "function") invalid();
  try {
    const entries = await Promise.all(
      ROLES.map(async (role) => {
        const response = await fetchImpl(
          `https://iam.api.cloud.yandex.net/iam/v1/serviceAccounts/${encodeURIComponent(identities[role])}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
        return [role, await readBoundedJsonResponse(response)];
      }),
    );
    return validateServiceAccountProvenance({
      folderId,
      identities,
      accounts: Object.fromEntries(entries),
    });
  } catch {
    invalid();
  }
}

async function readBoundedInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAXIMUM_DOCUMENT_BYTES) invalid();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function environmentInputs() {
  const identities = {
    app: process.env.TF_VAR_app_service_account_id,
    audit: process.env.TF_VAR_audit_service_account_id,
    controller: process.env.TF_VAR_deployment_controller_service_account_id,
    runner: process.env.TF_VAR_runner_service_account_id,
    terraform: process.env.TF_VAR_terraform_service_account_id,
  };
  if (identities.terraform !== process.env.YC_TERRAFORM_SERVICE_ACCOUNT_ID) invalid();
  return { folderId: process.env.YC_FOLDER_ID, identities };
}

async function runCli() {
  const mode = process.argv[2];
  const inputs = environmentInputs();
  let document;
  if (mode === "fetch") {
    document = await fetchServiceAccountProvenance({
      ...inputs,
      token: process.env.YC_TOKEN,
    });
  } else if (mode === "validate") {
    let parsed;
    try {
      parsed = JSON.parse(await readBoundedInput());
    } catch {
      invalid();
    }
    document = validateServiceAccountProvenanceDocument({ ...inputs, document: parsed });
  } else invalid();
  process.stdout.write(`${JSON.stringify(document)}\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  runCli().catch(() => {
    process.stderr.write("service account provenance is invalid\n");
    process.exitCode = 1;
  });
