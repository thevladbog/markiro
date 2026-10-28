import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { loadUsDevelopmentEnv, assertRuEntryEdition } from "../src/deployment/entry-policy";
import { parseUsSyntheticHostedConfig } from "../src/deployment/us-synthetic-hosted-config";

function fixture(service: "api" | "worker" = "api") {
  return {
    schemaVersion: 1,
    edition: "US",
    purpose: "synthetic-demo",
    mode: "production",
    service,
    publicOrigin: "https://demo.example.test",
    database: {
      host: "postgres.us-demo.internal",
      port: 5432,
      name: "markiro_us_synthetic",
      user: `markiro_us_${service}`,
      caFile: "/run/secrets/us-demo/db-ca.pem",
      passwordFile: `/run/secrets/us-demo/${service}-db-password`,
    },
    storage: {
      endpoint: "https://objects.us-demo.internal",
      bucket: "markiro-us-synthetic-private",
      signingRegion: "us-east-1",
      caFile: "/run/secrets/us-demo/storage-ca.pem",
      accessKeyFile: `/run/secrets/us-demo/${service}-storage-access-key`,
      secretKeyFile: `/run/secrets/us-demo/${service}-storage-secret-key`,
      forcePathStyle: true,
    },
    ...(service === "api"
      ? {
          tls: {
            certificateFile: "/run/secrets/us-demo/api-cert.pem",
            privateKeyFile: "/run/secrets/us-demo/api-key.pem",
          },
        }
      : {}),
    release: {
      sourceSha: "a".repeat(40),
      manifestSha256: "b".repeat(64),
      manifestFile: "/app/us-synthetic-release.json",
    },
  };
}

