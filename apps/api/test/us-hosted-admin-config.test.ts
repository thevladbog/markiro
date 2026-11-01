import { expect, it } from "vitest";
import {
  parseUsHostedAdminConfig,
  parseUsHostedAdminOperation,
} from "../src/deployment/us-hosted-admin-config";

function fixture(operation: "migrate" | "seed" | "provision" = "migrate") {
  return {
    schemaVersion: 1,
    edition: "US",
    purpose: "synthetic-demo",
    mode: "production",
    service: "admin",
    operation,
    release: {
      sourceSha: "a".repeat(40),
      manifestSha256: "b".repeat(64),
      adminManifestSha256: "c".repeat(64),
    },
    database: {
      host: "postgres.us-demo.internal",
      port: 5432,
      name: "markiro_us_synthetic",
      user: "markiro_us",
      caFile: "/run/secrets/us-demo/db-ca.pem",
      passwordFile: `/run/secrets/us-demo/admin-${operation}-db-password`,
    },
    ...(operation === "seed"
      ? {
          storage: {
            endpoint: "https://objects.us-demo.internal",
            bucket: "markiro-us-synthetic-private",
            signingRegion: "us-east-1",
            caFile: "/run/secrets/us-demo/storage-ca.pem",
            accessKeyFile: "/run/secrets/us-demo/admin-seed-storage-access-key",
            secretKeyFile: "/run/secrets/us-demo/admin-seed-storage-secret-key",
            forcePathStyle: true,
          },
        }
      : {}),
  };
}

it.each(["migrate", "seed", "provision"] as const)(
  "admits frozen %s expectations only",
  (operation) => {
    expect(parseUsHostedAdminOperation([operation])).toBe(operation);
    const input = fixture(operation);
    const result = parseUsHostedAdminConfig(JSON.stringify(input), operation);
    expect(result).toEqual(input);
    for (const value of [result, result.database, result.release])
      expect(Object.isFrozen(value)).toBe(true);
    if (result.operation === "seed") expect(Object.isFrozen(result.storage)).toBe(true);
    expect(Reflect.set(result.database, "user", "other")).toBe(false);
  },
);

it("binds a valid document to the independently selected operation", () => {
  expect(() => parseUsHostedAdminConfig(JSON.stringify(fixture("seed")), "migrate")).toThrow(
    "us_hosted_admin_config_invalid",
  );
});

it.each(
  [[], ["other"], ["seed", "extra"], ["seed\n"], ["--operation=seed"]].map((args) => ({ args })),
)("rejects missing or ambiguous argv %#", ({ args }) => {
  expect(() => parseUsHostedAdminOperation(args)).toThrow("us_hosted_admin_operation_invalid");
});

it("rejects structural caller misuse", () => {
  for (const args of [null, "seed", { 0: "seed", length: 1 }, [null]])
    expect(() => Reflect.apply(parseUsHostedAdminOperation, undefined, [args])).toThrow(
      "us_hosted_admin_operation_invalid",
    );
  for (const operation of [null, "api", "seed\n"])
    expect(() =>
      Reflect.apply(parseUsHostedAdminConfig, undefined, [JSON.stringify(fixture()), operation]),
    ).toThrow("us_hosted_admin_config_invalid");
});

it("refuses wrong paths, cross-operation credentials, unknown fields and runtime authority", () => {
  const value = fixture();
  const seed = fixture("seed");
  for (const input of [
    { ...value, edition: "RU" },
    { ...value, mode: "development" },
    { ...value, service: "api" },
    { ...value, operation: "other" },
    { ...value, auth: { secretFile: "/run/secrets/us-demo/api-auth-secret" } },
    { ...value, publicOrigin: "https://demo.example.test" },
    {
      ...value,
      database: { ...value.database, passwordFile: "/run/secrets/us-demo/admin-seed-db-password" },
    },
    { ...value, database: { ...value.database, user: "markiro_us_api" } },
    { ...value, database: { ...value.database, host: "postgres://user:synthetic-canary@host" } },
    { ...value, database: { ...value.database, caFile: "/run/secrets/us-demo/../db-ca.pem" } },
    { ...value, database: { ...value.database, password: "synthetic-canary" } },
    { ...value, storage: seed.storage },
    { ...value, release: { ...value.release, sourceSha: "A".repeat(40) } },
    { ...value, release: { ...value.release, manifestSha256: "b".repeat(63) } },
    { ...value, release: { ...value.release, adminManifestSha256: "C".repeat(64) } },
    { ...value, release: { ...value.release, extra: true } },
    null,
    [],
  ])
    expect(() => parseUsHostedAdminConfig(JSON.stringify(input), "migrate")).toThrow(
      "us_hosted_admin_config_invalid",
    );
  for (const storage of [
    undefined,
    { ...seed.storage, signingRegion: "us-east-1\n" },
    { ...seed.storage, signingRegion: "x".repeat(64) },
    { ...seed.storage, endpoint: "http://objects.us-demo.internal" },
    { ...seed.storage, accessKeyFile: "/run/secrets/us-demo/api-storage-access-key" },
    { ...seed.storage, extra: true },
  ])
    expect(() => parseUsHostedAdminConfig(JSON.stringify({ ...seed, storage }), "seed")).toThrow(
      "us_hosted_admin_config_invalid",
    );
});

it("bounds exact UTF8 bytes and redacts malformed configuration", () => {
  const document = JSON.stringify(fixture());
  expect(parseUsHostedAdminConfig(document.padStart(16384, " "), "migrate")).toEqual(fixture());
  for (const input of [document.padStart(16385, " "), "", "{", "\ud800", ` ${document}\ud800`]) {
    let error: unknown;
    try {
      parseUsHostedAdminConfig(input, "migrate");
    } catch (caught) {
      error = caught;
    }
    expect(error).toHaveProperty("message", "us_hosted_admin_config_invalid");
    expect(error).not.toHaveProperty("cause");
  }
});

it("rejects trailing line endings in exact source and digest identities", () => {
  const input = fixture();
  for (const key of ["sourceSha", "manifestSha256", "adminManifestSha256"] as const)
    expect(() =>
      parseUsHostedAdminConfig(
        JSON.stringify({
          ...input,
          release: { ...input.release, [key]: `${input.release[key]}\n` },
        }),
        "migrate",
      ),
    ).toThrow("us_hosted_admin_config_invalid");
});
