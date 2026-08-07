#!/usr/bin/env node

import process from "node:process";

const MAXIMUM_APPLY_BYTES = 32 * 1024 * 1024;
const MAXIMUM_ARTIFACT_BYTES = 256 * 1024;
const CATEGORIES = Object.freeze([
  "alb_healthy_backend",
  "alb_5xx",
  "alb_latency",
  "sws_deny",
  "sws_arl",
  "vm_cpu",
  "vm_memory",
  "vm_disk",
  "postgres_availability",
  "postgres_storage",
  "postgres_connections",
  "postgres_backup_age",
  "certificate_risk",
  "readiness_required_unavailable",
  "deployment_failure",
  "runner_overrun",
]);
const ARTIFACT_KEYS = Object.freeze([
  "alert_specs",
  "commit_sha",
  "evidence_sha256",
  "github_run_attempt",
  "github_run_id",
  "observability_phase",
  "plan_sha256",
]);
const REQUIRED_SPEC_KEYS = Object.freeze([
  "alarm_threshold",
  "category",
  "comparison",
  "evaluation_window",
  "metric",
  "notification_channel_id",
  "query",
  "title",
  "warning_threshold",
]);
const OPTIONAL_SPEC_KEYS = Object.freeze(["missing_data_behavior", "producer"]);
const SAFE_TERRAFORM_ADDRESS =
  /^(?:module\.[A-Za-z0-9_-]+\.)*(?:data\.)?[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\[[0-9]+\])?$/;

