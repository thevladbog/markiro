import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";

const CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const PNPM_SETUP = "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1";
const NODE_SETUP = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const BUILDX = "docker/setup-buildx-action@e468171a9de216ec08956ac3ada2f0791b6bd435";
const LOGIN = "docker/login-action@184bdaa0721073962dff0199f1fb9940f07167d1";
const BUILD_PUSH = "docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83";
const COMPOSE =
  'docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml -f deploy/production/compose.ci.yml';

const GENERATE_ENVIRONMENT =
  [
    "set -euo pipefail",
    'better_auth_secret="$(openssl rand -base64 48)"',
    'pairing_code_pepper="$(openssl rand -hex 32)"',
    'mail_payload_key="$(openssl rand -base64 32)"',
    'smtp_user="markiro-ci"',
    'smtp_password="$(openssl rand -hex 24)"',
    'database_url="postgresql://markiro:markiro@postgres:5432/markiro"',
    "for credential in \\",
    '  "$better_auth_secret" \\',
    '  "$pairing_code_pepper" \\',
    '  "$mail_payload_key" \\',
    '  "$smtp_user" \\',
    '  "$smtp_password" \\',
    '  "$database_url" \\',
    '  "markiro" \\',
    '  "markiro-development-only"; do',
    '  echo "::add-mask::$credential"',
    "done",
    "umask 077",
    "{",
    `  printf '%s\\n' "DATABASE_URL=$database_url"`,
    `  printf '%s\\n' "BETTER_AUTH_SECRET=$better_auth_secret"`,
    `  printf '%s\\n' "BETTER_AUTH_URL=https://localhost:18443"`,
    `  printf '%s\\n' "ADMIN_ORIGIN=https://localhost:18443"`,
    `  printf '%s\\n' "KIOSK_ORIGIN=https://localhost:18443"`,
    `  printf '%s\\n' "PAIRING_CODE_PEPPER=$pairing_code_pepper"`,
    `  printf '%s\\n' "SMTP_HOST=mailpit"`,
    `  printf '%s\\n' "SMTP_PORT=1025"`,
    `  printf '%s\\n' "SMTP_SECURE=false"`,
    `  printf '%s\\n' "SMTP_USER=$smtp_user"`,
    `  printf '%s\\n' "SMTP_PASSWORD=$smtp_password"`,
    `  printf '%s\\n' "SMTP_FROM_EMAIL=no-reply@markiro.local"`,
    `  printf '%s\\n' "SMTP_FROM_NAME=Markiro CI"`,
    `  printf '%s\\n' "SMTP_REPLY_TO="`,
    `  printf '%s\\n' "MAIL_PAYLOAD_ENCRYPTION_KEY=$mail_payload_key"`,
    `  printf '%s\\n' "S3_ENDPOINT=http://minio:9000"`,
    `  printf '%s\\n' "S3_REGION=us-east-1"`,
    `  printf '%s\\n' "S3_BUCKET=markiro-private"`,
    `  printf '%s\\n' "S3_ACCESS_KEY_ID=markiro"`,
    `  printf '%s\\n' "S3_SECRET_ACCESS_KEY=markiro-development-only"`,
    `  printf '%s\\n' "S3_FORCE_PATH_STYLE=true"`,
    '} > "$MARKIRO_ENV_FILE"',
    'chmod 600 "$MARKIRO_ENV_FILE"',
  ].join("\n") + "\n";

const PRODUCTION_BUNDLE_ENV = {
  MARKIRO_IMAGE_TAG: "${{ github.sha }}",
  MARKIRO_API_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
  MARKIRO_EDGE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  MARKIRO_DOMAIN: "localhost",
  MARKIRO_HTTP_PORT: "18080",
  MARKIRO_HTTPS_PORT: "18443",
  ACME_EMAIL: "ci@markiro.local",
};

