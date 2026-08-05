import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";

const CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const PNPM_SETUP = "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1";
const NODE_SETUP = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const LOGIN = "docker/login-action@184bdaa0721073962dff0199f1fb9940f07167d1";
const UPLOAD_ARTIFACT = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ARTIFACT = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const RELEASE_ARTIFACT_NAME = "markiro-production-images-${{ github.sha }}";
const RELEASE_MANIFEST_ARTIFACT_NAME = "markiro-release-manifest-${{ github.sha }}";
const RELEASE_ARTIFACT_OUTPUTS = {
  "verified-images-artifact-id": "${{ steps.verified-images-artifact.outputs.artifact-id }}",
};
const COMPOSE =
  'docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml -f deploy/production/compose.ci.yml';

const INITIALIZE_ENVIRONMENT =
  "set -euo pipefail\n" +
  'env_file="$RUNNER_TEMP/markiro-production-test.env"\n' +
  "umask 077\n" +
  ': > "$env_file"\n' +
  'chmod 600 "$env_file"\n' +
  `printf '%s\\n' "MARKIRO_ENV_FILE=$env_file" >> "$GITHUB_ENV"\n`;

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
  { name: "Initialize protected production environment", run: INITIALIZE_ENVIRONMENT },
  { uses: CHECKOUT, with: { "persist-credentials": false } },
  { uses: PNPM_SETUP },
  { uses: NODE_SETUP, with: { "node-version": 24, cache: "pnpm" } },
  { run: "pnpm install --frozen-lockfile" },
  {
    name: "Install Chromium for production documentation smoke",
    run:
      "pnpm --dir tools/production-browser --ignore-workspace install --frozen-lockfile\n" +
      "pnpm --dir tools/production-browser --ignore-workspace exec playwright install --with-deps chromium\n",
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
    run: "MARKIRO_SMOKE_CI_OVERLAY=1 SMOKE_ASSERT_DEPENDENCY_ISOLATION=1 SMOKE_ASSERT_SHUTDOWN=1 node deploy/production/smoke.mjs",
  },
  {
    name: "Browser-smoke production API documentation",
    run: "pnpm test:production-docs:browser",
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

const PACKAGE_VERIFIED_IMAGES =
  "set -euo pipefail\n" +
  'artifact_dir="$RUNNER_TEMP/markiro-release-images"\n' +
  'manifest_path="$artifact_dir/manifest.json"\n' +
  'archive_path="$artifact_dir/images.tar"\n' +
  'release_sha="$RELEASE_SHA"\n' +
  'api_tag="ghcr.io/thevladbog/markiro-api:$release_sha"\n' +
  'edge_tag="ghcr.io/thevladbog/markiro-edge:$release_sha"\n' +
  '[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]]\n' +
  'test ! -e "$artifact_dir"\n' +
  "umask 077\n" +
  'install -d -m 700 "$artifact_dir"\n' +
  'api_image_id="$(docker image inspect --format \'{{.Id}}\' "$api_tag")"\n' +
  'edge_image_id="$(docker image inspect --format \'{{.Id}}\' "$edge_tag")"\n' +
  '[[ "$api_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]\n' +
  '[[ "$edge_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]\n' +
  'docker save --output "$archive_path" "$api_tag" "$edge_tag"\n' +
  'test -s "$archive_path"\n' +
  'archive_sha256="$(sha256sum "$archive_path" | cut -d\' \' -f1)"\n' +
  '[[ "$archive_sha256" =~ ^[0-9a-f]{64}$ ]]\n' +
  "jq -n \\\n" +
  '  --arg release_sha "$release_sha" \\\n' +
  '  --arg archive_sha256 "$archive_sha256" \\\n' +
  '  --arg api_tag "$api_tag" \\\n' +
  '  --arg api_image_id "$api_image_id" \\\n' +
  '  --arg edge_tag "$edge_tag" \\\n' +
  '  --arg edge_image_id "$edge_image_id" \\\n' +
  "  '{release_sha: $release_sha, archive_sha256: $archive_sha256, images: {api: {tag: $api_tag, id: $api_image_id}, edge: {tag: $edge_tag, id: $edge_image_id}}}' \\\n" +
  '  > "$manifest_path"\n' +
  'chmod 600 "$archive_path" "$manifest_path"\n';

const RELEASE_VERIFICATION_STEPS = [
  ...PRODUCTION_BUNDLE_STEPS.slice(0, -2),
  {
    name: "Package the verified production images",
    env: { RELEASE_SHA: "${{ github.sha }}" },
    run: PACKAGE_VERIFIED_IMAGES,
  },
  {
    name: "Upload the verified production images",
    id: "verified-images-artifact",
    uses: UPLOAD_ARTIFACT,
    with: {
      name: RELEASE_ARTIFACT_NAME,
      path: "${{ runner.temp }}/markiro-release-images",
      "if-no-files-found": "error",
      "retention-days": 1,
      "compression-level": 0,
      overwrite: true,
    },
  },
  ...PRODUCTION_BUNDLE_STEPS.slice(-2),
];

const VALIDATE_ARTIFACT =
  "set -euo pipefail\n" +
  'artifact_dir="$RUNNER_TEMP/markiro-release-images"\n' +
  'manifest_path="$artifact_dir/manifest.json"\n' +
  'archive_path="$artifact_dir/images.tar"\n' +
  'expected_sha="$RELEASE_SHA"\n' +
  'expected_api_tag="ghcr.io/thevladbog/markiro-api:$expected_sha"\n' +
  'expected_edge_tag="ghcr.io/thevladbog/markiro-edge:$expected_sha"\n' +
  '[[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]]\n' +
  'test -f "$manifest_path"\n' +
  'test ! -L "$manifest_path"\n' +
  'test -s "$archive_path"\n' +
  'test ! -L "$archive_path"\n' +
  'jq -e \'type == "object" and (keys == ["archive_sha256", "images", "release_sha"]) and (.release_sha | type == "string") and (.archive_sha256 | type == "string") and (.images | type == "object" and (keys == ["api", "edge"])) and ([.images.api, .images.edge] | all(type == "object" and (keys == ["id", "tag"]) and (.id | type == "string") and (.tag | type == "string")))\' "$manifest_path" > /dev/null\n' +
  'release_sha="$(jq -er \'.release_sha\' "$manifest_path")"\n' +
  'archive_sha256="$(jq -er \'.archive_sha256\' "$manifest_path")"\n' +
  'api_tag="$(jq -er \'.images.api.tag\' "$manifest_path")"\n' +
  'api_image_id="$(jq -er \'.images.api.id\' "$manifest_path")"\n' +
  'edge_tag="$(jq -er \'.images.edge.tag\' "$manifest_path")"\n' +
  'edge_image_id="$(jq -er \'.images.edge.id\' "$manifest_path")"\n' +
  '[[ "$release_sha" == "$expected_sha" ]]\n' +
  '[[ "$api_tag" == "$expected_api_tag" ]]\n' +
  '[[ "$edge_tag" == "$expected_edge_tag" ]]\n' +
  '[[ "$archive_sha256" =~ ^[0-9a-f]{64}$ ]]\n' +
  '[[ "$api_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]\n' +
  '[[ "$edge_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]\n' +
  '[[ "$(sha256sum "$archive_path" | cut -d\' \' -f1)" == "$archive_sha256" ]]\n' +
  'docker load --input "$archive_path"\n' +
  '[[ "$(docker image inspect --format \'{{.Id}}\' "$expected_api_tag")" == "$api_image_id" ]]\n' +
  '[[ "$(docker image inspect --format \'{{.Id}}\' "$expected_edge_tag")" == "$edge_image_id" ]]\n';

const PUSH_VERIFIED_IMAGES =
  "set -euo pipefail\n" +
  'manifest_path="$RUNNER_TEMP/markiro-release-images/manifest.json"\n' +
  'release_sha="$RELEASE_SHA"\n' +
  'api_tag="ghcr.io/thevladbog/markiro-api:$release_sha"\n' +
  'edge_tag="ghcr.io/thevladbog/markiro-edge:$release_sha"\n' +
  'api_image_id="$(jq -er \'.images.api.id\' "$manifest_path")"\n' +
  'edge_image_id="$(jq -er \'.images.edge.id\' "$manifest_path")"\n' +
  '[[ "$(docker image inspect --format \'{{.Id}}\' "$api_tag")" == "$api_image_id" ]]\n' +
  '[[ "$(docker image inspect --format \'{{.Id}}\' "$edge_tag")" == "$edge_image_id" ]]\n' +
  'docker push "$api_tag"\n' +
  'docker push "$edge_tag"\n' +
  'api_repository="ghcr.io/thevladbog/markiro-api"\n' +
  'edge_repository="ghcr.io/thevladbog/markiro-edge"\n' +
  "mapfile -t api_repo_digests < <(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' \"$api_tag\")\n" +
  "mapfile -t edge_repo_digests < <(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' \"$edge_tag\")\n" +
  "api_digests=()\n" +
  "edge_digests=()\n" +
  'for repository_digest in "${api_repo_digests[@]}"; do\n' +
  '  if [[ "$repository_digest" == "$api_repository@"* ]]; then api_digests+=("${repository_digest#"$api_repository@"}"); fi\n' +
  "done\n" +
  'for repository_digest in "${edge_repo_digests[@]}"; do\n' +
  '  if [[ "$repository_digest" == "$edge_repository@"* ]]; then edge_digests+=("${repository_digest#"$edge_repository@"}"); fi\n' +
  "done\n" +
  '[[ "${#api_digests[@]}" -eq 1 ]]\n' +
  '[[ "${#edge_digests[@]}" -eq 1 ]]\n' +
  'api_digest="${api_digests[0]}"\n' +
  'edge_digest="${edge_digests[0]}"\n' +
  '[[ "$api_digest" =~ ^sha256:[0-9a-f]{64}$ ]]\n' +
  '[[ "$edge_digest" =~ ^sha256:[0-9a-f]{64}$ ]]\n' +
  'printf \'api_digest=%s\\n\' "$api_digest" >> "$GITHUB_OUTPUT"\n' +
  'printf \'edge_digest=%s\\n\' "$edge_digest" >> "$GITHUB_OUTPUT"\n';

const RELEASE_TIME_STEP = {
  name: "Record release timestamp",
  id: "release-time",
  run: `printf 'created_at=%s\\n' "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" >> "$GITHUB_OUTPUT"`,
};

const CREATE_RELEASE_MANIFEST_STEP = {
  name: "Create trusted release manifest",
  env: {
    RELEASE_SHA: "${{ github.sha }}",
    API_DIGEST: "${{ steps.published-images.outputs.api_digest }}",
    EDGE_DIGEST: "${{ steps.published-images.outputs.edge_digest }}",
    GITHUB_RUN_ID: "${{ github.run_id }}",
    CREATED_AT: "${{ steps.release-time.outputs.created_at }}",
  },
  run: 'node deploy/production/release-manifest.mjs create "$RUNNER_TEMP/release-manifest.json"',
};

const UPLOAD_RELEASE_MANIFEST_STEP = {
  name: "Upload trusted release manifest",
  uses: UPLOAD_ARTIFACT,
  with: {
    name: RELEASE_MANIFEST_ARTIFACT_NAME,
    path: "${{ runner.temp }}/release-manifest.json",
    "retention-days": 90,
    "if-no-files-found": "error",
  },
};

const RELEASE_STEPS = [
  {
    name: "Download the verified production images",
    uses: DOWNLOAD_ARTIFACT,
    with: {
      "artifact-ids": "${{ needs.production-bundle.outputs.verified-images-artifact-id }}",
      path: "${{ runner.temp }}/markiro-release-images",
    },
  },
  {
    name: "Load and validate the verified production images",
    env: { RELEASE_SHA: "${{ github.sha }}" },
    run: VALIDATE_ARTIFACT,
  },
  {
    uses: LOGIN,
    with: {
      registry: "ghcr.io",
      username: "${{ github.actor }}",
      password: "${{ secrets.GITHUB_TOKEN }}",
    },
  },
  {
    name: "Publish the exact verified production images",
    id: "published-images",
    env: { RELEASE_SHA: "${{ github.sha }}" },
    run: PUSH_VERIFIED_IMAGES,
  },
  RELEASE_TIME_STEP,
  CREATE_RELEASE_MANIFEST_STEP,
  UPLOAD_RELEASE_MANIFEST_STEP,
  {
    name: "Record trusted image digest evidence",
    env: {
      RELEASE_SHA: "${{ github.sha }}",
      API_DIGEST: "${{ steps.published-images.outputs.api_digest }}",
      EDGE_DIGEST: "${{ steps.published-images.outputs.edge_digest }}",
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
  assert.deepEqual(
    workflow.permissions,
    { contents: "read" },
    "CI workflow permissions must be contents: read only",
  );
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
    ["env", "outputs", "permissions", "runs-on", "steps", "timeout-minutes"].sort(),
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
  assert.deepEqual(
    verification.outputs,
    RELEASE_ARTIFACT_OUTPUTS,
    "release verification must expose the exact uploaded artifact id",
  );
  assertExactSteps(verification.steps, RELEASE_VERIFICATION_STEPS, "release production-bundle");

  const ciWorkflow = parseWorkflow(ciSource, "CI workflow");
  assert.deepEqual(
    verification.steps.filter(
      (step) =>
        step.name !== "Package the verified production images" &&
        step.name !== "Upload the verified production images",
    ),
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
  assertPinnedComments(releaseSource, LOGIN, "v3.5.0");
  assertPinnedComments(releaseSource, UPLOAD_ARTIFACT, "v7.0.1");
  assertPinnedComments(releaseSource, DOWNLOAD_ARTIFACT, "v8.0.1");
  assert.doesNotMatch(releaseSource, /build-push-action|setup-buildx-action/);
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

test("main publication records a durable trusted release manifest after image publication", async () => {
  assertReleaseWorkflow(
    await source(".github/workflows/release-images.yml"),
    await source(".github/workflows/ci.yml"),
  );
});

function assertProductionDeploymentWorkflow(
  deploymentSource,
  remoteDeploySource,
  runnerControlSource,
) {
  const workflow = parseWorkflow(deploymentSource, "production deployment workflow");

  assert.deepEqual(Object.keys(workflow.on).sort(), ["workflow_dispatch", "workflow_run"]);
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ["Publish production images"],
    types: ["completed"],
    branches: ["main"],
  });
  assert.equal("pull_request" in workflow.on, false);
  assert.deepEqual(workflow.permissions, {
    actions: "read",
    contents: "read",
    "id-token": "write",
  });
  assert.doesNotMatch(deploymentSource, /packages:\s*write/);
  assert.match(deploymentSource, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(deploymentSource, /github\.event\.workflow_run\.id/);
  assert.match(deploymentSource, /github\.event\.workflow_run\.head_sha/);
  assert.equal(
    (
      deploymentSource.match(/name: markiro-release-manifest-\$\{\{[^}]*release-sha[^}]*\}\}/g) ??
      []
    ).length,
    2,
  );
  assert.match(deploymentSource, /run-id:\s*\$\{\{[^}]*release-run-id[^}]*\}\}/);
  assert.match(deploymentSource, /environment:\s*production/);
  assert.match(
    deploymentSource,
    /runs-on:\s*\[self-hosted, linux, "\$\{\{ needs\.controller\.outputs\.runner-label \}\}"\]/,
  );
  assert.doesNotMatch(deploymentSource, /runs-on:\s*\[self-hosted, linux, markiro-production\]/);
  assert.match(deploymentSource, /GITHUB_RUNNER_ADMIN_TOKEN/);
  assert.match(deploymentSource, /YC_RUNNER_SERVICE_ACCOUNT_ID/);
  assert.match(
    deploymentSource,
    /app-host-keys-b64:\s*\$\{\{ steps\.runner\.outputs\.app-host-keys-b64 \}\}/,
  );
  assert.match(
    deploymentSource,
    /APP_SSH_HOST_KEYS_B64:\s*\$\{\{ needs\.controller\.outputs\.app-host-keys-b64 \}\}/,
  );
  assert.equal(workflow.jobs.cleanup?.if, "always()");
  assert.match(deploymentSource, /node deploy\/yandex\/runner-control\.mjs cleanup/);
  assert.match(runnerControlSource, /const gateToken = requiredEnvironment\("YC_GATE_IAM_TOKEN"\)/);
  assert.match(runnerControlSource, /await verifyControllerGates\(gateToken\)/);
  assert.match(runnerControlSource, /await authenticatedAppHostKeys\(gateToken\)/);
  assert.match(runnerControlSource, /production backup gate failed/);
  assert.match(runnerControlSource, /production ALB gate failed/);
  assert.doesNotMatch(deploymentSource, /ssh-key|identity-file|--public-address/i);
  assert.match(remoteDeploySource, /--internal-address/);
  assertPinnedComments(deploymentSource, CHECKOUT, "v4");
  assertPinnedComments(deploymentSource, DOWNLOAD_ARTIFACT, "v8.0.1");
}