function invalid() {
  throw new Error("alert specs artifact input is invalid");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return (
    isPlainObject(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function isPositiveIntegerString(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function validateBinding(binding) {
  if (
    !hasExactKeys(
      binding,
      ARTIFACT_KEYS.filter((key) => key !== "alert_specs"),
    ) ||
    !/^[0-9a-f]{40}$/.test(binding.commit_sha ?? "") ||
    !/^[0-9a-f]{64}$/.test(binding.evidence_sha256 ?? "") ||
    !isPositiveIntegerString(binding.github_run_attempt) ||
    !isPositiveIntegerString(binding.github_run_id) ||
    binding.observability_phase !== "first" ||
    !/^[0-9a-f]{64}$/.test(binding.plan_sha256 ?? "")
  )
    invalid();
}

function validateAlertSpecs(specs) {
  if (!hasExactKeys(specs, CATEGORIES)) invalid();
  const canonical = {};
  for (const category of CATEGORIES) {
    const spec = specs[category];
    if (!isPlainObject(spec)) invalid();
    const keys = Object.keys(spec);
    if (
      !REQUIRED_SPEC_KEYS.every((key) => keys.includes(key)) ||
      keys.some((key) => !REQUIRED_SPEC_KEYS.includes(key) && !OPTIONAL_SPEC_KEYS.includes(key)) ||
      spec.category !== category ||
      !["GREATER_THAN", "LESS_THAN"].includes(spec.comparison) ||
      !Number.isFinite(spec.warning_threshold) ||
      !Number.isFinite(spec.alarm_threshold) ||
      typeof spec.evaluation_window !== "string" ||
      !/^[1-9][0-9]*[smhd]$/.test(spec.evaluation_window) ||
      spec.notification_channel_id !== null ||
      ![spec.title, spec.metric, spec.query].every(
        (value) => typeof value === "string" && value.length > 0,
      ) ||
      ("missing_data_behavior" in spec && !["ALARM", "OK"].includes(spec.missing_data_behavior)) ||
      ("producer" in spec && (typeof spec.producer !== "string" || spec.producer.length === 0))
    )
      invalid();
    canonical[category] = Object.fromEntries(
      [...REQUIRED_SPEC_KEYS, ...OPTIONAL_SPEC_KEYS]
        .filter((key) => key in spec)
        .map((key) => [key, spec[key]]),
    );
  }
  return canonical;
}

export function validateAlertSpecsArtifact(document) {
  if (!hasExactKeys(document, ARTIFACT_KEYS)) invalid();
  const { alert_specs: alertSpecs, ...binding } = document;
  validateBinding(binding);
  const canonical = { alert_specs: validateAlertSpecs(alertSpecs), ...binding };
  if (Buffer.byteLength(JSON.stringify(canonical)) > MAXIMUM_ARTIFACT_BYTES) invalid();
  return canonical;
}

export function extractAlertSpecsArtifact(input, binding) {
  if (typeof input !== "string" || Buffer.byteLength(input) > MAXIMUM_APPLY_BYTES) invalid();
  validateBinding(binding);
  let versionCount = 0;
  let applySummaryCount = 0;
  let outputsCount = 0;
  let alertSpecs;
  for (const line of input.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      invalid();
    }
    if (!isPlainObject(record) || typeof record.type !== "string") invalid();
    if (record.type === "version") {
      versionCount += 1;
      if (versionCount !== 1 || typeof record.ui !== "string" || !/^1(?:\.|$)/.test(record.ui))
        invalid();
    }
    if (record.type === "change_summary" && record.changes?.operation === "apply")
      applySummaryCount += 1;
    if (
      record.type === "apply_errored" ||
      (record.type === "diagnostic" && record["@level"] === "error")
    )
      invalid();
    if (record.type === "outputs") {
      outputsCount += 1;
      const output = record.outputs?.alert_specs;
      if (
        outputsCount !== 1 ||
        !hasExactKeys(output, ["sensitive", "type", "value"]) ||
        output.sensitive !== false
      )
        invalid();
      alertSpecs = validateAlertSpecs(output.value);
    }
  }
  if (versionCount !== 1 || applySummaryCount !== 1 || outputsCount !== 1 || !alertSpecs) invalid();
  return validateAlertSpecsArtifact({ alert_specs: alertSpecs, ...binding });
}

function classifyDiagnostic(summary) {
  if (typeof summary !== "string") return "terraform-error";
  if (/forbidden|permission denied|not authorized|unauthorized|access denied/i.test(summary))
    return "permission-denied";
  if (/timed? out|timeout|deadline exceeded/i.test(summary)) return "timeout";
  if (/quota|limit exceeded|resource exhausted/i.test(summary)) return "quota-exceeded";
  if (/conflict|already exists/i.test(summary)) return "conflict";
  if (/not found/i.test(summary)) return "not-found";
  if (/invalid|bad request/i.test(summary)) return "invalid-request";
  return "terraform-error";
}

export function diagnoseTerraformApplyFailure(input) {
  if (typeof input !== "string" || Buffer.byteLength(input) > MAXIMUM_APPLY_BYTES)
    return "Terraform apply failed: terraform-error";

  for (const line of input.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return "Terraform apply failed: terraform-error";
    }
    if (!isPlainObject(record)) return "Terraform apply failed: terraform-error";
    if (
      record.type !== "diagnostic" ||
      (record["@level"] !== "error" && record.diagnostic?.severity !== "error")
    )
      continue;

    const failureClass = classifyDiagnostic(record.diagnostic?.summary);
    const address = record.diagnostic?.address;
    if (typeof address === "string" && SAFE_TERRAFORM_ADDRESS.test(address))
      return `Terraform apply failed: ${failureClass} at ${address}`;
    return `Terraform apply failed: ${failureClass}`;
  }

  return "Terraform apply failed: terraform-error";
}

async function readBoundedInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAXIMUM_APPLY_BYTES) invalid();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function bindingFromEnvironment() {
  return {
    commit_sha: process.env.ALERT_SPECS_COMMIT_SHA,
    evidence_sha256: process.env.ALERT_SPECS_EVIDENCE_SHA256,
    github_run_attempt: process.env.ALERT_SPECS_GITHUB_RUN_ATTEMPT,
    github_run_id: process.env.ALERT_SPECS_GITHUB_RUN_ID,
    observability_phase: process.env.ALERT_SPECS_OBSERVABILITY_PHASE,
    plan_sha256: process.env.ALERT_SPECS_PLAN_SHA256,
  };
}

async function runCli() {
  const mode = process.argv[2];
  const input = await readBoundedInput();
  if (mode === "diagnose") {
    process.stderr.write(`${diagnoseTerraformApplyFailure(input)}\n`);
    return;
  }
  let artifact;
  if (mode === "extract") artifact = extractAlertSpecsArtifact(input, bindingFromEnvironment());
  else if (mode === "validate") {
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch {
      invalid();
    }
    artifact = validateAlertSpecsArtifact(parsed);
  } else invalid();
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  runCli().catch(() => {
    process.stderr.write("alert specs artifact input is invalid\n");
    process.exitCode = 1;
  });