const PRODUCTION_BUNDLE_STEPS = [
  { uses: CHECKOUT, with: { "persist-credentials": false } },
  { uses: PNPM_SETUP },
  { uses: NODE_SETUP, with: { "node-version": 24, cache: "pnpm" } },
  { run: "pnpm install --frozen-lockfile" },
  {
    name: "Define temporary production environment path",
    run: 'echo "MARKIRO_ENV_FILE=$RUNNER_TEMP/markiro-production-test.env" >> "$GITHUB_ENV"',
  },
  { name: "Verify production bundle contracts", run: "pnpm test:production-bundle:contract" },
  { name: "Generate masked test-only environment", run: GENERATE_ENVIRONMENT },
  {
    name: "Build local SHA-tagged production images",
    run:
      'docker build --file deploy/production/api.Dockerfile --tag "ghcr.io/thevladbog/markiro-api:${{ github.sha }}" .\n' +
      'docker build --file deploy/production/edge.Dockerfile --tag "ghcr.io/thevladbog/markiro-edge:${{ github.sha }}" .\n',
  },
  { name: "Validate the production bundle", run: "node deploy/production/preflight.mjs" },
  {
    name: "Start production-bundle dependencies",
    run: `${COMPOSE} up -d --wait --wait-timeout 120 postgres mailpit minio`,
  },
  { name: "Initialize the test bucket", run: `${COMPOSE} run --rm minio-init` },
  {
    name: "Run production migrations twice",
    run: `${COMPOSE} run --rm migrate\n${COMPOSE} run --rm migrate\n`,
  },
  {
    name: "Start the API and edge",
    run: `${COMPOSE} up -d --wait --wait-timeout 120 --no-deps api edge`,
  },
  {
    name: "Smoke the production bundle",
    env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    run: "MARKIRO_SMOKE_CI_OVERLAY=1 SMOKE_ASSERT_SHUTDOWN=1 node deploy/production/smoke.mjs",
  },
  {
    name: "Show sanitized production-bundle logs on failure",
    if: "failure()",
    run: `${COMPOSE} logs --no-color`,
  },
  {
    name: "Remove production-bundle containers and volumes",
    if: "always()",
    run: `${COMPOSE} down --volumes --remove-orphans`,
  },
];

const RELEASE_STEPS = [
  { uses: CHECKOUT, with: { "persist-credentials": false } },
  { uses: BUILDX },
  {
    uses: LOGIN,
    with: {
      registry: "ghcr.io",
      username: "${{ github.actor }}",
      password: "${{ secrets.GITHUB_TOKEN }}",
    },
  },
  {
    name: "Publish API SHA tag",
    id: "api-image",
    uses: BUILD_PUSH,
    with: {
      context: ".",
      file: "deploy/production/api.Dockerfile",
      push: true,
      tags: "ghcr.io/thevladbog/markiro-api:${{ github.sha }}",
    },
  },
  {
    name: "Publish edge SHA tag",
    id: "edge-image",
    uses: BUILD_PUSH,
    with: {
      context: ".",
      file: "deploy/production/edge.Dockerfile",
      push: true,
      tags: "ghcr.io/thevladbog/markiro-edge:${{ github.sha }}",
    },
  },
  {
    name: "Record trusted image digest evidence",
    env: {
      RELEASE_SHA: "${{ github.sha }}",
      API_DIGEST: "${{ steps.api-image.outputs.digest }}",
      EDGE_DIGEST: "${{ steps.edge-image.outputs.digest }}",
    },
    run:
      "set -euo pipefail\n" +
      'release_sha="$RELEASE_SHA"\n' +
      'api_digest="$API_DIGEST"\n' +
      'edge_digest="$EDGE_DIGEST"\n' +
      '[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]]\n' +
      '[[ "$api_digest" =~ ^sha256:[0-9a-f]{64}$ ]]\n' +
      '[[ "$edge_digest" =~ ^sha256:[0-9a-f]{64}$ ]]\n' +
      "{\n" +
      "  printf '### Markiro production image evidence\\n\\n'\n" +
      "  printf -- '- Commit SHA: `%s`\\n' \"$release_sha\"\n" +
      "  printf -- '- API: `ghcr.io/thevladbog/markiro-api@%s`\\n' \"$api_digest\"\n" +
      "  printf -- '- Edge: `ghcr.io/thevladbog/markiro-edge@%s`\\n' \"$edge_digest\"\n" +
      '} >> "$GITHUB_STEP_SUMMARY"\n',
  },
];