test("production deployment is protected, release-bound, dynamically labelled, and always cleaned", async () => {
  assertProductionDeploymentWorkflow(
    await source(".github/workflows/deploy-production.yml"),
    await source("deploy/yandex/remote-deploy.mjs"),
    await source("deploy/yandex/runner-control.mjs"),
  );
});

test("production deployment contract rejects trigger, label, cleanup, and gate mutations", async () => {
  const deployment = await source(".github/workflows/deploy-production.yml");
  const remote = await source("deploy/yandex/remote-deploy.mjs");
  const controller = await source("deploy/yandex/runner-control.mjs");

  for (const mutation of [
    {
      name: "pull request deployment trigger",
      search: "  workflow_run:\n",
      replacement: "  pull_request:\n  workflow_run:\n",
    },
    {
      name: "static deployment runner label",
      search: 'runs-on: [self-hosted, linux, "${{ needs.controller.outputs.runner-label }}"]',
      replacement: "runs-on: [self-hosted, linux, markiro-production]",
    },
    {
      name: "cleanup only on success",
      search: "  cleanup:\n    needs: [controller, deploy]\n    if: always()",
      replacement: "  cleanup:\n    needs: [controller, deploy]\n    if: success()",
    },
    {
      name: "tag-shaped manifest artifact",
      search: "name: markiro-release-manifest-${{ steps.release.outputs.release-sha }}",
      replacement: "name: markiro-release-manifest-main",
    },
  ]) {
    const mutated = replaceExactlyOnce(
      deployment,
      mutation.search,
      mutation.replacement,
      mutation.name,
    );
    assert.throws(
      () => assertProductionDeploymentWorkflow(mutated, remote, controller),
      undefined,
      mutation.name,
    );
  }

  for (const search of ["production backup gate failed", "production ALB gate failed"]) {
    const mutated = replaceExactlyOnce(controller, search, "gate omitted", `${search} removal`);
    assert.throws(() => assertProductionDeploymentWorkflow(deployment, remote, mutated));
  }
});

