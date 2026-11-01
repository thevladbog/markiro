import { expect, it } from "vitest";
import { parseUsHostedAdminManifest } from "../src/deployment/us-hosted-admin-manifest";

const fixture = {
  schemaVersion: 1,
  edition: "US",
  purpose: "synthetic-demo",
  sourceSha: "a".repeat(40),
  runtimeManifestSha256: "b".repeat(64),
  entrypoint: {
    path: "apps/api/dist/main.us-hosted-admin.js",
    byteSize: 123,
    sha256: "c".repeat(64),
  },
};
it("admits only immutable administrative supplement expectations", () => {
  const value = parseUsHostedAdminManifest(JSON.stringify(fixture));
  expect(value).toEqual(fixture);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.entrypoint)).toBe(true);
  expect(Reflect.set(value.entrypoint, "path", "other")).toBe(false);
});
it("refuses another executable, source, digest, size or unknown attestation fields", () => {
  for (const value of [
    null,
    [],
    { ...fixture, schemaVersion: 2 },
    { ...fixture, edition: "RU" },
    { ...fixture, extra: true },
    { ...fixture, sourceSha: "a".repeat(39) },
    { ...fixture, runtimeManifestSha256: "B".repeat(64) },
    ...[
      "apps/api/dist/main.us-hosted.js",
      "/app/apps/api/dist/main.us-hosted-admin.js",
      "apps/api/dist/../main.us-hosted-admin.js",
    ].map((path) => ({ ...fixture, entrypoint: { ...fixture.entrypoint, path } })),
    ...[0, -1, 1.5, 32 * 1024 * 1024 + 1].map((byteSize) => ({
      ...fixture,
      entrypoint: { ...fixture.entrypoint, byteSize },
    })),
    { ...fixture, entrypoint: { ...fixture.entrypoint, sha256: "c".repeat(65) } },
    { ...fixture, entrypoint: { ...fixture.entrypoint, extra: true } },
  ])
    expect(() => parseUsHostedAdminManifest(JSON.stringify(value))).toThrow(
      "us_hosted_admin_manifest_invalid",
    );
});
it("uses a fatal UTF8 and exact 1MiB document bound with redacted errors", () => {
  const document = JSON.stringify(fixture);
  expect(parseUsHostedAdminManifest(document.padStart(1024 * 1024, " "))).toEqual(fixture);
  for (const value of [document.padStart(1024 * 1024 + 1, " "), "", "{", "\ud800", null]) {
    let error: unknown;
    try {
      Reflect.apply(parseUsHostedAdminManifest, undefined, [value]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toHaveProperty("message", "us_hosted_admin_manifest_invalid");
    expect(error).not.toHaveProperty("cause");
  }
});

it("rejects trailing line endings in exact supplement identities", () => {
  for (const key of ["sourceSha", "runtimeManifestSha256"] as const)
    expect(() =>
      parseUsHostedAdminManifest(JSON.stringify({ ...fixture, [key]: `${fixture[key]}\n` })),
    ).toThrow("us_hosted_admin_manifest_invalid");
  expect(() =>
    parseUsHostedAdminManifest(
      JSON.stringify({
        ...fixture,
        entrypoint: { ...fixture.entrypoint, sha256: `${fixture.entrypoint.sha256}\n` },
      }),
    ),
  ).toThrow("us_hosted_admin_manifest_invalid");
});
