import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, release } from "./admission-fixtures.mjs";

export function hostEnv(manifest, root) {
  return {
    SERVER_PROFILE: "platform-only",
    VITE_SERVER_PROFILE: "platform-only",
    MARKIRO_SOURCE_SHA: manifest.sourceSha,
    MARKIRO_TOOLING_SHA: manifest.toolingSha,
    MARKIRO_API_IMAGE_DIGEST: manifest.api.split("@")[1],
    MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: manifest.edge.split("@")[1],
    MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.markiro.app",
    MARKIRO_LANDING_DOMAIN: "markiro.app",
    MARKIRO_RETIRED_ADMIN_DOMAIN: "admin.markiro.app",
    MARKIRO_RETIRED_KIOSK_DOMAIN: "kiosk.markiro.app",
    SAAS_ADMIN_ORIGIN: "https://saas-admin.markiro.app",
    PLATFORM_AUTH_URL: "https://saas-admin.markiro.app",
    LANDING_ORIGIN: "https://markiro.app",
    DATABASE_URL: "postgresql://test:fixture-only@db.private/markiro?sslmode=verify-full",
    PLATFORM_AUTH_SECRET: "fixture-only-configuration-secret-".repeat(2),
    MAIL_PAYLOAD_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    S3_ENDPOINT: "https://s3.example.org",
    S3_PUBLIC_ORIGIN: "https://s3.example.org",
    S3_REGION: "region",
    S3_BUCKET: "markiro-private",
    S3_ACCESS_KEY_ID: "fixture-access",
    S3_SECRET_ACCESS_KEY: "fixture-secret",
    S3_FORCE_PATH_STYLE: "true",
    SMTP_HOST: "smtp.example.org",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "sender",
    SMTP_PASSWORD: "fixture-password",
    SMTP_FROM_EMAIL: "mail@markiro.app",
    SMTP_FROM_NAME: "Маркиро",
    ACME_EMAIL: "ops@markiro.app",
    LANDING_DEMO_SUBMISSION_ENABLED: "false",
    SUPPORT_CHAT_ENABLED: "false",
    MARKIRO_POSTGRES_IMAGE_DIGEST: digest("f"),
    MARKIRO_POSTGRES_CA_FILE: join(root, "pg", "ca.crt"),
    MARKIRO_POSTGRES_SERVER_CERT_FILE: join(root, "pg", "server.crt"),
    MARKIRO_POSTGRES_SERVER_KEY_FILE: join(root, "pg", "server.key"),
    MARKIRO_POSTGRES_PASSWORD_FILE: join(root, "pg", "password"),
  };
}

export const envBytes = (env) =>
  Buffer.from(
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );

export async function privateFixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "markiro-host-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { manifest } = release();
  const env = hostEnv(manifest, root);
  const envFile = join(root, "source.env");
  const dockerConfig = join(root, "docker");
  await mkdir(dockerConfig, { mode: 0o700 });
  await mkdir(join(root, "pg"), { mode: 0o700 });
  for (const key of [
    "MARKIRO_POSTGRES_CA_FILE",
    "MARKIRO_POSTGRES_SERVER_CERT_FILE",
    "MARKIRO_POSTGRES_SERVER_KEY_FILE",
    "MARKIRO_POSTGRES_PASSWORD_FILE",
  ])
    await writeFile(env[key], "fixture-only\n", { mode: 0o600 });
  const writeEnv = (value = env) => writeFile(envFile, envBytes(value), { mode: 0o600 });
  await writeEnv();
  return { root, manifest, env, envFile, dockerConfig, candidateId: randomUUID(), writeEnv };
}
