import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { load } from "js-yaml";

const WORKFLOW_URL = new URL("../../../.github/workflows/deploy-production.yml", import.meta.url);
const VBTECH_WORKFLOW_URL = new URL(
  "../../../.github/workflows/deploy-vbtech-production.yml",
  import.meta.url,
);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RELEASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const NEXT_RELEASE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const NEXT_IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;

function parseWorkflow(source) {
  const workflow = load(source);
  assert.ok(workflow && typeof workflow === "object" && !Array.isArray(workflow));
  return workflow;
}

function stepByName(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing workflow step: ${name}`);
  return step;
}

function normalizedShellCommands(run) {
  assert.equal(typeof run, "string");
  const commands = [];
  let command = "";

  for (const sourceLine of run.split("\n")) {
    const line = sourceLine.trim();
    if (!line) continue;
    const continued = line.endsWith("\\");
    const fragment = continued ? line.slice(0, -1).trimEnd() : line;
    command = command ? `${command} ${fragment}` : fragment;
    if (!continued) {
      commands.push(command);
      command = "";
    }
  }

  assert.equal(command, "", "shell command must not end with a continuation");
  return commands;
}

function assertDirectDeployWorkflow(source) {
  const workflow = parseWorkflow(source);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "release_run_id",
    "release_sha",
    "landing_demo_submission_state",
  ]);
  assert.deepEqual(Object.keys(workflow.jobs), ["deploy"]);
  const deploy = workflow.jobs.deploy;
  assert.equal(deploy["runs-on"], "ubuntu-latest");
  assert.equal(deploy.environment, "production-deploy");
  assert.deepEqual(deploy.permissions, {
    actions: "read",
    contents: "read",
    packages: "read",
  });
  assert.equal(deploy.env.YC_APP_DEPLOY_LOGIN, "markiro-deploy");
  assert.equal(deploy.env.YC_APP_PUBLIC_ADDRESS, "${{ vars.YC_APP_PUBLIC_ADDRESS }}");
  assert.equal(deploy.env.APP_SSH_HOST_KEYS_B64, "${{ vars.APP_SSH_HOST_KEYS_B64 }}");
  assert.equal(deploy.env.ACME_EMAIL, "${{ vars.ACME_EMAIL }}");
  assert.equal(deploy.env.MARKIRO_SAAS_ADMIN_DOMAIN, "${{ vars.MARKIRO_SAAS_ADMIN_DOMAIN }}");

  const checkout = deploy.steps.find((step) =>
    String(step.uses || "").startsWith("actions/checkout@"),
  );
  assert.ok(checkout);
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
  assert.equal(checkout.with.ref, "${{ steps.release.outputs.release-sha }}");
  assert.equal(checkout.with["persist-credentials"], false);

  const validation = stepByName(deploy, "Validate exact release").run;
  assert.match(validation, /release-manifest[.]mjs validate/);
  assert.doesNotMatch(validation, /rehearsal|cleanup|ALB/i);

  const delivery = stepByName(deploy, "Deploy immutable Compose bundle");
  assert.equal(delivery.env.GHCR_TOKEN, "${{ github.token }}");
  assert.equal(delivery.env.GHCR_USERNAME, "${{ github.actor }}");
  assert.equal(
    delivery.env.YC_APP_DEPLOY_SSH_PRIVATE_KEY,
    "${{ secrets.YC_APP_DEPLOY_SSH_PRIVATE_KEY }}",
  );
  assert.match(delivery.run, /printf '%s\\n' "\$YC_APP_DEPLOY_SSH_PRIVATE_KEY" > "\$key_path"/);
  assert.match(delivery.run, /chmod 600 "\$key_path"/);
  assert.match(delivery.run, /remote-deploy[.]mjs run/);
  assert.doesNotMatch(delivery.run, /curl|oidc|iam_token|hosted-deploy-context|serial|lockbox/i);

  const cleanup = stepByName(deploy, "Remove local deployment credentials");
  assert.equal(cleanup.if, "always()");
  assert.match(cleanup.run, /markiro-deploy-key/);

  const withoutComments = source.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(
    withoutComments,
    /id-token|workflow_run|self-hosted|production-controller|production-cleanup|rollback_rehearsal|rehearsal_run|YC_IAM|YC_LOAD_BALANCER|YC_BACKEND_GROUP|YC_TARGET_GROUP|YC_REGISTRY_SECRET|hosted-deploy-context|serial/i,
  );
}

function diagnosticService(release) {
  return {
    state: "running",
    health: "healthy",
    exitCode: 0,
    oomKilled: false,
    release,
    errorClasses: [],
    configurationIssues: [],
  };
}

function diagnosticSnapshot({
  activeRelease,
  activeVbtech,
  cpuBusyBasisPoints,
  memoryAvailableBytes,
  rootFilesystemAvailableBytes,
}) {
  return {
    version: 3,
    docker: "active",
    runtimeEnv: "active",
    activeRelease,
    candidateRelease: "unknown",
    composeNetwork: "markiro-production_default",
    resources: {
      cpuBusyBasisPoints,
      memoryTotalBytes: 8_000,
      memoryAvailableBytes,
      rootFilesystemTotalBytes: 20_000,
      rootFilesystemAvailableBytes,
    },
    activeVbtech,
    api: diagnosticService(activeRelease),
    edge: diagnosticService(activeRelease),
    vbtechWeb: diagnosticService(activeVbtech?.releaseSha ?? "unknown"),
  };
}

function heredoc(step, marker) {
  const match = step.run.match(new RegExp(`<<'${marker}'\\n([\\s\\S]*?)\\n${marker}(?:\\n|$)`));
  assert.ok(match, `${step.name} must contain the ${marker} program`);
  return match[1];
}

async function assertDiagnosticCanonicalizer(step) {
  const directory = await mkdtemp(join(tmpdir(), "markiro-vbtech-workflow-diagnostic-"));
  try {
    const input = join(directory, "diagnostic.line");
    const output = join(directory, "diagnostic.json");
    const snapshot = diagnosticSnapshot({
      activeRelease: RELEASE_SHA,
      activeVbtech: { releaseSha: RELEASE_SHA, imageDigest: IMAGE_DIGEST },
      cpuBusyBasisPoints: 3_500,
      memoryAvailableBytes: 4_000,
      rootFilesystemAvailableBytes: 12_000,
    });
    await writeFile(input, `MARKIRO_RUNTIME_DIAGNOSTICS ${JSON.stringify(snapshot)}\n`);
    const script = heredoc(step, "VALIDATE_RUNTIME_DIAGNOSTICS");
    const valid = spawnSync(process.execPath, ["--input-type=module", "-", input, output], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      input: script,
    });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, "");
    assert.equal(valid.stderr, "");
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), snapshot);

    const staleInput = join(directory, "stale.line");
    const staleOutput = join(directory, "stale.json");
    await writeFile(
      staleInput,
      `MARKIRO_RUNTIME_DIAGNOSTICS ${JSON.stringify({ ...snapshot, version: 2 })}\n`,
    );
    const stale = spawnSync(
      process.execPath,
      ["--input-type=module", "-", staleInput, staleOutput],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        input: script,
      },
    );
    assert.equal(stale.status, 1);
    assert.equal(stale.stdout, "");
    assert.equal(stale.stderr, "MARKIRO_RUNTIME_DIAGNOSTICS_FAILURE\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function emittedCapacityDelta(step) {
  const directory = await mkdtemp(join(tmpdir(), "markiro-vbtech-workflow-capacity-"));
  try {
    const beforePath = join(directory, "before.json");
    const afterPath = join(directory, "after.json");
    await Promise.all([
      writeFile(
        beforePath,
        `${JSON.stringify(
          diagnosticSnapshot({
            activeRelease: RELEASE_SHA,
            activeVbtech: { releaseSha: RELEASE_SHA, imageDigest: IMAGE_DIGEST },
            cpuBusyBasisPoints: 4_000,
            memoryAvailableBytes: 3_000,
            rootFilesystemAvailableBytes: 12_000,
          }),
        )}\n`,
      ),
      writeFile(
        afterPath,
        `${JSON.stringify(
          diagnosticSnapshot({
            activeRelease: NEXT_RELEASE_SHA,
            activeVbtech: { releaseSha: NEXT_RELEASE_SHA, imageDigest: NEXT_IMAGE_DIGEST },
            cpuBusyBasisPoints: 4_750,
            memoryAvailableBytes: 2_500,
            rootFilesystemAvailableBytes: 12_250,
          }),
        )}\n`,
      ),
    ]);
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-", beforePath, afterPath],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        input: heredoc(step, "EMIT_CAPACITY_DELTA"),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const match = result.stdout.match(/^MARKIRO_VBTECH_CAPACITY_DELTA (\{[^\n]+\})\n$/);
    assert.ok(match, "capacity delta must be exactly one bounded JSON line");
    assert.ok(Buffer.byteLength(match[1], "utf8") <= 4 * 1024);
    return JSON.parse(match[1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertPrivateVbtechDeployWorkflow(source, { executePrograms = true } = {}) {
  const workflow = parseWorkflow(source);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), [
    "vbtech_release_sha",
    "vbtech_image_digest",
    "confirm_private_deploy",
  ]);
  assert.equal(inputs.vbtech_release_sha.required, true);
  assert.equal(inputs.vbtech_release_sha.type, "string");
  assert.equal(inputs.vbtech_image_digest.required, true);
  assert.equal(inputs.vbtech_image_digest.type, "string");
  assert.equal(inputs.confirm_private_deploy.required, true);
  assert.equal(inputs.confirm_private_deploy.type, "boolean");
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.concurrency, {
    group: "markiro-production-deployment",
    "cancel-in-progress": false,
  });
  assert.deepEqual(Object.keys(workflow.jobs), ["deploy"]);

  const deploy = workflow.jobs.deploy;
  assert.equal(deploy["runs-on"], "ubuntu-latest");
  assert.equal(deploy.environment, "production-deploy");
  assert.deepEqual(deploy.permissions, {
    attestations: "read",
    contents: "read",
    packages: "read",
  });
  assert.ok(Number.isSafeInteger(deploy["timeout-minutes"]));
  assert.ok(deploy["timeout-minutes"] > 0 && deploy["timeout-minutes"] <= 60);
  assert.deepEqual(deploy.env, {
    YC_APP_PUBLIC_ADDRESS: "${{ vars.YC_APP_PUBLIC_ADDRESS }}",
    APP_SSH_HOST_KEYS_B64: "${{ vars.APP_SSH_HOST_KEYS_B64 }}",
    MARKIRO_DOMAIN: "${{ vars.MARKIRO_DOMAIN }}",
    MARKIRO_SAAS_ADMIN_DOMAIN: "${{ vars.MARKIRO_SAAS_ADMIN_DOMAIN }}",
    MARKIRO_KIOSK_DOMAIN: "${{ vars.MARKIRO_KIOSK_DOMAIN }}",
    MARKIRO_LANDING_DOMAIN: "${{ vars.MARKIRO_LANDING_DOMAIN }}",
    YC_APP_DEPLOY_LOGIN: "markiro-deploy",
    YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH: "${{ runner.temp }}/vbtech-deploy-key",
  });

  for (const step of deploy.steps.filter((candidate) => candidate.uses))
    assert.match(step.uses, /^[^@]+@[0-9a-f]{40}$/);
  const checkouts = deploy.steps.filter((step) =>
    String(step.uses || "").startsWith("actions/checkout@"),
  );
  assert.equal(checkouts.length, 2);
  assert.deepEqual(checkouts[0].with, {
    ref: "${{ github.sha }}",
    "fetch-depth": 1,
    "persist-credentials": false,
  });
  assert.deepEqual(checkouts[1].with, {
    repository: "thevladbog/v-b",
    ref: "${{ inputs.vbtech_release_sha }}",
    path: "vbtech-source",
    "fetch-depth": 1,
    "persist-credentials": false,
  });

  const preflight = stepByName(deploy, "Validate private deploy request");
  assert.deepEqual(preflight.env, {
    CONFIRM_PRIVATE_DEPLOY: "${{ inputs.confirm_private_deploy }}",
    VBTECH_RELEASE_SHA: "${{ inputs.vbtech_release_sha }}",
    VBTECH_IMAGE_DIGEST: "${{ inputs.vbtech_image_digest }}",
  });
  assert.ok(
    deploy.if === "${{ inputs.confirm_private_deploy == true }}" ||
      /\[\[ "\$CONFIRM_PRIVATE_DEPLOY" == "true" \]\]/.test(preflight.run),
  );
  const preflightCommands = normalizedShellCommands(preflight.run);
  assert.deepEqual(preflightCommands, [
    "set -euo pipefail",
    '[[ "$CONFIRM_PRIVATE_DEPLOY" == "true" ]]',
    '[[ "$VBTECH_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "$VBTECH_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
  ]);

  const verification = stepByName(deploy, "Verify exact attested v-b image");
  assert.deepEqual(verification.env, {
    DOCKER_CONFIG: "${{ runner.temp }}/vbtech-docker-config",
    GH_TOKEN: "${{ github.token }}",
    GHCR_TOKEN: "${{ github.token }}",
    GHCR_USERNAME: "${{ github.actor }}",
    VBTECH_IMAGE_DIGEST: "${{ inputs.vbtech_image_digest }}",
    VBTECH_RELEASE_SHA: "${{ inputs.vbtech_release_sha }}",
  });
  assert.match(
    verification.run,
    /image_ref="ghcr[.]io\/thevladbog\/vbtech-web@\$VBTECH_IMAGE_DIGEST"/,
  );
  const verificationCommands = normalizedShellCommands(verification.run);
  const attestationCommands = verificationCommands.filter((command) =>
    command.startsWith("gh attestation verify "),
  );
  const manifestCommands = verificationCommands.filter((command) =>
    command.startsWith("docker manifest inspect "),
  );
  assert.equal(attestationCommands.length, 1, "exactly one attestation command is required");
  assert.equal(manifestCommands.length, 1, "exactly one manifest command is required");
  const [attestationCommand] = attestationCommands;
  const [manifestCommand] = manifestCommands;
  for (const flag of ["--repo", "--signer-workflow", "--source-digest", "--source-ref"]) {
    assert.equal(
      [...attestationCommand.matchAll(new RegExp(`(?:^|\\s)${flag}(?=\\s|$)`, "g"))].length,
      1,
      `${flag} must occur exactly once`,
    );
  }
  assert.match(
    attestationCommand,
    /(?:^|\s)--signer-workflow thevladbog\/v-b\/\.github\/workflows\/publish\.yml(?=\s|$)/,
  );
  assert.equal(
    attestationCommand,
    'gh attestation verify "oci://$image_ref" --repo thevladbog/v-b --signer-workflow thevladbog/v-b/.github/workflows/publish.yml --source-digest "$VBTECH_RELEASE_SHA" --source-ref refs/heads/main > /dev/null',
  );
  assert.equal(manifestCommand, 'docker manifest inspect "$image_ref" > /dev/null');
  assert.doesNotMatch(
    [...preflightCommands.slice(1), attestationCommand, manifestCommand].join("\n"),
    /\|\||&&|;/,
    "security gates must not contain fail-open operators",
  );
  assert.ok(
    verificationCommands.indexOf(attestationCommand) <
      verificationCommands.indexOf(manifestCommand),
  );

  const keyCreation = stepByName(deploy, "Create protected SSH identity");
  const keyCreationIndex = deploy.steps.indexOf(keyCreation);
  assert.doesNotMatch(
    deploy.steps
      .slice(0, keyCreationIndex)
      .map((step) => step.run ?? "")
      .join("\n"),
    /YC_APP_DEPLOY_SSH_PRIVATE_KEY|vbtech-deploy-key|chmod\s+600/,
    "SSH key material must not be used before attestation and manifest verification succeed",
  );
  assert.deepEqual(keyCreation.env, {
    YC_APP_DEPLOY_SSH_PRIVATE_KEY: "${{ secrets.YC_APP_DEPLOY_SSH_PRIVATE_KEY }}",
  });
  assert.match(
    keyCreation.run,
    /printf '%s\\n' "\$YC_APP_DEPLOY_SSH_PRIVATE_KEY" > "\$YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH"/,
  );
  assert.match(keyCreation.run, /chmod 600 "\$YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH"/);

  const before = stepByName(deploy, "Capture before runtime diagnostics");
  const delivery = stepByName(deploy, "Deploy private v-b image");
  const after = stepByName(deploy, "Capture after runtime diagnostics");
  const capacity = stepByName(deploy, "Emit bounded capacity delta");
  const cleanup = stepByName(deploy, "Remove local deployment credentials");
  const indexes = [preflight, verification, keyCreation, before, delivery, after, capacity].map(
    (step) => deploy.steps.indexOf(step),
  );
  assert.deepEqual(
    indexes,
    indexes.toSorted((left, right) => left - right),
  );

  for (const diagnostic of [before, after]) {
    assert.equal(
      [...diagnostic.run.matchAll(/node deploy\/yandex\/runtime-diagnostics[.]mjs run/g)].length,
      1,
    );
    assert.match(diagnostic.run, /validateRuntimeSnapshot/);
    assert.match(diagnostic.run, /snapshot[.]version !== 3/);
    assert.match(diagnostic.run, /16 \* 1024/);
    if (executePrograms) await assertDiagnosticCanonicalizer(diagnostic);
  }

  assert.deepEqual(delivery.env, {
    GHCR_USERNAME: "${{ github.actor }}",
    GHCR_TOKEN: "${{ github.token }}",
    VBTECH_RELEASE_SHA: "${{ inputs.vbtech_release_sha }}",
    VBTECH_IMAGE_DIGEST: "${{ inputs.vbtech_image_digest }}",
  });
  assert.match(delivery.run, /submission_state=disabled/);
  assert.deepEqual(
    [...delivery.run.matchAll(/node deploy\/yandex\/[a-z-]+[.]mjs run/g)].map((match) => match[0]),
    ["node deploy/yandex/remote-vbtech-deploy.mjs run"],
  );
  assert.equal(
    [...source.matchAll(/node deploy\/yandex\/remote-vbtech-deploy[.]mjs run/g)].length,
    1,
  );
  assert.doesNotMatch(delivery.run, /remote-deploy[.]mjs|scp|rsync|tar\s|ssh\s|curl\s/i);

  assert.match(capacity.run, /beforeRelease:/);
  assert.match(capacity.run, /afterRelease:/);
  assert.match(capacity.run, /cpuBusyBasisPointsDelta(?:,|:)/);
  assert.match(capacity.run, /memoryAvailableBytesDelta(?:,|:)/);
  assert.match(capacity.run, /rootFilesystemAvailableBytesDelta(?:,|:)/);
  assert.doesNotMatch(
    capacity.run,
    /threshold|recommendation|automaticDecision|rawSnapshot|ipAddress|containerLogs|processArguments|environmentInventory/i,
  );
  if (executePrograms) {
    assert.deepEqual(await emittedCapacityDelta(capacity), {
      beforeRelease: {
        markiroReleaseSha: RELEASE_SHA,
        vbtechReleaseSha: RELEASE_SHA,
        vbtechImageDigest: IMAGE_DIGEST,
      },
      afterRelease: {
        markiroReleaseSha: NEXT_RELEASE_SHA,
        vbtechReleaseSha: NEXT_RELEASE_SHA,
        vbtechImageDigest: NEXT_IMAGE_DIGEST,
      },
      cpuBusyBasisPointsDelta: 750,
      memoryAvailableBytesDelta: -500,
      rootFilesystemAvailableBytesDelta: 250,
    });
  }

  assert.equal(cleanup.if, "always()");
  assert.match(cleanup.run, /rm -f --[\s\S]*"\$RUNNER_TEMP\/vbtech-deploy-key"/);
  assert.match(cleanup.run, /rm -rf -- "\$RUNNER_TEMP\/vbtech-docker-config"/);
  assert.match(cleanup.run, /vbtech-before[.]json/);
  assert.match(cleanup.run, /vbtech-after[.]json/);

  const withoutComments = source.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(
    withoutComments,
    /workflow_run|self-hosted|id-token:\s*write|\byc\s+(?:compute|dns|iam|lockbox|vpc|serverless|storage)|terraform|psql|postgres(?:ql)?|cloud function|function create|lockbox|bucket|service-account|smartcaptcha|postbox|external form|hosted-deploy-context|\bserial\b|scp|rsync/i,
  );
}

test("production deploy is one ordinary protected SSH job without Yandex control plane", async () => {
  assertDirectDeployWorkflow(await readFile(WORKFLOW_URL, "utf8"));
});

test("direct deploy workflow rejects automatic, unpinned and credential-unsafe mutations", async () => {
  const source = await readFile(WORKFLOW_URL, "utf8");
  const mutations = [
    [
      "automatic trigger",
      source.replace("  workflow_dispatch:", "  workflow_run:\n  workflow_dispatch:"),
    ],
    ["self hosted", source.replace("runs-on: ubuntu-latest", "runs-on: self-hosted")],
    ["OIDC", source.replace("contents: read", "contents: read\n      id-token: write")],
    [
      "unpinned checkout",
      source.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@main"),
    ],
    ["conditional cleanup", source.replace("if: always()", "if: success()")],
    [
      "wrong checkout",
      source.replace("${{ steps.release.outputs.release-sha }}", "${{ github.sha }}"),
    ],
  ];
  for (const [name, mutation] of mutations) {
    assert.notEqual(mutation, source, `${name} mutation must change the workflow`);
    assert.throws(() => assertDirectDeployWorkflow(mutation), undefined, name);
  }
});

test("private v-b deploy verifies one attested image before protected SSH execution", async () => {
  await assertPrivateVbtechDeployWorkflow(await readFile(VBTECH_WORKFLOW_URL, "utf8"));
});

test("private v-b deploy rejects trust, evidence, and mutation-boundary regressions", async () => {
  const source = await readFile(VBTECH_WORKFLOW_URL, "utf8");
  const mutations = [
    [
      "automatic trigger",
      (value) => value.replace("  workflow_dispatch:", "  workflow_run:\n  workflow_dispatch:"),
    ],
    ["renamed input", (value) => value.replace("vbtech_image_digest:", "image_digest:")],
    [
      "optional confirmation",
      (value) =>
        value.replace(/(confirm_private_deploy:\n(?:.*\n){0,4}?\s+required:) true/, "$1 false"),
    ],
    [
      "ignored confirmation",
      (value) =>
        value
          .replace("    if: ${{ inputs.confirm_private_deploy == true }}\n", "")
          .replace('[[ "$CONFIRM_PRIVATE_DEPLOY" == "true" ]]', "true"),
    ],
    [
      "top-level write permission",
      (value) => value.replace("permissions: {}", "permissions:\n  contents: write"),
    ],
    [
      "self-hosted runner",
      (value) => value.replace("runs-on: ubuntu-latest", "runs-on: self-hosted"),
    ],
    [
      "unprotected environment",
      (value) => value.replace("environment: production-deploy", "environment: staging"),
    ],
    [
      "attestation write permission",
      (value) => value.replace("attestations: read", "attestations: write"),
    ],
    [
      "different concurrency",
      (value) => value.replace("group: markiro-production-deployment", "group: vbtech-deployment"),
    ],
    [
      "cancellable deployment",
      (value) => value.replace("cancel-in-progress: false", "cancel-in-progress: true"),
    ],
    [
      "unbounded timeout",
      (value) => value.replace(/timeout-minutes: [0-9]+/, "timeout-minutes: 0"),
    ],
    [
      "unpinned action",
      (value) => value.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@main"),
    ],
    [
      "foreign source repository",
      (value) => value.replace("repository: thevladbog/v-b", "repository: attacker/v-b"),
    ],
    [
      "wrong source checkout",
      (value) => value.replace("ref: ${{ inputs.vbtech_release_sha }}", "ref: refs/heads/main"),
    ],
    ["uppercase SHA accepted", (value) => value.replace("^[0-9a-f]{40}$", "^[0-9A-Fa-f]{40}$")],
    [
      "uppercase digest accepted",
      (value) => value.replace("^sha256:[0-9a-f]{64}$", "^sha256:[0-9A-Fa-f]{64}$"),
    ],
    [
      "digest validation fail-open",
      (value) =>
        value.replace(
          '[[ "$VBTECH_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
          '[[ "$VBTECH_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || true',
        ),
    ],
    [
      "foreign image",
      (value) => value.replace("ghcr.io/thevladbog/vbtech-web", "ghcr.io/attacker/vbtech-web"),
    ],
    [
      "foreign signer",
      (value) =>
        value.replace(
          "thevladbog/v-b/.github/workflows/publish.yml",
          "attacker/v-b/.github/workflows/publish.yml",
        ),
    ],
    [
      "signer suffix",
      (value) =>
        value.replace(
          "thevladbog/v-b/.github/workflows/publish.yml",
          "thevladbog/v-b/.github/workflows/publish.yml.evil",
        ),
    ],
    [
      "unbound source digest",
      (value) =>
        value.replace('--source-digest "$VBTECH_RELEASE_SHA"', '--source-digest "$GITHUB_SHA"'),
    ],
    [
      "unbound source ref",
      (value) => value.replace("--source-ref refs/heads/main", "--source-ref refs/heads/dev"),
    ],
    [
      "attestation verification fail-open",
      (value) =>
        value.replace(
          "--source-ref refs/heads/main > /dev/null",
          "--source-ref refs/heads/main > /dev/null || true",
        ),
    ],
    ["non-OCI subject", (value) => value.replace('"oci://$image_ref"', '"$image_ref"')],
    [
      "tag-style availability",
      (value) => value.replace("docker manifest inspect", "docker image inspect"),
    ],
    [
      "manifest availability fail-open",
      (value) =>
        value.replace(
          'docker manifest inspect "$image_ref" > /dev/null',
          'docker manifest inspect "$image_ref" > /dev/null || true',
        ),
    ],
    [
      "early SSH key",
      (value) =>
        value.replace(
          "      - name: Verify exact attested v-b image",
          '      - name: Create early SSH identity\n        run: printf x > "$RUNNER_TEMP/vbtech-deploy-key"\n\n      - name: Verify exact attested v-b image',
        ),
    ],
    [
      "SSH key inside verification",
      (value) =>
        value.replace(
          '          docker manifest inspect "$image_ref" > /dev/null',
          '          printf x > "$RUNNER_TEMP/vbtech-deploy-key"\n          docker manifest inspect "$image_ref" > /dev/null',
        ),
    ],
    [
      "stale diagnostics",
      (value) => value.replace("snapshot.version !== 3", "snapshot.version !== 2"),
    ],
    [
      "wrong diagnostic command",
      (value) => value.replace("runtime-diagnostics.mjs run", "runtime-diagnostics.mjs inspect"),
    ],
    [
      "generic remote deploy",
      (value) => value.replace("remote-vbtech-deploy.mjs run", "remote-deploy.mjs run"),
    ],
    [
      "enabled submission",
      (value) => value.replace("submission_state=disabled", "submission_state=enabled"),
    ],
    [
      "capacity recommendation",
      (value) =>
        value.replace(
          "rootFilesystemAvailableBytesDelta,",
          'rootFilesystemAvailableBytesDelta,\n        recommendation: "resize",',
        ),
    ],
    ["conditional cleanup", (value) => value.replace("if: always()", "if: success()")],
    [
      "SSH key retained",
      (value) => value.replace('            "$RUNNER_TEMP/vbtech-deploy-key" \\\n', ""),
    ],
    [
      "registry auth retained",
      (value) =>
        value.replace('          rm -rf -- "$RUNNER_TEMP/vbtech-docker-config"', "          true"),
    ],
    [
      "Yandex control plane",
      (value) =>
        value.replace(
          "node deploy/yandex/remote-vbtech-deploy.mjs run",
          "yc dns zone list\n          node deploy/yandex/remote-vbtech-deploy.mjs run",
        ),
    ],
    [
      "code transfer bypass",
      (value) =>
        value.replace(
          "node deploy/yandex/remote-vbtech-deploy.mjs run",
          "scp deploy/production/vbtech-deploy.mjs host:/tmp/\n          node deploy/yandex/remote-vbtech-deploy.mjs run",
        ),
    ],
  ];
  for (const [name, mutate] of mutations) {
    const mutation = mutate(source);
    assert.notEqual(mutation, source, `${name} mutation must change the workflow`);
    await assert.rejects(
      () => assertPrivateVbtechDeployWorkflow(mutation, { executePrograms: false }),
      undefined,
      name,
    );
  }
});

test("remote deploy executable emits one bounded configuration diagnostic", () => {
  const executable = fileURLToPath(new URL("../remote-deploy.mjs", import.meta.url));
  const privateValue = "should-never-appear-from-hosted-runner";
  const result = spawnSync(process.execPath, [executable, "run"], {
    encoding: "utf8",
    env: {
      RELEASE_MANIFEST_PATH: `/runner/${privateValue}.json`,
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "MARKIRO_DEPLOY_FAILURE configuration\n");
  assert.equal(`${result.stdout}${result.stderr}`.includes(privateValue), false);
});
