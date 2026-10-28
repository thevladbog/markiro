import { describe, expect, it } from "vitest";
import { parseUsHostedReleaseManifest } from "../src/deployment/us-hosted-release-manifest";

const digest = "a".repeat(64);
const required = [
  "apps/api/dist/main.us-hosted.js",
  "apps/api/dist/main.us-hosted-worker.js",
  "apps/api/dist/us-request-build.json",
  "apps/api/dist/modules/traceability/plans/assets/IBMPlexSans-Regular.ttf",
  "apps/api/dist/modules/traceability/plans/assets/IBMPlexSans-Bold.ttf",
  "packages/db/dist/index.js",
  "packages/domain/dist/index.js",
  "packages/platform-contracts/dist/index.js",
  "apps/admin/dist-us/index.html",
  "apps/admin/dist-us/.vite/manifest.json",
  "pnpm-lock.yaml",
  "apps/api/package.json",
  "packages/db/package.json",
  "packages/domain/package.json",
  "packages/platform-contracts/package.json",
  "packages/db/migrations/meta/_journal.json",
  "packages/db/migrations/0000_fixture.sql",
];
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function fixture() {
  return {
    schemaVersion: 1,
    edition: "US",
    purpose: "synthetic-demo",
    build: { apiVersion: "fixture-1", gitSha: "b".repeat(40), dirty: false },
    requestBuildDescriptor: {
      path: "apps/api/dist/us-request-build.json",
      sha256: digest,
      digest,
    },
    entrypoints: {
      api: "apps/api/dist/main.us-hosted.js",
      worker: "apps/api/dist/main.us-hosted-worker.js",
    },
    files: required.sort(compare).map((path) => ({ path, byteSize: 1, sha256: digest })),
  };
}
const parse = (value: unknown) => parseUsHostedReleaseManifest(JSON.stringify(value));
function rejects(value: unknown) {
  try {
    parse(value);
    expect.fail("Expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error).toMatchObject({ message: "us_hosted_release_manifest_invalid" });
      expect(Object.hasOwn(error, "cause")).toBe(false);
    }
  }
}

