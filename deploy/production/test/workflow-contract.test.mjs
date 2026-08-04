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

test("CI verifies the production bundle with scoped, secret-safe Docker cleanup", async () => {
  const ci = await source(".github/workflows/ci.yml");
  const bundle = job(ci, "production-bundle");

  assert.match(bundle, /^    timeout-minutes: 20$/m);
  assert.doesNotMatch(bundle, /^    permissions:\n(?:.*\n)*?      packages: write$/m);
  assert.match(bundle, /MARKIRO_IMAGE_TAG: \$\{\{ github\.sha \}\}/);
  assert.match(bundle, /MARKIRO_DOMAIN: localhost/);
  assert.match(bundle, /MARKIRO_HTTP_PORT: "18080"/);
  assert.match(bundle, /MARKIRO_HTTPS_PORT: "18443"/);
  assert.match(bundle, /MARKIRO_ENV_FILE: \$\{\{ runner\.temp \}\}\/markiro-production-test\.env/);
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
  const init = bundle.indexOf("minio-init");
  const firstMigration = bundle.indexOf("run --rm migrate");
  const secondMigration = bundle.indexOf("run --rm migrate", firstMigration + 1);
  const app = bundle.search(/up -d --wait --wait-timeout 120 --no-deps\s+api edge/);
  const smoke = bundle.indexOf("SMOKE_ASSERT_SHUTDOWN=1 node deploy/production/smoke.mjs");
  assert.ok(
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
});
