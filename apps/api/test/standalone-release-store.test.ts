import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  configureStandaloneReleases,
  STANDALONE_RELEASES_CONFIG_ERROR,
} from "../src/modules/standalone-releases/release-config";
import {
  createReleaseS3Client,
  ReleaseObjectTooLargeError,
  S3StandaloneReleaseStore,
} from "../src/modules/standalone-releases/release-store";

const env = {
  RELEASES_S3_ENDPOINT: "https://s3.twcstorage.ru",
  RELEASES_S3_REGION: "ru-1",
  RELEASES_S3_BUCKET: "markiro-releases",
  RELEASES_S3_ACCESS_KEY_ID: "fixture-access-key",
  RELEASES_S3_SECRET_ACCESS_KEY: "fixture-secret-key",
};

describe("release storage configuration (spec 2026-10-20 §5.4)", () => {
  it("is off when nothing is set and defaults the public origin when it is", () => {
    expect(configureStandaloneReleases({})).toBeNull();
    expect(configureStandaloneReleases({ RELEASES_PUBLIC_ORIGIN: "https://x.example" })).toBeNull();
    expect(configureStandaloneReleases(env)).toEqual({
      endpoint: "https://s3.twcstorage.ru",
      region: "ru-1",
      bucket: "markiro-releases",
      accessKeyId: "fixture-access-key",
      secretAccessKey: "fixture-secret-key",
      publicOrigin: "https://releases.markiro.app",
    });
  });

  it("refuses a partial set or a value that is not an exact origin, without echoing keys", () => {
    for (const patch of [
      { RELEASES_S3_SECRET_ACCESS_KEY: "" },
      { RELEASES_S3_BUCKET: "Bad_Bucket" },
      { RELEASES_S3_ENDPOINT: "https://s3.twcstorage.ru/" },
      { RELEASES_S3_ENDPOINT: "https://s3.twcstorage.ru/bucket" },
      { RELEASES_S3_ENDPOINT: "http://s3.twcstorage.ru" },
      { RELEASES_PUBLIC_ORIGIN: "http://releases.markiro.app" },
      { RELEASES_PUBLIC_ORIGIN: "https://releases.markiro.app/standalone" },
    ]) {
      expect(
        () => configureStandaloneReleases({ ...env, ...patch }),
        JSON.stringify(patch),
      ).toThrow(STANDALONE_RELEASES_CONFIG_ERROR);
    }
    // Local SeaweedFS speaks plain HTTP on loopback.
    expect(
      configureStandaloneReleases({ ...env, RELEASES_S3_ENDPOINT: "http://localhost:9000" })
        ?.endpoint,
    ).toBe("http://localhost:9000");
  });
});

describe("release bucket adapter", () => {
  const config = configureStandaloneReleases(env)!;

  it("presigns a path-style PUT on the endpoint origin that binds the content type", async () => {
    const client = createReleaseS3Client(config);
    const store = new S3StandaloneReleaseStore(config, client);
    const url = new URL(
      await store.presignPut(
        "standalone/stable/0.4.0/markiro-standalone-0.4.0.update.jws",
        "application/octet-stream",
        900,
      ),
    );
    client.destroy();
    expect(url.origin).toBe("https://s3.twcstorage.ru");
    expect(url.pathname).toBe(
      "/markiro-releases/standalone/stable/0.4.0/markiro-standalone-0.4.0.update.jws",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain("content-type");
    // An SDK-added checksum would be of an empty body and fail every browser upload.
    for (const name of url.searchParams.keys()) expect(name.toLowerCase()).not.toMatch(/checksum/);
    expect(url.search).not.toContain("fixture-secret-key");
  });

  function fakeClient(objects: Record<string, Buffer>, sent: unknown[] = []) {
    return {
      send: (command: unknown) => {
        sent.push(command);
        const input = (command as { input: { Key?: string; Prefix?: string } }).input;
        const missing = Object.assign(new Error("missing"), { name: "NoSuchKey" });
        if (command instanceof HeadObjectCommand) {
          const body = objects[input.Key ?? ""];
          return body
            ? Promise.resolve({ ContentLength: body.byteLength })
            : Promise.reject(missing);
        }
        if (command instanceof GetObjectCommand) {
          const body = objects[input.Key ?? ""];
          return body
            ? Promise.resolve({
                ContentLength: body.byteLength,
                Body: Readable.from([body.subarray(0, 3), body.subarray(3)]),
              })
            : Promise.reject(missing);
        }
        if (command instanceof ListObjectsV2Command)
          return Promise.resolve({
            CommonPrefixes: [
              { Prefix: "standalone/stable/0.4.0/" },
              { Prefix: "standalone/stable/0.5.0/" },
            ],
            IsTruncated: false,
          });
        return Promise.resolve({});
      },
    };
  }

  it("streams objects back, hashing them, and stops at the size limit", async () => {
    const bytes = Buffer.from("MZ installer bytes");
    const store = new S3StandaloneReleaseStore(config, fakeClient({ a: bytes }) as never);
    expect(await store.head("a")).toEqual({ size: bytes.byteLength });
    expect(await store.head("b")).toBeNull();
    expect(await store.read("a", 100)).toEqual(bytes);
    expect(await store.read("b", 100)).toBeNull();
    expect(await store.digest("a", 100)).toEqual({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    });
    await expect(store.digest("a", 5)).rejects.toBeInstanceOf(ReleaseObjectTooLargeError);
    expect(await store.listFolders("standalone/stable/")).toEqual(["0.4.0", "0.5.0"]);
  });

  it("writes JSON with the asked caching", async () => {
    const sent: unknown[] = [];
    const store = new S3StandaloneReleaseStore(config, fakeClient({}, sent) as never);
    await store.put(
      "standalone/stable/latest.json",
      Buffer.from("{}"),
      "application/json",
      "no-cache",
    );
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toMatchObject({
      Bucket: "markiro-releases",
      Key: "standalone/stable/latest.json",
      ContentType: "application/json",
      CacheControl: "no-cache",
    });
  });
});
