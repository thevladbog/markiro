import assert from "node:assert/strict";
import test from "node:test";

import {
  extractAlertSpecsArtifact,
  validateAlertSpecsArtifact,
} from "../scripts/extract-alert-specs.mjs";

const categories = [
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
];
const binding = Object.freeze({
  commit_sha: "1".repeat(40),
  evidence_sha256: "2".repeat(64),
  github_run_attempt: "3",
  github_run_id: "456",
  observability_phase: "first",
  plan_sha256: "4".repeat(64),
});

function spec(category, overrides = {}) {
  return {
    category,
    title: `Alert ${category}`,
    metric: `markiro.${category}`,
    query: `markiro.${category}{service="custom"}`,
    comparison: "GREATER_THAN",
    warning_threshold: 1,
    alarm_threshold: 2,
    evaluation_window: "5m",
    notification_channel_id: null,
    ...overrides,
  };
}

function alertSpecs() {
  return Object.fromEntries(categories.map((category) => [category, spec(category)]));
}

function applyRecords(specs = alertSpecs()) {
  return [
    {
      "@level": "info",
      "@message": "Terraform 1.15.8",
      "@module": "terraform.ui",
      "@timestamp": "2026-08-05T00:00:00Z",
      terraform: "1.15.8",
      type: "version",
      ui: "1.2",
    },
    {
      "@level": "info",
      "@message": "Apply complete",
      "@module": "terraform.ui",
      "@timestamp": "2026-08-05T00:01:00Z",
      changes: { add: 1, change: 0, remove: 0, operation: "apply" },
      type: "change_summary",
    },
    {
      "@level": "info",
      "@message": "Outputs: 2",
      "@module": "terraform.ui",
      "@timestamp": "2026-08-05T00:01:01Z",
      outputs: {
        alert_specs: { sensitive: false, type: ["object", {}], value: specs },
        unrelated_private_address: { sensitive: false, type: "string", value: "10.0.0.7" },
      },
      type: "outputs",
    },
  ];
}

function ndjson(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

test("extracts only the strict 16 alert specs and evidence bindings from apply JSON", () => {
  const artifact = extractAlertSpecsArtifact(ndjson(applyRecords()), binding);

  assert.deepEqual(Object.keys(artifact).sort(), [
    "alert_specs",
    "commit_sha",
    "evidence_sha256",
    "github_run_attempt",
    "github_run_id",
    "observability_phase",
    "plan_sha256",
  ]);
  assert.deepEqual(Object.keys(artifact.alert_specs), categories);
  assert.equal(
    artifact.alert_specs.readiness_required_unavailable.category,
    "readiness_required_unavailable",
  );
  assert.equal(artifact.alert_specs.vm_memory.notification_channel_id, null);
  assert.equal(artifact.commit_sha, "1".repeat(40));
  assert.equal(artifact.evidence_sha256, "2".repeat(64));
  assert.equal(artifact.plan_sha256, "4".repeat(64));
  assert.equal(JSON.stringify(artifact).includes("unrelated_private_address"), false);
  assert.equal(JSON.stringify(artifact).includes("10.0.0.7"), false);
});

test("rejects missing, duplicate, sensitive, or unsupported Terraform output streams", () => {
  const valid = applyRecords();
  for (const records of [
    valid.slice(0, 2),
    [...valid, valid.at(-1)],
    valid.map((record) =>
      record.type === "outputs"
        ? {
            ...record,
            outputs: {
              ...record.outputs,
              alert_specs: { ...record.outputs.alert_specs, sensitive: true },
            },
          }
        : record,
    ),
    valid.map((record) => (record.type === "version" ? { ...record, ui: "2.0" } : record)),
    valid.filter((record) => record.type !== "change_summary"),
    [...valid.slice(0, 1), { type: "apply_errored" }, ...valid.slice(1)],
  ]) {
    assert.throws(
      () => extractAlertSpecsArtifact(ndjson(records), binding),
      /alert specs artifact input is invalid/,
    );
  }
});

test("rejects missing, extra, mismatched, or unsafe alert specifications", () => {
  const complete = alertSpecs();
  const { runner_overrun: _runnerOverrun, ...missing } = complete;
  for (const specs of [
    missing,
    { ...complete, extra_alert: spec("extra_alert") },
    { ...complete, vm_cpu: spec("wrong_category") },
    { ...complete, vm_disk: spec("vm_disk", { notification_channel_id: "fake-channel" }) },
    { ...complete, alb_5xx: spec("alb_5xx", { unexpected: "field" }) },
    { ...complete, alb_latency: spec("alb_latency", { alarm_threshold: Number.NaN }) },
    {
      ...complete,
      alb_healthy_backend: spec("alb_healthy_backend", { title: "x".repeat(256 * 1024) }),
    },
  ]) {
    assert.throws(
      () => extractAlertSpecsArtifact(ndjson(applyRecords(specs)), binding),
      /alert specs artifact input is invalid/,
    );
  }
});

test("rejects malformed binding metadata and artifact extra fields", () => {
  for (const invalidBinding of [
    { ...binding, commit_sha: "short" },
    { ...binding, evidence_sha256: "bad" },
    { ...binding, github_run_id: "0" },
    { ...binding, github_run_attempt: "attempt" },
    { ...binding, observability_phase: "protected" },
    { ...binding, plan_sha256: "bad" },
  ]) {
    assert.throws(
      () => extractAlertSpecsArtifact(ndjson(applyRecords()), invalidBinding),
      /alert specs artifact input is invalid/,
    );
  }

  const artifact = extractAlertSpecsArtifact(ndjson(applyRecords()), binding);
  assert.throws(
    () => validateAlertSpecsArtifact({ ...artifact, another_output: "forbidden" }),
    /alert specs artifact input is invalid/,
  );
});

test("rejects malformed or oversized apply streams without echoing their contents", () => {
  for (const input of ["not-json\n", `${"x".repeat(32 * 1024 * 1024 + 1)}\n`]) {
    assert.throws(
      () => extractAlertSpecsArtifact(input, binding),
      (error) => {
        assert.match(error.message, /alert specs artifact input is invalid/);
        assert.doesNotMatch(error.message, /not-json|xxxxx/);
        return true;
      },
    );
  }
});