async function source(path) {
  return readFile(path, "utf8");
}

function parseWorkflow(workflowSource, label) {
  let workflow;
  assert.doesNotThrow(() => {
    workflow = load(workflowSource);
  }, `${label} must be valid YAML`);
  assert.ok(
    workflow && typeof workflow === "object" && !Array.isArray(workflow),
    `${label} must be a mapping`,
  );
  return workflow;
}

function stepLabel(step, index) {
  return step?.name || step?.uses || `step ${index + 1}`;
}

function assertExactSteps(actual, expected, workflowLabel) {
  assert.ok(Array.isArray(actual), `${workflowLabel} steps must be a sequence`);
  assert.deepEqual(
    actual.map(stepLabel),
    expected.map(stepLabel),
    `unexpected ${workflowLabel} steps`,
  );
  for (const [index, expectedStep] of expected.entries())
    assert.deepEqual(
      actual[index],
      expectedStep,
      `unexpected ${stepLabel(expectedStep, index)} step`,
    );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertPinnedComments(sourceText, action, comment) {
  const actionLine = new RegExp(`^\\s*(?:-\\s+)?uses:\\s+${escapeRegExp(action)}(?:\\s|$)`);
  const pinnedLine = new RegExp(
    `^\\s*(?:-\\s+)?uses:\\s+${escapeRegExp(action)} # ${escapeRegExp(comment)}\\s*$`,
  );
  const occurrences = sourceText.split("\n").filter((line) => actionLine.test(line));

  assert.ok(occurrences.length > 0, `missing action occurrence for ${action}`);
  for (const [index, line] of occurrences.entries())
    assert.match(
      line,
      pinnedLine,
      `missing ${comment} revision comment for ${action} at occurrence ${index + 1}`,
    );
}

function assertNoForbiddenWorkflowText(sourceText, label) {
  assert.doesNotMatch(
    sourceText,
    /:latest|github\.ref_name|github\.sha\s*\}\}\[:/,
    `${label} has a mutable image tag`,
  );
  assert.doesNotMatch(
    sourceText,
    /docker compose[^\n]* config(?! --quiet)/,
    `${label} runs a non-quiet Compose config command`,
  );
  assert.doesNotMatch(
    sourceText,
    /(?:cat|printenv|env)[^\n]*\.env\.production/,
    `${label} prints .env.production`,
  );
}

function assertCiWorkflow(ciSource) {
  const workflow = parseWorkflow(ciSource, "CI workflow");
  const job = workflow.jobs?.["production-bundle"];

  assert.ok(job, "missing production-bundle job");
  assert.deepEqual(
    Object.keys(job).sort(),
    ["env", "runs-on", "steps", "timeout-minutes"].sort(),
    "unexpected production-bundle job keys",
  );
  assert.equal(job["runs-on"], "ubuntu-latest", "unexpected production-bundle runner");
  assert.equal(job["timeout-minutes"], 20, "unexpected production-bundle timeout");
  assert.deepEqual(job.env, PRODUCTION_BUNDLE_ENV, "unexpected production-bundle environment");
  assertExactSteps(job.steps, PRODUCTION_BUNDLE_STEPS, "production-bundle");
  assert.notEqual(workflow.permissions?.packages, "write", "CI must not grant packages: write");
  assertPinnedComments(ciSource, CHECKOUT, "v4");
  assertPinnedComments(ciSource, PNPM_SETUP, "v4");
  assertPinnedComments(ciSource, NODE_SETUP, "v4");
  assertNoForbiddenWorkflowText(ciSource, "CI workflow");
}