const api = fixture();
function refused(document: string, expected: "api" | "worker" = "api") {
  let failure: unknown;
  try {
    parseUsSyntheticHostedConfig(document, expected);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty("message", "us_synthetic_hosted_config_invalid");
  expect(failure).not.toHaveProperty("cause");
}

describe("synthetic hosted configuration admission", () => {
  it.each(["api", "worker"] as const)("admits explicit synthetic %s configuration", (service) => {
    const input = fixture(service);
    const before = JSON.stringify(input);
    const parsed = parseUsSyntheticHostedConfig(before, service);
    expect(parsed).toEqual(input);
    expect(JSON.stringify(input)).toBe(before);
    for (const value of [parsed, parsed.database, parsed.storage, parsed.release])
      expect(Object.isFrozen(value)).toBe(true);
    if (parsed.service === "api") expect(Object.isFrozen(parsed.tls)).toBe(true);
    expect(Reflect.set(parsed.database, "user", "markiro_us")).toBe(false);
    refused(before, service === "api" ? "worker" : "api");
  });

  it.each([
    { ...api, schemaVersion: 2 },
    { ...api, edition: "RU" },
    { ...api, purpose: "production" },
    { ...api, mode: "development" },
    { ...api, service: "admin" },
    { ...api, NODE_ENV: "production" },
    { ...api, tls: undefined },
    { ...api, tls: { ...api.tls, privateKeyFile: "/tmp/key" } },
    { ...api, database: { ...api.database, host: "localhost" } },
    { ...api, database: { ...api.database, port: 55432 } },
    { ...api, database: { ...api.database, name: "markiro_us_dev" } },
    { ...api, database: { ...api.database, user: "markiro_us" } },
    { ...api, database: { ...api.database, user: "markiro_us_worker" } },
    {
      ...api,
      database: { ...api.database, passwordFile: "/run/secrets/us-demo/worker-db-password" },
    },
    { ...api, database: { ...api.database, caFile: "/run/secrets/us-demo/../db-ca.pem" } },
    { ...api, database: { ...api.database, password: "synthetic-canary-secret" } },
    { ...api, storage: { ...api.storage, endpoint: "http://objects.us-demo.internal" } },
    { ...api, storage: { ...api.storage, bucket: "markiro-private" } },
    { ...api, storage: { ...api.storage, signingRegion: "A/invalid" } },
    { ...api, storage: { ...api.storage, signingRegion: "us-east-1\n" } },
    { ...api, storage: { ...api.storage, signingRegion: "x".repeat(64) } },
    {
      ...api,
      storage: { ...api.storage, accessKeyFile: "/run/secrets/us-demo/worker-storage-access-key" },
    },
    {
      ...api,
      storage: { ...api.storage, secretKeyFile: "/run/secrets/us-demo/worker-storage-secret-key" },
    },
    { ...api, storage: { ...api.storage, forcePathStyle: false } },
    { ...api, storage: { ...api.storage, caFile: "/tmp/ca" } },
    { ...api, storage: { ...api.storage, extra: true } },
    { ...api, tls: { ...api.tls, extra: true } },
    { ...api, release: { ...api.release, sourceSha: "A".repeat(40) } },
    { ...api, release: { ...api.release, manifestSha256: "b".repeat(63) } },
    { ...api, release: { ...api.release, manifestFile: "/app/../manifest.json" } },
    { ...api, release: { ...api.release, accepted: true } },
    null,
    [],
  ])("refuses an invalid document without exposing it %#", (value) =>
    refused(JSON.stringify(value)),
  );

  it.each([
    "http://demo.example.test",
    "https://demo.example.test/",
    "https://Demo.example.test",
    "https://demo.example.test:443",
    "https://demo.example.test:8443",
    "https://demo.example.test/path",
    "https://demo.example.test?token=synthetic-canary-secret",
    "https://demo.example.test#fragment",
    "https://user:synthetic-canary-secret@demo.example.test",
    "https://localhost",
    "https://demo.localhost",
    "https://demo.local",
    "https://demo.internal",
    "https://127.0.0.1",
    "https://[::1]",
    "https://demo.example.test.",
    "https://-demo.example.test",
    "https://demo_.example.test",
    `https://${"a".repeat(64)}.example.test`,
  ])("refuses ambiguous or nonpublic-shaped origin %#", (publicOrigin) =>
    refused(JSON.stringify({ ...api, publicOrigin })),
  );

  it("refuses worker inbound TLS and cross-service secret references", () => {
    const worker = fixture("worker");
    refused(JSON.stringify({ ...worker, tls: api.tls }), "worker");
    refused(JSON.stringify({ ...worker, database: api.database }), "worker");
    refused(JSON.stringify({ ...worker, storage: api.storage }), "worker");
  });

  it.each([
    "",
    "synthetic-canary-secret",
    '{"password":"synthetic-canary-secret"',
    " ".repeat(16385),
  ])("never leaks malformed or oversized configuration %#", (document) => refused(document));

  it("bounds valid documents and rejects invalid expected-service values", () => {
    const document = JSON.stringify(api);
    const atLimit = document.padStart(16384, " ");
    expect(parseUsSyntheticHostedConfig(atLimit, "api")).toEqual(api);
    refused(` ${atLimit}`);
    expect(() => Reflect.apply(parseUsSyntheticHostedConfig, undefined, [null, "api"])).toThrow(
      "us_synthetic_hosted_config_invalid",
    );
    expect(() =>
      Reflect.apply(parseUsSyntheticHostedConfig, undefined, [JSON.stringify(api), "admin"]),
    ).toThrow("us_synthetic_hosted_config_invalid");
  });

  it("keeps actual local and RU entry rejection with valid local acceptance", () => {
    const local = parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8"));
    expect(loadUsDevelopmentEnv(local).PORT).toBe(3100);
    expect(() =>
      loadUsDevelopmentEnv({ ...local, NODE_ENV: "production", BETTER_AUTH_URL: api.publicOrigin }),
    ).toThrow();
    expect(() => assertRuEntryEdition("US")).toThrow();
  });
});
