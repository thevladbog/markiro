import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load as loadYaml } from "js-yaml";

const productionCompose = "compose.production.yml";
const ciCompose = "deploy/production/compose.ci.yml";
const envExample = ".env.production.example";

test("production application services use exact restart policies", async () => {
  const model = loadYaml(await readFile(productionCompose, "utf8"));

  assert.equal(model.services.migrate.restart, "no");
  assert.equal(model.services.api.restart, "unless-stopped");
  assert.equal(model.services.edge.restart, "unless-stopped");
});

test("merged CI Compose config preserves production restart policies", () => {
  const configured = execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      envExample,
      "-f",
      productionCompose,
      "-f",
      ciCompose,
      "config",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ACME_EMAIL: "ops@example.test",
        MARKIRO_DOMAIN: "localhost",
        MARKIRO_ENV_FILE: envExample,
        MARKIRO_IMAGE_TAG: "contract-test",
      },
    },
  );
  const model = JSON.parse(configured);

  assert.equal(model.services.migrate.restart, "no");
  assert.equal(model.services.api.restart, "unless-stopped");
  assert.equal(model.services.edge.restart, "unless-stopped");
});

test("production Compose contains only hardened application services", async () => {
  const compose = await readFile(productionCompose, "utf8");

  const serviceBlock = compose.match(/^services:\n([\s\S]*?)^volumes:/m)?.[1] ?? "";
  const services = serviceBlock.match(/^  ([a-z][a-z-]*):$/gm)?.map((entry) => entry.trim());
  assert.deepEqual(services, ["migrate:", "api:", "edge:"]);
  const migrate = serviceBlock.match(/^  migrate:\n([\s\S]*?)(?=^  api:)/m)?.[1] ?? "";
  const api = serviceBlock.match(/^  api:\n([\s\S]*?)(?=^  edge:)/m)?.[1] ?? "";
  const edge = serviceBlock.match(/^  edge:\n([\s\S]*)$/m)?.[1] ?? "";

  assert.match(
    migrate,
    /^    image: ghcr\.io\/thevladbog\/markiro-api:\$\{MARKIRO_IMAGE_TAG:\?MARKIRO_IMAGE_TAG is required\}$/m,
  );
  assert.match(
    api,
    /^    image: ghcr\.io\/thevladbog\/markiro-api:\$\{MARKIRO_IMAGE_TAG:\?MARKIRO_IMAGE_TAG is required\}$/m,
  );
  assert.match(
    edge,
    /^    image: ghcr\.io\/thevladbog\/markiro-edge:\$\{MARKIRO_IMAGE_TAG:\?MARKIRO_IMAGE_TAG is required\}$/m,
  );
  assert.match(compose, /condition: service_completed_successfully/);
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /tmpfs:\n\s+- \/tmp:rw,noexec,nosuid,size=64m/);
  assert.match(compose, /stop_grace_period: 30s/);
  assert.match(compose, /caddy-data:\/data/);
  assert.match(compose, /caddy-config:\/config/);
  assert.match(compose, /\$\{MARKIRO_HTTP_PORT:-80\}:8080/);
  assert.match(compose, /\$\{MARKIRO_HTTPS_PORT:-443\}:8443/);
  assert.match(compose, /expose:\n\s+- "3000"/);

  assert.doesNotMatch(migrate, /^    ports:/m);
  assert.doesNotMatch(api, /^    ports:/m);
  assert.match(edge, /^    ports:/m);

  for (const forbidden of [
    /postgres:/,
    /mailpit/,
    /minio/,
    /build:/,
    /\.\//,
    /source:/,
    /5432:/,
    /3000:/,
  ]) {
    assert.doesNotMatch(compose, forbidden);
  }
});

test("CI overlay supplies only pinned test dependencies", async () => {
  const compose = await readFile(ciCompose, "utf8");
  const services = compose.match(/^  ([a-z][a-z-]*):$/gm)?.map((entry) => entry.trim());

  assert.deepEqual(services, ["postgres:", "mailpit:", "minio:", "minio-init:"]);
  assert.match(compose, /image: postgres:17-alpine/);
  assert.match(compose, /image: axllent\/mailpit:v1\.30\.0/);
  assert.match(compose, /MP_DATABASE: \/tmp\/mailpit\.db/);
  assert.match(compose, /image: minio\/minio:RELEASE\.2025-09-07T16-13-09Z/);
  assert.match(compose, /image: minio\/mc:RELEASE\.2025-08-13T08-35-41Z/);
  assert.match(compose, /^  minio-init:$/m);
  assert.doesNotMatch(compose, /^  edge:$/m);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.doesNotMatch(compose, /read_only: false/);
  assert.doesNotMatch(compose, /cap_drop: \[\]/);
});

test("production environment example is a blank loadEnv inventory", async () => {
  const example = await readFile(envExample, "utf8");
  const expected = [
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "ADMIN_ORIGIN",
    "KIOSK_ORIGIN",
    "PAIRING_CODE_PEPPER",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM_EMAIL",
    "SMTP_FROM_NAME",
    "SMTP_REPLY_TO",
    "MAIL_PAYLOAD_ENCRYPTION_KEY",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_FORCE_PATH_STYLE",
  ];

  for (const key of expected) assert.match(example, new RegExp(`^${key}=$`, "m"));
  for (const line of example.split("\n")) {
    if (/^[A-Z0-9_]+=/.test(line)) assert.match(line, /^[A-Z0-9_]+=$/);
  }
});