function assertReleaseWorkflow(releaseSource, ciSource) {
  const workflow = parseWorkflow(releaseSource, "release workflow");

  assert.deepEqual(
    Object.keys(workflow).sort(),
    ["jobs", "name", "on", "permissions"].sort(),
    "unexpected release workflow keys",
  );
  assert.equal(workflow.name, "Publish production images", "unexpected release workflow name");
  assert.deepEqual(workflow.on, { push: { branches: ["main"] } }, "unexpected release triggers");
  assert.deepEqual(
    workflow.permissions,
    { contents: "read" },
    "release workflow must default to contents: read only",
  );
  const verification = workflow.jobs?.["production-bundle"];
  assert.ok(verification, "missing release production-bundle verification job");
  assert.deepEqual(
    Object.keys(workflow.jobs || {}),
    ["production-bundle", "publish"],
    "unexpected release job names",
  );
  assert.deepEqual(
    Object.keys(verification).sort(),
    ["env", "permissions", "runs-on", "steps", "timeout-minutes"].sort(),
    "unexpected release production-bundle job keys",
  );
  assert.deepEqual(
    verification.permissions,
    { contents: "read" },
    "release production-bundle permissions must be contents: read only",
  );
  assert.equal(
    verification["runs-on"],
    "ubuntu-latest",
    "unexpected release production-bundle runner",
  );
  assert.equal(verification["timeout-minutes"], 20, "unexpected release production-bundle timeout");
  assert.deepEqual(
    verification.env,
    PRODUCTION_BUNDLE_ENV,
    "unexpected release production-bundle environment",
  );
  assertExactSteps(verification.steps, PRODUCTION_BUNDLE_STEPS, "release production-bundle");

  const ciWorkflow = parseWorkflow(ciSource, "CI workflow");
  assert.deepEqual(
    verification.steps,
    ciWorkflow.jobs?.["production-bundle"]?.steps,
    "release production-bundle verification must exactly match CI",
  );

  const publish = workflow.jobs.publish;
  assert.equal(
    publish?.needs,
    "production-bundle",
    "release publish must need exactly the production-bundle verification job",
  );
  assert.deepEqual(
    Object.keys(publish || {}).sort(),
    ["needs", "permissions", "runs-on", "steps", "timeout-minutes"].sort(),
    "unexpected publish job keys",
  );
  assert.deepEqual(
    publish.permissions,
    { contents: "read", packages: "write" },
    "release publish permissions must scope packages: write to publication",
  );
  assert.equal(publish["runs-on"], "ubuntu-latest", "unexpected publish runner");
  assert.equal(publish["timeout-minutes"], 20, "unexpected publish timeout");
  assertExactSteps(publish.steps, RELEASE_STEPS, "release publish");
  assertPinnedComments(releaseSource, CHECKOUT, "v4");
  assertPinnedComments(releaseSource, PNPM_SETUP, "v4");
  assertPinnedComments(releaseSource, NODE_SETUP, "v4");
  assertPinnedComments(releaseSource, BUILDX, "v3.11.1");
  assertPinnedComments(releaseSource, LOGIN, "v3.5.0");
  assertPinnedComments(releaseSource, BUILD_PUSH, "v6.18.0");
  assertNoForbiddenWorkflowText(releaseSource, "release workflow");
}

function replaceExactlyOnce(sourceText, search, replacement, mutationName) {
  const first = sourceText.indexOf(search);
  assert.notEqual(first, -1, `${mutationName}: mutation target must exist`);
  assert.equal(
    sourceText.indexOf(search, first + search.length),
    -1,
    `${mutationName}: mutation target must be unique`,
  );
  const mutated = sourceText.replace(search, replacement);
  assert.notEqual(mutated, sourceText, `${mutationName}: mutation must change the fixture`);
  return mutated;
}

function expectRejected(validator, sourceText, mutation) {
  const mutated = replaceExactlyOnce(
    sourceText,
    mutation.search,
    mutation.replacement,
    mutation.name,
  );
  assert.throws(() => validator(mutated), mutation.expected, mutation.name);
}

test("CI structurally verifies the production bundle and secret-safe cleanup", async () => {
  assertCiWorkflow(await source(".github/workflows/ci.yml"));
});

test("main publication structurally pushes SHA tags and records trusted digest evidence", async () => {
  assertReleaseWorkflow(
    await source(".github/workflows/release-images.yml"),
    await source(".github/workflows/ci.yml"),
  );
});

