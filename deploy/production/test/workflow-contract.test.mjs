import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function job(source, name) {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const content = source.slice(start + marker.length);
  const nextJob = content.search(/^  [a-z][a-z-]*:\n/m);
  return nextJob < 0 ? content : content.slice(0, nextJob);
}

function namedStep(source, name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing step: ${name}`);
  const content = source.slice(start + marker.length);
  const nextStep = content.search(/^      - (?:name|uses):/m);
  return nextStep < 0 ? content : content.slice(0, nextStep);
}

function count(source, expression) {
  return [...source.matchAll(expression)].length;
}

function assertCiBundleStructure(bundle) {
  const initialize = namedStep(bundle, "Define temporary production environment path");
  const generate = namedStep(bundle, "Generate masked test-only environment");
  const logs = namedStep(bundle, "Show sanitized production-bundle logs on failure");
  const cleanup = namedStep(bundle, "Remove production-bundle containers and volumes");
  const firstDocker = bundle.search(/^          docker /m);
  const initializeAt = bundle.indexOf("Define temporary production environment path");
  const generateAt = bundle.indexOf("Generate masked test-only environment");
  const preflightAt = bundle.indexOf("node deploy/production/preflight.mjs");
  const smokeAt = bundle.indexOf("SMOKE_ASSERT_SHUTDOWN=1 node deploy/production/smoke.mjs");
  const logsAt = bundle.indexOf("Show sanitized production-bundle logs on failure");
  const cleanupAt = bundle.indexOf("Remove production-bundle containers and volumes");

  assert.match(
    initialize,
    /^        run: echo "MARKIRO_ENV_FILE=\$RUNNER_TEMP\/markiro-production-test\.env" >> "\$GITHUB_ENV"$/m,
  );
  assert.ok(initializeAt < generateAt && generateAt < firstDocker && firstDocker < preflightAt);
  assert.match(generate, /chmod 600 "\$MARKIRO_ENV_FILE"/);
  const maskLoop = generate.match(/for credential in \\\n([\s\S]*?)          done/)?.[1] || "";
  for (const value of [
    "$better_auth_secret",
    "$pairing_code_pepper",
    "$mail_payload_key",
    "$smtp_user",
    "$smtp_password",
    "$database_url",
    '"markiro"',
    '"markiro-development-only"',
  ])
    assert.ok(maskLoop.includes(value), `unmasked test credential source: ${value}`);
  assert.match(generate, /for credential in[\s\S]*?echo "::add-mask::\$credential"/);

  assert.equal(count(bundle, /\bdocker build\b/g), 2);
  const imageBuilds = [
    ...bundle.matchAll(
      /^          docker build --file (deploy\/production\/(?:api|edge)\.Dockerfile) --tag "(ghcr\.io\/thevladbog\/markiro-(?:api|edge):\$\{\{ github\.sha \}\})" \.$/gm,
    ),
  ].map((match) => [match[1], match[2]]);
  assert.deepEqual(imageBuilds, [
    ["deploy/production/api.Dockerfile", "ghcr.io/thevladbog/markiro-api:${{ github.sha }}"],
    ["deploy/production/edge.Dockerfile", "ghcr.io/thevladbog/markiro-edge:${{ github.sha }}"],
  ]);
  assert.doesNotMatch(bundle, /:latest|github\.ref_name|github\.sha\s*\}\}\[:/);
  assert.doesNotMatch(
    bundle,
    /\b(?:cat|sed|awk|head|tail|grep|less|more)\b[^\n]*(?:\$MARKIRO_ENV_FILE|\$\{MARKIRO_ENV_FILE\})/,
  );

  assert.ok(smokeAt < logsAt && logsAt < cleanupAt);
  assert.match(logs, /^        if: failure\(\)$/m);
  assert.match(cleanup, /^        if: always\(\)$/m);
  assert.match(cleanup, /down --volumes --remove-orphans/);
  assert.equal(
    bundle
      .slice(cleanupAt + "Remove production-bundle containers and volumes".length)
      .search(/^      - /m),
    -1,
  );
}

function assertReleaseStructure(release) {
  const trigger = release.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1] || "";
  const jobs = release.match(/^jobs:\n([\s\S]*)$/m)?.[1] || "";
  const publish = job(release, "publish");
  const api = namedStep(publish, "Publish immutable API image");
  const edge = namedStep(publish, "Publish immutable edge image");

  assert.equal(trigger.trim(), "push:\n    branches: [main]");
  assert.match(release, /^permissions:\n  contents: read\n  packages: write$/m);
  assert.equal((jobs.match(/^  [a-z][a-z-]*:$/gm) || []).length, 1);
  assert.doesNotMatch(publish, /^    permissions:/m);
  assert.equal(
    count(release, /uses: docker\/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83/g),
    2,
  );
  assert.match(api, /file: deploy\/production\/api\.Dockerfile/);
  assert.match(api, /^          tags: ghcr\.io\/thevladbog\/markiro-api:\$\{\{ github\.sha \}\}$/m);
  assert.match(edge, /file: deploy\/production\/edge\.Dockerfile/);
  assert.match(
    edge,
    /^          tags: ghcr\.io\/thevladbog\/markiro-edge:\$\{\{ github\.sha \}\}$/m,
  );
  assert.deepEqual(release.match(/^          tags: .+$/gm), [
    "          tags: ghcr.io/thevladbog/markiro-api:${{ github.sha }}",
    "          tags: ghcr.io/thevladbog/markiro-edge:${{ github.sha }}",
  ]);
  assert.doesNotMatch(release, /:latest|github\.ref_name|github\.sha\s*\}\}\[:|\bdocker push\b/);
}

test("CI verifies the production bundle with scoped, secret-safe Docker cleanup", async () => {
  const ci = await source(".github/workflows/ci.yml");
  const bundle = job(ci, "production-bundle");

  assert.match(bundle, /^    timeout-minutes: 20$/m);
  assert.doesNotMatch(bundle, /^    permissions:\n(?:.*\n)*?      packages: write$/m);
  assert.match(bundle, /MARKIRO_IMAGE_TAG: \$\{\{ github\.sha \}\}/);
  assert.match(bundle, /MARKIRO_DOMAIN: localhost/);
  assert.match(bundle, /MARKIRO_HTTP_PORT: "18080"/);
  assert.match(bundle, /MARKIRO_HTTPS_PORT: "18443"/);
  assert.doesNotMatch(bundle, /^      MARKIRO_ENV_FILE:/m);
  assert.match(
    bundle,
    /name: Define temporary production environment path[\s\S]*?echo "MARKIRO_ENV_FILE=\$RUNNER_TEMP\/markiro-production-test\.env" >> "\$GITHUB_ENV"/,
  );
  assert.match(bundle, /pnpm install --frozen-lockfile/);
  assert.match(bundle, /pnpm test:production-bundle:contract/);
  assert.match(
    bundle,
    /docker build[\s\S]*?deploy\/production\/api\.Dockerfile[\s\S]*?ghcr\.io\/thevladbog\/markiro-api:\$\{\{ github\.sha \}\}/,
  );
  assert.match(
    bundle,
    /docker build[\s\S]*?deploy\/production\/edge\.Dockerfile[\s\S]*?ghcr\.io\/thevladbog\/markiro-edge:\$\{\{ github\.sha \}\}/,
  );
  assert.match(bundle, /chmod 600 "\$MARKIRO_ENV_FILE"/);
  assert.match(bundle, /::add-mask::/);
  assert.match(bundle, /database_url="postgresql:\/\/markiro:markiro@postgres:5432\/markiro"/);
  assert.match(bundle, /smtp_user="markiro-ci"/);
  assert.match(bundle, /smtp_password="\$\(openssl rand -hex 24\)"/);
  assert.match(bundle, /"SMTP_USER=\$smtp_user"/);
  assert.match(bundle, /"SMTP_PASSWORD=\$smtp_password"/);
  assert.match(bundle, /node deploy\/production\/preflight\.mjs/);

  const dependencies = bundle.indexOf("postgres mailpit minio");
  const environmentPath = bundle.indexOf("Define temporary production environment path");
  const init = bundle.indexOf("minio-init");
  const firstMigration = bundle.indexOf("run --rm migrate");
  const secondMigration = bundle.indexOf("run --rm migrate", firstMigration + 1);
  const app = bundle.search(/up -d --wait --wait-timeout 120 --no-deps\s+api edge/);
  const smoke = bundle.indexOf("SMOKE_ASSERT_SHUTDOWN=1 node deploy/production/smoke.mjs");
  assert.ok(
    environmentPath >= 0 &&
      environmentPath < dependencies &&
      dependencies >= 0 &&
      init > dependencies &&
      firstMigration > init &&
      secondMigration > firstMigration,
  );
  assert.ok(app > secondMigration && smoke > app);
  assert.match(bundle, /if: failure\(\)[\s\S]*?docker compose[\s\S]*?logs --no-color/);
  assert.match(bundle, /if: always\(\)[\s\S]*?down --volumes --remove-orphans/);
  assert.doesNotMatch(bundle, /docker compose[^\n]* config(?! --quiet)/);
  assert.doesNotMatch(bundle, /(?:cat|printenv|env)[^\n]*\.env\.production/);
  assertCiBundleStructure(bundle);
});

test("main publication pushes only immutable GHCR SHA tags", async () => {
  const release = await source(".github/workflows/release-images.yml");

  assert.match(release, /push:\n    branches: \[main\]/);
  assert.doesNotMatch(release, /pull_request:/);
  assert.match(release, /contents: read/);
  assert.match(release, /packages: write/);
  assert.match(
    release,
    /docker\/setup-buildx-action@e468171a9de216ec08956ac3ada2f0791b6bd435 # v3\.11\.1/,
  );
  assert.match(release, /docker\/login-action@184bdaa0721073962dff0199f1fb9940f07167d1 # v3\.5\.0/);
  assert.match(release, /registry: ghcr\.io/);
  assert.match(release, /username: \$\{\{ github\.actor \}\}/);
  assert.match(release, /password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(
    release,
    /docker\/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83 # v6\.18\.0/g,
  );
  assert.match(release, /file: deploy\/production\/api\.Dockerfile/);
  assert.match(release, /file: deploy\/production\/edge\.Dockerfile/);
  assert.match(release, /push: true/);
  assert.match(release, /ghcr\.io\/thevladbog\/markiro-api:\$\{\{ github\.sha \}\}/);
  assert.match(release, /ghcr\.io\/thevladbog\/markiro-edge:\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(
    release,
    /:latest|:\$\{\{ github\.ref_name \}\}|:\$\{\{ github\.sha \}\}\[:|\.env\.production|docker compose[^\n]* config(?! --quiet)/,
  );
  assertReleaseStructure(release);
});

test("workflow contracts reject unsafe tag, mask, path, and trigger mutations", async () => {
  const ci = await source(".github/workflows/ci.yml");
  const bundle = job(ci, "production-bundle");
  const release = await source(".github/workflows/release-images.yml");

  for (const mutation of [
    bundle.replace('"markiro-development-only"', '"markiro-development-only-removed"'),
    bundle.replace(
      'docker build --file deploy/production/api.Dockerfile --tag "ghcr.io/thevladbog/markiro-api:${{ github.sha }}" .',
      'docker build --file deploy/production/api.Dockerfile --tag "ghcr.io/thevladbog/markiro-api:${{ github.sha }}" --tag "ghcr.io/thevladbog/markiro-api:latest" .',
    ),
    `${bundle}\n      - name: Leak temporary environment\n        run: cat "$MARKIRO_ENV_FILE"\n`,
  ])
    assert.throws(() => assertCiBundleStructure(mutation));

  for (const mutation of [
    release.replace("  push:\n", "  push:\n  workflow_dispatch:\n"),
    release.replace(
      "          tags: ghcr.io/thevladbog/markiro-edge:${{ github.sha }}",
      "          tags: ghcr.io/thevladbog/markiro-edge:latest",
    ),
    release.replace(
      "          tags: ghcr.io/thevladbog/markiro-api:${{ github.sha }}",
      "          tags: ghcr.io/thevladbog/markiro-api:${{ github.sha }}\n          tags: ghcr.io/thevladbog/markiro-api:extra",
    ),
  ])
    assert.throws(() => assertReleaseStructure(mutation));
});
