import { describe, expect, it } from "vitest";
import {
  catalogIntentViewSchema,
  catalogPublicationResultSchema,
  releaseIdentitySchema,
  releaseFileSpecSchema,
  releaseVersionIdSchema,
  publicationRequestSchema,
  publicationIntentRequestSchema,
  publicationCommitRequestSchema,
  channelSnapshotSchema,
  channelChangeRequestSchema,
} from "../src/release-catalog.js";

const file = {
  name: "markiro-standalone-1.0.0.update.jws",
  sha256: "a".repeat(64),
  sizeBytes: 900,
  contentType: "application/octet-stream",
};
const request = {
  identity: { product: "standalone", channel: "stable", version: "1.0.0" },
  sourceSha: "b".repeat(40),
  files: [file],
  evidence: { kind: "standalone", manifestName: file.name },
};
const id = "3890cfde-dec7-44fe-885e-b7b4444db6b9";

describe("release catalog admission contracts", () => {
  it("accepts bounded requests without making a publication claim", () => {
    expect(publicationRequestSchema.parse(request)).toEqual(request);
    expect(
      publicationIntentRequestSchema.parse({ idempotencyKey: id, publication: request }),
    ).toEqual({ idempotencyKey: id, publication: request });
  });
  it.each(["bucket", "key", "publicPath", "versionId", "registered", "actorId"])(
    "rejects caller-owned %s",
    (field) => {
      expect(publicationRequestSchema.safeParse({ ...request, [field]: "injected" }).success).toBe(
        false,
      );
      expect(
        publicationRequestSchema.safeParse({
          ...request,
          files: [{ ...file, [field]: "injected" }],
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    "",
    ".",
    "..",
    "../x",
    "x/y",
    "x\\y",
    "%2e%2e",
    "x%2Fy",
    "https://evil/x",
    "file?versionId=x",
    "x#y",
    "x\n",
    " x",
    "x ",
    "é.exe",
  ])("rejects ambiguous filename %j", (name) => {
    expect(releaseFileSpecSchema.safeParse({ ...file, name }).success).toBe(false);
  });
  it("rejects duplicate and case-aliased names, empty and excessive file sets", () => {
    for (const files of [
      [],
      [file, file],
      [file, { ...file, name: file.name.toUpperCase() }],
      Array.from({ length: 17 }, (_, i) => ({ ...file, name: `file${i}` })),
    ]) {
      expect(publicationRequestSchema.safeParse({ ...request, files }).success).toBe(false);
    }
  });
  it("bounds bytes and header values before storage access", () => {
    for (const sizeBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, 512 * 1024 * 1024 + 1])
      expect(releaseFileSpecSchema.safeParse({ ...file, sizeBytes }).success).toBe(false);
    expect(releaseFileSpecSchema.safeParse({ ...file, sizeBytes: 512 * 1024 * 1024 }).success).toBe(
      true,
    );
    for (const contentType of [
      "text/html",
      "application/json\r\nX-Test: injected",
      "",
      "APPLICATION/JSON",
    ])
      expect(releaseFileSpecSchema.safeParse({ ...file, contentType }).success).toBe(false);
    expect(
      publicationRequestSchema.safeParse({
        ...request,
        files: Array.from({ length: 5 }, (_, i) => ({
          ...file,
          name: i === 0 ? file.name : `file${i}`,
          sizeBytes: 512 * 1024 * 1024,
        })),
      }).success,
    ).toBe(false);
  });
  it.each([
    [{ product: "station", channel: "beta", version: "2.4.0-beta.5" }, true],
    [{ product: "station", channel: "stable", version: "2.3.0" }, true],
    [{ product: "station", channel: "beta", version: "2.4.0" }, false],
    [{ product: "station", channel: "stable", version: "2.4.0-beta.5" }, false],
    [{ product: "station", channel: "beta", version: "2.4.0-beta.0" }, false],
    [{ product: "station", channel: "stable", version: "9007199254740992.0.0" }, false],
    [{ product: "standalone", channel: "beta", version: "1.0.0-beta.1" }, false],
    [{ product: "standalone", channel: "stable", version: "01.0.0" }, false],
    [{ product: "handheld", channel: "stable", version: "1.7.0" }, true],
    [{ product: "handheld", channel: "stable", version: "1.7.0/../1.6.1" }, false],
    [{ product: "signer", channel: "beta", version: "1.0.0" }, false],
    [{ product: "signer", channel: "stable", version: "1.0.0" }, true],
  ])("keeps the product/channel version grammar %j", (identity, valid) => {
    expect(releaseIdentitySchema.safeParse(identity).success).toBe(valid);
  });
  it("binds evidence kind and referenced file to the publication", () => {
    for (const evidence of [
      { kind: "station", manifestName: file.name, evidenceName: "release-evidence.json" },
      { kind: "standalone", manifestName: "missing.jws" },
      { ...request.evidence, signatureVerified: true },
    ])
      expect(publicationRequestSchema.safeParse({ ...request, evidence }).success).toBe(false);
    expect(
      publicationRequestSchema.safeParse({
        ...request,
        identity: { product: "signer", channel: "stable", version: "1.0.0" },
      }).success,
    ).toBe(false);
  });
  it("requires bounded Android version code and fixed manifest name", () => {
    const handheld = {
      identity: { product: "handheld", channel: "stable", version: "1.7.0" },
      sourceSha: request.sourceSha,
      files: [{ ...file, name: "manifest.json", contentType: "application/json" }],
      evidence: { kind: "handheld", manifestName: "manifest.json", versionCode: 16 },
    };
    expect(publicationRequestSchema.safeParse(handheld).success).toBe(true);
    for (const versionCode of [0, 1.1, 2147483648])
      expect(
        publicationRequestSchema.safeParse({
          ...handheld,
          evidence: { ...handheld.evidence, versionCode },
        }).success,
      ).toBe(false);
  });
  it.each(["", "null", " NULL ", " ", "abc\0", "abc\n", "x".repeat(1025), "é".repeat(513)])(
    "rejects unusable VersionId %j",
    (versionId) => {
      expect(releaseVersionIdSchema.safeParse(versionId).success).toBe(false);
    },
  );
  it("keeps an opaque VersionId intact and binds it only to a filename", () => {
    const versionId = "a/b+c==?x&y";
    expect(releaseVersionIdSchema.parse(versionId)).toBe(versionId);
    expect(
      publicationCommitRequestSchema.parse({ files: [{ name: file.name, versionId }] }),
    ).toEqual({ files: [{ name: file.name, versionId }] });
    expect(
      publicationCommitRequestSchema.safeParse({
        files: [{ name: file.name, versionId, key: "arbitrary" }],
      }).success,
    ).toBe(false);
    expect(
      publicationCommitRequestSchema.safeParse({
        files: [
          { name: file.name, versionId },
          { name: file.name, versionId: "another" },
        ],
      }).success,
    ).toBe(false);
  });
  it("requires a canonical bounded revision and explicit transition operation", () => {
    const snapshot = {
      identity: { product: "standalone", channel: "stable" },
      revision: "9223372036854775807",
      publicationId: id,
      readable: true,
    };
    expect(channelSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    for (const revision of [1, "01", "-1", "1e1", "9223372036854775808"])
      expect(channelSnapshotSchema.safeParse({ ...snapshot, revision }).success).toBe(false);
    const change = {
      operationId: id,
      expectedRevision: "0",
      targetPublicationId: id,
      kind: "forward",
    };
    expect(channelChangeRequestSchema.parse(change)).toEqual(change);
    expect(channelChangeRequestSchema.safeParse({ targetPublicationId: id }).success).toBe(false);
    expect(
      channelChangeRequestSchema.safeParse({ ...change, latest: { url: "https://evil" } }).success,
    ).toBe(false);
  });
});

it("response contracts bind upload keys and public paths without extra credentials", () => {
  const intent = {
    id,
    identity: request.identity,
    state: "pending",
    expiresAt: "2026-10-24T18:00:00.000Z",
    files: [{ ...file, key: `standalone/_uploads/${id}/${file.name}` }],
  };
  expect(catalogIntentViewSchema.parse(intent)).toEqual(intent);
  expect(
    catalogIntentViewSchema.safeParse({ ...intent, secretAccessKey: "forbidden" }).success,
  ).toBe(false);
  expect(
    catalogIntentViewSchema.safeParse({
      ...intent,
      files: [{ ...file, key: `station/_uploads/${id}/${file.name}` }],
    }).success,
  ).toBe(false);
  const result = {
    publicationId: id,
    identity: request.identity,
    files: [
      { ...file, publicPath: `/standalone/stable/1.0.0/${file.name}`, versionId: "opaque-version" },
    ],
  };
  expect(catalogPublicationResultSchema.parse(result)).toEqual(result);
  expect(
    catalogPublicationResultSchema.safeParse({
      ...result,
      files: [{ ...result.files[0], publicPath: `/standalone/beta/1.0.0/${file.name}` }],
    }).success,
  ).toBe(false);
});