test("CI contract rejects each hidden-step, shell, log, and cleanup mutation for its own reason", async () => {
  const ci = await source(".github/workflows/ci.yml");
  const install =
    "      - run: pnpm install --frozen-lockfile\n" +
    "      - name: Define temporary production environment path";
  const smoke =
    "        run: MARKIRO_SMOKE_CI_OVERLAY=1 SMOKE_ASSERT_SHUTDOWN=1 node deploy/production/smoke.mjs";
  const build =
    '          docker build --file deploy/production/api.Dockerfile --tag "ghcr.io/thevladbog/markiro-api:${{ github.sha }}" .';
  const logsIf =
    "      - name: Show sanitized production-bundle logs on failure\n" + "        if: failure()";
  const logsRun = "          -f deploy/production/compose.ci.yml logs --no-color";
  const cleanupRun =
    "          -f deploy/production/compose.ci.yml down --volumes --remove-orphans";

  for (const mutation of [
    {
      name: "old default HTTPS port in generated auth origin",
      search: `          printf '%s\\n' "BETTER_AUTH_URL=https://localhost:18443"`,
      replacement: `          printf '%s\\n' "BETTER_AUTH_URL=https://localhost"`,
      expected: /unexpected Generate masked test-only environment step/,
    },
    {
      name: "valid YAML id step",
      search: install,
      replacement:
        "      - run: pnpm install --frozen-lockfile\n" +
        "      - id: hidden-environment-reader\n" +
        `        run: node -e "require('node:fs').readFileSync(process.env.RUNNER_TEMP + '/markiro-production-test.env')"\n` +
        "      - name: Define temporary production environment path",
      expected: /unexpected production-bundle steps/,
    },
    {
      name: "valid YAML if step",
      search: install,
      replacement:
        "      - run: pnpm install --frozen-lockfile\n" +
        "      - if: always()\n" +
        "        run: true\n" +
        "      - name: Define temporary production environment path",
      expected: /unexpected production-bundle steps/,
    },
    {
      name: "command appended to smoke",
      search: smoke,
      replacement: `${smoke}; node -e "require('node:fs').readFileSync(process.env.RUNNER_TEMP + '/markiro-production-test.env')"`,
      expected: /unexpected Smoke the production bundle step/,
    },
    {
      name: "absolute Docker executable",
      search: build,
      replacement: build.replace("docker build", "/usr/bin/docker build"),
      expected: /unexpected Build local SHA-tagged production images step/,
    },
    {
      name: "shell-composed Docker build",
      search: build,
      replacement: build.replace("docker build", "true && docker build"),
      expected: /unexpected Build local SHA-tagged production images step/,
    },
    {
      name: "extra buildx tag",
      search: build,
      replacement: `${build}\n          docker buildx build -t other:extra .`,
      expected: /unexpected Build local SHA-tagged production images step/,
    },
    {
      name: "unconditional failure logs",
      search: logsIf,
      replacement:
        "      - name: Show sanitized production-bundle logs on failure\n" + "        if: always()",
      expected: /unexpected Show sanitized production-bundle logs on failure step/,
    },
    {
      name: "command appended to failure logs",
      search: logsRun,
      replacement: `${logsRun}; docker compose ps`,
      expected: /unexpected Show sanitized production-bundle logs on failure step/,
    },
    {
      name: "command after cleanup",
      search: cleanupRun,
      replacement: `${cleanupRun}; docker compose ps`,
      expected: /unexpected Remove production-bundle containers and volumes step/,
    },
  ])
    expectRejected(assertCiWorkflow, ci, mutation);
});