describe("unverified hosted release manifest admission", () => {
  it("admits complete expectations and deeply freezes every nested container", () => {
    const expected = fixture();
    const result = parse(expected);
    expect(result).toEqual(expected);
    for (const value of [
      result,
      result.build,
      result.entrypoints,
      result.requestBuildDescriptor,
      result.files,
      ...result.files,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expected.files[0] = { path: "foreign", byteSize: 0, sha256: digest };
    expect(result.files[0]?.path).not.toBe("foreign");
    expect(Object.keys(result).sort()).toEqual(Object.keys(fixture()).sort());
  });

  it.each(required)("requires nonempty artifact %s", (path) => {
    const missing = fixture();
    missing.files = missing.files.filter((file) => file.path !== path);
    rejects(missing);
    const empty = fixture();
    const file = empty.files.find((entry) => entry.path === path);
    if (!file) throw new Error("Missing synthetic artifact");
    file.byteSize = 0;
    rejects(empty);
  });

  it.each([
    "/escape",
    "../escape",
    "apps/api/dist/../escape",
    "apps/api/dist//x",
    "apps/api/dist/./x",
    "apps/api/dist/x/",
    "apps/api/dist/x\\y",
    "apps/api/dist/x:y",
    "apps/api/dist/%2e",
    "apps/api/dist/x\0",
    "apps/api/dist/x\n",
    "apps/api/dist/é",
    "node_modules/x",
    "apps/api/dist/node_modules/x",
    "apps/api/src/x.ts",
    "apps/api/dist-other/x",
    "us-synthetic-release.json",
    ".env",
    "apps/api/dist/.env",
    "apps/api/dist/.env.production",
    "apps/api/dist/tls.key",
    "apps/api/dist/tls.pem",
    "apps/api/dist/tls.crt",
    "backups/db.sql",
    `apps/api/dist/${"x".repeat(4096)}`,
  ])("rejects unsafe inventory path %s", (path) => {
    const value = fixture();
    value.files.push({ path, byteSize: 1, sha256: digest });
    value.files.sort((a, b) => compare(a.path, b.path));
    rejects(value);
  });

  it("rejects duplicate, descending and file-directory prefix collisions", () => {
    const duplicate = fixture();
    duplicate.files.push({
      ...duplicate.files[0],
      path: "pnpm-lock.yaml",
      byteSize: 1,
      sha256: digest,
    });
    duplicate.files.sort((a, b) => compare(a.path, b.path));
    rejects(duplicate);
    const reversed = fixture();
    reversed.files.reverse();
    rejects(reversed);
    const collision = fixture();
    collision.files.push(
      { path: "apps/api/dist/a", byteSize: 0, sha256: digest },
      { path: "apps/api/dist/a/b", byteSize: 1, sha256: digest },
    );
    collision.files.sort((a, b) => compare(a.path, b.path));
    rejects(collision);
  });

  it.each([-1, 0.5, 33_554_433, NaN, Infinity])("rejects invalid file size %s", (byteSize) => {
    const value = fixture();
    value.files.push({ path: "apps/api/dist/extra", byteSize, sha256: digest });
    value.files.sort((a, b) => compare(a.path, b.path));
    rejects(value);
  });

  it("accepts zero optional bytes and the exact per-file limit", () => {
    const value = fixture();
    value.files.push(
      { path: "apps/api/dist/empty", byteSize: 0, sha256: digest },
      { path: "apps/api/dist/large", byteSize: 33_554_432, sha256: digest },
    );
    value.files.sort((a, b) => compare(a.path, b.path));
    expect(parse(value).files).toHaveLength(required.length + 2);
  });

  it("counts every inventory byte at the exact aggregate limit", () => {
    const value = fixture();
    for (let index = 0; index < 8; index++)
      value.files.push({
        path: `apps/api/dist/large-${index}`,
        byteSize: 33_554_432 - (index === 7 ? required.length : 0),
        sha256: digest,
      });
    value.files.sort((a, b) => compare(a.path, b.path));
    expect(parse(value).files).toHaveLength(required.length + 8);
    const last = value.files.find((file) => file.path.endsWith("large-7"));
    if (!last) throw new Error("Missing synthetic artifact");
    last.byteSize++;
    rejects(value);
  });

  it("rejects oversized cardinality even when the document bound rejects first", () => {
    const value = fixture();
    for (let index = 0; index < 10_001; index++)
      value.files.push({
        path: `apps/api/dist/extra-${index}`,
        byteSize: 0,
        sha256: digest,
      });
    value.files.sort((a, b) => compare(a.path, b.path));
    rejects(value);
    rejects({ ...fixture(), files: [] });
  });

  it.each([
    "schemaVersion",
    "edition",
    "purpose",
    "build",
    "entrypoints",
    "requestBuildDescriptor",
  ])("refuses absent strict field %s", (key) => {
    const value: Record<string, unknown> = fixture();
    delete value[key];
    rejects(value);
  });
  it("rejects identity, local entry aliases and unknown nested keys", () => {
    const value = fixture();
    rejects({ ...value, schemaVersion: 2 });
    rejects({ ...value, edition: "RU" });
    rejects({ ...value, purpose: "production" });
    rejects({ ...value, origin: "https://foreign.invalid" });
    rejects({ ...value, build: { ...value.build, dirty: true } });
    rejects({ ...value, build: { ...value.build, gitSha: "B".repeat(40) } });
    rejects({ ...value, build: { ...value.build, foreign: true } });
    rejects({ ...value, entrypoints: { ...value.entrypoints, api: "apps/api/dist/main.us.js" } });
    rejects({
      ...value,
      entrypoints: { ...value.entrypoints, worker: "apps/api/dist/main.us-request-worker.js" },
    });
    rejects({ ...value, entrypoints: { ...value.entrypoints, foreign: true } });
    rejects({
      ...value,
      requestBuildDescriptor: { ...value.requestBuildDescriptor, path: "foreign" },
    });
    rejects({
      ...value,
      requestBuildDescriptor: { ...value.requestBuildDescriptor, sha256: "A".repeat(64) },
    });
    rejects({ ...value, requestBuildDescriptor: { ...value.requestBuildDescriptor, digest: "0" } });
    rejects({
      ...value,
      requestBuildDescriptor: { ...value.requestBuildDescriptor, foreign: true },
    });
    rejects({ ...value, files: value.files.map((file) => ({ ...file, foreign: true })) });
    rejects({ ...value, files: value.files.map((file) => ({ ...file, sha256: "z".repeat(64) })) });
  });

  it("checks UTF8 document bytes before parsing without coercing non-strings", () => {
    const text = JSON.stringify(fixture());
    const padded = text + " ".repeat(1_048_576 - Buffer.byteLength(text));
    expect(parseUsHostedReleaseManifest(padded).edition).toBe("US");
    for (const value of [
      padded + " ",
      "",
      "{",
      text.replace("fixture-1", "\ud800"),
      text + "é".repeat(524_288),
    ])
      expect(() => parseUsHostedReleaseManifest(value)).toThrow(
        "us_hosted_release_manifest_invalid",
      );
    let effects = 0;
    const hostile = {
      toJSON() {
        effects++;
        throw new Error("private");
      },
      [Symbol.toPrimitive]() {
        effects++;
        throw new Error("private");
      },
    };
    Object.defineProperty(hostile, "secret", {
      get() {
        effects++;
        throw new Error("private");
      },
    });
    for (const input of [hostile, new String(text), Buffer.from(text), null, undefined, 7]) {
      // Exercise the JavaScript boundary without weakening its public string signature.
      // @ts-expect-error deliberately invalid external value
      expect(() => parseUsHostedReleaseManifest(input)).toThrow(
        "us_hosted_release_manifest_invalid",
      );
    }
    expect(effects).toBe(0);
  });
});