test("CI contract rejects each hidden-step, shell, log, and cleanup mutation for its own reason", async () => {
  const ci = await source(".github/workflows/ci.yml");
  const install =
    "      - run: pnpm install --frozen-lockfile\n" +
    "      - name: Install Chromium for production documentation smoke\n" +
    "        run: |\n" +
    "          pnpm --dir tools/production-browser --ignore-workspace install --frozen-lockfile\n" +
    "          pnpm --dir tools/production-browser --ignore-workspace exec playwright install --with-deps chromium\n";
  const initializeEnvironment =
    "      - name: Initialize protected production environment\n" +
    "        run: |\n" +
    "          set -euo pipefail\n" +
    '          env_file="$RUNNER_TEMP/markiro-production-test.env"\n' +
    "          umask 077\n" +
    '          : > "$env_file"\n' +
    '          chmod 600 "$env_file"\n' +
    `          printf '%s\\n' "MARKIRO_ENV_FILE=$env_file" >> "$GITHUB_ENV"\n`;
  const smoke =
    "        run: MARKIRO_SMOKE_CI_OVERLAY=1 SMOKE_ASSERT_DEPENDENCY_ISOLATION=1 SMOKE_ASSERT_SHUTDOWN=1 node deploy/production/smoke.mjs";
  const chromiumInstall =
    "      - name: Install Chromium for production documentation smoke\n" +
    "        run: |\n" +
    "          pnpm --dir tools/production-browser --ignore-workspace install --frozen-lockfile\n" +
    "          pnpm --dir tools/production-browser --ignore-workspace exec playwright install --with-deps chromium\n";
  const browserFrozenInstall =
    "          pnpm --dir tools/production-browser --ignore-workspace install --frozen-lockfile\n";
  const browserSmoke =
    "      - name: Browser-smoke production API documentation\n" +
    "        run: pnpm test:production-docs:browser\n";
  const build =
    '          docker build --file deploy/production/api.Dockerfile --tag "ghcr.io/thevladbog/markiro-api:${{ github.sha }}" .';
  const logsIf =
    "      - name: Show sanitized production-bundle logs on failure\n" + "        if: failure()";
  const logsRun = "          -f deploy/production/compose.ci.yml logs --no-color";
  const cleanupRun =
    "          -f deploy/production/compose.ci.yml down --volumes --remove-orphans";

  for (const mutation of [
    {
      name: "workflow-wide write-all permissions scalar",
      search: "permissions:\n  contents: read",
      replacement: "permissions: write-all",
      expected: /CI workflow permissions must be contents: read only/,
    },
    {
      name: "workflow-wide permissions sequence",
      search: "permissions:\n  contents: read",
      replacement: "permissions:\n  - contents: read",
      expected: /CI workflow permissions must be contents: read only/,
    },
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
        install +
        "      - id: hidden-environment-reader\n" +
        `        run: node -e "require('node:fs').readFileSync(process.env.RUNNER_TEMP + '/markiro-production-test.env')"\n`,
      expected: /unexpected production-bundle steps/,
    },
    {
      name: "valid YAML if step",
      search: install,
      replacement: install + "      - if: always()\n" + "        run: true\n",
      expected: /unexpected production-bundle steps/,
    },
    {
      name: "protected environment initialization removed",
      search: initializeEnvironment,
      replacement: "",
      expected: /unexpected production-bundle steps/,
    },
    {
      name: "environment file protection removed",
      search: '          chmod 600 "$env_file"',
      replacement: '          chmod 644 "$env_file"',
      expected: /unexpected Initialize protected production environment step/,
    },
    {
      name: "command appended to smoke",
      search: smoke,
      replacement: `${smoke}; node -e "require('node:fs').readFileSync(process.env.RUNNER_TEMP + '/markiro-production-test.env')"`,
      expected: /unexpected Smoke the production bundle step/,
    },
    {
      name: "Chromium install removed",
      search: chromiumInstall,
      replacement: "",
      expected: /unexpected production-bundle steps/,
    },
    {
      name: "root frozen install removed",
      search: install,
      replacement: install.replace("      - run: pnpm install --frozen-lockfile\n", ""),
      expected: /unexpected production-bundle steps/,
    },
    {
      name: "standalone browser frozen install removed",
      search: browserFrozenInstall,
      replacement: "",
      expected: /unexpected Install Chromium for production documentation smoke step/,
    },
    {
      name: "browser documentation gate removed",
      search: browserSmoke,
      replacement: "",
      expected: /unexpected production-bundle steps/,
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

test("release contract rejects verification, artifact identity, publication, and evidence mutations", async () => {
  const release = await source(".github/workflows/release-images.yml");
  const ci = await source(".github/workflows/ci.yml");
  const publishStep = "      - name: Publish the exact verified production images";
  const createManifestStep =
    "      - name: Create trusted release manifest\n" +
    "        env:\n" +
    "          RELEASE_SHA: ${{ github.sha }}\n" +
    "          API_DIGEST: ${{ steps.published-images.outputs.api_digest }}\n" +
    "          EDGE_DIGEST: ${{ steps.published-images.outputs.edge_digest }}\n" +
    "          GITHUB_RUN_ID: ${{ github.run_id }}\n" +
    "          CREATED_AT: ${{ steps.release-time.outputs.created_at }}\n" +
    '        run: node deploy/production/release-manifest.mjs create "$RUNNER_TEMP/release-manifest.json"\n';
  const cleanupIf =
    "      - name: Remove production-bundle containers and volumes\n" + "        if: always()";

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
        "        run: MARKIRO_SMOKE_CI_OVERLAY=1 SMOKE_ASSERT_DEPENDENCY_ISOLATION=1 SMOKE_ASSERT_SHUTDOWN=1 node deploy/production/smoke.mjs",
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
      name: "incorrect upload-artifact revision comment",
      search:
        `        uses: ${UPLOAD_ARTIFACT} # v7.0.1\n` +
        "        with:\n" +
        `          name: ${RELEASE_MANIFEST_ARTIFACT_NAME}`,
      replacement:
        `        uses: ${UPLOAD_ARTIFACT} # v4.6.X\n` +
        "        with:\n" +
        `          name: ${RELEASE_MANIFEST_ARTIFACT_NAME}`,
      expected: /missing v7\.0\.1 revision comment/,
    },
    {
      name: "changed download-artifact pin",
      search: DOWNLOAD_ARTIFACT,
      replacement: "actions/download-artifact@main",
      expected: /unexpected Download the verified production images step/,
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
      name: "reintroduced publish rebuild",
      search: publishStep,
      replacement: "      - run: docker build -t unverified:latest .\n" + publishStep,
      expected: /unexpected release publish steps/,
    },
    {
      name: "packaged manifest omits the API image identity",
      search: '          --arg api_image_id "$api_image_id" \\',
      replacement: "          --arg api_image_id \"sha256:${'0'.repeat(64)}\" \\",
      expected: /unexpected Package the verified production images step/,
    },
    {
      name: "artifact upload tolerates missing files",
      search:
        `          name: ${RELEASE_MANIFEST_ARTIFACT_NAME}\n` +
        "          path: ${{ runner.temp }}/release-manifest.json\n" +
        "          retention-days: 90\n" +
        "          if-no-files-found: error",
      replacement:
        `          name: ${RELEASE_MANIFEST_ARTIFACT_NAME}\n` +
        "          path: ${{ runner.temp }}/release-manifest.json\n" +
        "          retention-days: 90\n" +
        "          if-no-files-found: ignore",
      expected: /unexpected Upload trusted release manifest step/,
    },
    {
      name: "download falls back to ambiguous name lookup",
      search:
        `        uses: ${DOWNLOAD_ARTIFACT} # v8.0.1\n` +
        "        with:\n" +
        "          artifact-ids: ${{ needs.production-bundle.outputs.verified-images-artifact-id }}",
      replacement:
        `        uses: ${DOWNLOAD_ARTIFACT} # v8.0.1\n` +
        "        with:\n" +
        `          name: ${RELEASE_ARTIFACT_NAME}`,
      expected: /unexpected Download the verified production images step/,
    },
    {
      name: "upload omits the artifact output step id",
      search:
        "      - name: Upload the verified production images\n" +
        "        id: verified-images-artifact\n",
      replacement: "      - name: Upload the verified production images\n",
      expected: /unexpected Upload the verified production images step/,
    },
    {
      name: "job output references an untrusted artifact field",
      search:
        "    outputs:\n" +
        "      verified-images-artifact-id: ${{ steps.verified-images-artifact.outputs.artifact-id }}",
      replacement:
        "    outputs:\n" +
        "      verified-images-artifact-id: ${{ steps.verified-images-artifact.outputs.artifact-url }}",
      expected: /release verification must expose the exact uploaded artifact id/,
    },
    {
      name: "download does not use the verification job artifact id",
      search:
        "          artifact-ids: ${{ needs.production-bundle.outputs.verified-images-artifact-id }}",
      replacement: "          artifact-ids: 12345",
      expected: /unexpected Download the verified production images step/,
    },
    {
      name: "downloaded archive checksum validation removed",
      search:
        '          [[ "$(sha256sum "$archive_path" | cut -d\' \' -f1)" == "$archive_sha256" ]]',
      replacement: "          true # archive checksum omitted",
      expected: /unexpected Load and validate the verified production images step/,
    },
    {
      name: "loaded API image identity validation removed",
      search:
        '          [[ "$(docker image inspect --format \'{{.Id}}\' "$expected_api_tag")" == "$api_image_id" ]]',
      replacement: "          true # loaded API identity omitted",
      expected: /unexpected Load and validate the verified production images step/,
    },
    {
      name: "pre-push API image identity validation removed",
      search:
        '          [[ "$(docker image inspect --format \'{{.Id}}\' "$api_tag")" == "$api_image_id" ]]',
      replacement: "          true # pre-push API identity omitted",
      expected: /unexpected Publish the exact verified production images step/,
    },
    {
      name: "cleanup no longer runs after artifact failures",
      search: cleanupIf,
      replacement:
        "      - name: Remove production-bundle containers and volumes\n" + "        if: success()",
      expected: /unexpected Remove production-bundle containers and volumes step/,
    },
    {
      name: "missing trusted digest evidence",
      search: "      - name: Record trusted image digest evidence\n",
      replacement: "      - name: Omit trusted image digest evidence\n",
      expected: /unexpected release publish steps/,
    },
    {
      name: "manifest uses a tag instead of the API repository digest",
      search: createManifestStep,
      replacement: createManifestStep.replace(
        "          API_DIGEST: ${{ steps.published-images.outputs.api_digest }}\n",
        "          API_DIGEST: ${{ github.sha }}\n",
      ),
      expected: /unexpected Create trusted release manifest step/,
    },
  ])
    expectRejected((mutated) => assertReleaseWorkflow(mutated, ci), release, mutation);

  const withoutManifest = replaceExactlyOnce(
    release,
    createManifestStep,
    "",
    "manifest move source removal",
  );
  const movedManifest = replaceExactlyOnce(
    withoutManifest,
    publishStep,
    `${createManifestStep}${publishStep}`,
    "manifest moved before image pushes",
  );
  assert.throws(
    () => assertReleaseWorkflow(movedManifest, ci),
    /unexpected release publish steps/,
    "manifest creation must remain after both image pushes",
  );
});