test("release contract rejects each trigger, permission, job, step, and tag mutation for its own reason", async () => {
  const release = await source(".github/workflows/release-images.yml");
  const ci = await source(".github/workflows/ci.yml");
  const apiTags = "          tags: ghcr.io/thevladbog/markiro-api:${{ github.sha }}";
  const edgeStep = "      - name: Publish edge SHA tag";
  const edgeBuildPushComment =
    `      - name: Publish edge SHA tag\n` +
    `        id: edge-image\n` +
    `        uses: ${BUILD_PUSH} # v6.18.0`;

  for (const mutation of [
    {
      name: "removed production-bundle verification job",
      search: "jobs:\n  production-bundle:",
      replacement: "jobs:\n  removed-production-bundle:",
      expected: /missing release production-bundle verification job/,
    },
    {
      name: "removed publication dependency",
      search: "    needs: production-bundle\n",
      replacement: "",
      expected: /release publish must need exactly the production-bundle verification job/,
    },
    {
      name: "weakened publication dependency",
      search: "    needs: production-bundle",
      replacement: "    needs: [production-bundle, optional-check]",
      expected: /release publish must need exactly the production-bundle verification job/,
    },
    {
      name: "workflow-wide package publication permission",
      search: "permissions:\n  contents: read\n\njobs:",
      replacement: "permissions:\n  contents: read\n  packages: write\n\njobs:",
      expected: /release workflow must default to contents: read only/,
    },
    {
      name: "omitted production-bundle contract verification step",
      search:
        "      - name: Verify production bundle contracts\n" +
        "        run: pnpm test:production-bundle:contract\n",
      replacement: "",
      expected: /unexpected release production-bundle steps/,
    },
    {
      name: "altered production-bundle smoke step",
      search:
        "        run: MARKIRO_SMOKE_CI_OVERLAY=1 SMOKE_ASSERT_SHUTDOWN=1 node deploy/production/smoke.mjs",
      replacement: "        run: node deploy/production/smoke.mjs",
      expected: /unexpected Smoke the production bundle step/,
    },
    {
      name: "old default HTTPS port in release verification origin",
      search: `          printf '%s\\n' "BETTER_AUTH_URL=https://localhost:18443"`,
      replacement: `          printf '%s\\n' "BETTER_AUTH_URL=https://localhost"`,
      expected: /unexpected Generate masked test-only environment step/,
    },
    {
      name: "extra release trigger",
      search: "  push:\n    branches: [main]",
      replacement: "  push:\n    branches: [main]\n  workflow_dispatch:",
      expected: /unexpected release triggers/,
    },
    {
      name: "expanded publish permission",
      search: "      packages: write",
      replacement: "      packages: write\n      id-token: write",
      expected: /release publish permissions must scope packages: write to publication/,
    },
    {
      name: "incorrect buildx revision comment",
      search: `${BUILDX} # v3.11.1`,
      replacement: `${BUILDX} # v3.11X1`,
      expected: /missing v3\.11\.1 revision comment/,
    },
    {
      name: "missing revision comment on second repeated action",
      search: edgeBuildPushComment,
      replacement:
        `      - name: Publish edge SHA tag\n` +
        `        id: edge-image\n` +
        `        uses: ${BUILD_PUSH}`,
      expected: /missing v6\.18\.0 revision comment.*occurrence 2/,
    },
    {
      name: "quoted extra release job",
      search: "jobs:\n  production-bundle:",
      replacement: 'jobs:\n  "shadow": { runs-on: ubuntu-latest }\n  production-bundle:',
      expected: /unexpected release job names/,
    },
    {
      name: "inline extra release job",
      search: "jobs:\n  production-bundle:",
      replacement: "jobs:\n  shadow: { runs-on: ubuntu-latest }\n  production-bundle:",
      expected: /unexpected release job names/,
    },
    {
      name: "extra release shell step",
      search: edgeStep,
      replacement: "      - run: docker buildx build -t other:extra .\n" + edgeStep,
      expected: /unexpected release publish steps/,
    },
    {
      name: "multiple API image tags",
      search: apiTags,
      replacement:
        "          tags:\n" +
        "            - ghcr.io/thevladbog/markiro-api:${{ github.sha }}\n" +
        "            - ghcr.io/thevladbog/markiro-api:extra",
      expected: /unexpected Publish API SHA tag step/,
    },
    {
      name: "missing API build output id",
      search: "        id: api-image\n",
      replacement: "",
      expected: /unexpected Publish API SHA tag step/,
    },
    {
      name: "missing trusted digest evidence",
      search: "      - name: Record trusted image digest evidence\n",
      replacement: "      - name: Omit trusted image digest evidence\n",
      expected: /unexpected release publish steps/,
    },
  ])
    expectRejected((mutated) => assertReleaseWorkflow(mutated, ci), release, mutation);
});
