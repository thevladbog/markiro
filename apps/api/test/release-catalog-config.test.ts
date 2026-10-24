import { describe, expect, it } from "vitest";
import { configureCatalog } from "../src/modules/release-catalog/catalog-config";
export const catalogEnvironment = {
  RELEASE_CATALOG_S3_ENDPOINT: "https://s3.twcstorage.ru",
  RELEASE_CATALOG_S3_REGION: "ru-1",
  RELEASE_CATALOG_S3_BUCKET: "markiro-releases",
  RELEASE_CATALOG_S3_ACCESS_KEY_ID: "fixture-access",
  RELEASE_CATALOG_S3_SECRET_ACCESS_KEY: "fixture-secret",
  RELEASE_CATALOG_CACHE_DIR: "/var/lib/markiro/release-cache",
  RELEASE_CATALOG_JOURNAL_DIR: "/var/lib/markiro/release-journal",
  RELEASE_CATALOG_CACHE_BYTES: "1048576",
  RELEASE_CATALOG_OBJECT_BYTES: "65536",
  RELEASE_CATALOG_DISK_RESERVE_BYTES: "131072",
  RELEASE_CATALOG_DOWNLOADS: "2",
  RELEASE_CATALOG_TIMEOUT_MS: "5000",
};
describe("catalog explicit configuration", () => {
  it("is absent by default and accepts bounded explicit settings", () => {
    expect(configureCatalog({})).toBeNull();
    expect(configureCatalog(catalogEnvironment)).toMatchObject({
      bucket: "markiro-releases",
      maxDownloads: 2,
      cacheBytes: 1048576,
      maxObjectBytes: 65536,
      diskReserveBytes: 131072,
    });
  });
  it.each([
    { RELEASE_CATALOG_S3_ENDPOINT: "http://s3.twcstorage.ru" },
    { RELEASE_CATALOG_S3_ENDPOINT: "https://example.invalid/path" },
    { RELEASE_CATALOG_S3_ENDPOINT: "https://user:password@example.invalid" },
    { RELEASE_CATALOG_S3_SECRET_ACCESS_KEY: "" },
    { RELEASE_CATALOG_CACHE_BYTES: "Infinity" },
    { RELEASE_CATALOG_CACHE_BYTES: "-1" },
    { RELEASE_CATALOG_CACHE_BYTES: "1.5" },
    { RELEASE_CATALOG_CACHE_BYTES: "1" },
    { RELEASE_CATALOG_OBJECT_BYTES: "0" },
    { RELEASE_CATALOG_DISK_RESERVE_BYTES: "0" },
    { RELEASE_CATALOG_DOWNLOADS: "3" },
    { RELEASE_CATALOG_TIMEOUT_MS: "0" },
    { RELEASE_CATALOG_CACHE_DIR: "relative" },
    { RELEASE_CATALOG_CACHE_DIR: "/a", RELEASE_CATALOG_JOURNAL_DIR: "/a/..hidden" },
    { RELEASE_CATALOG_S3_REGION: "ru-1\ninvalid" },
    { RELEASE_CATALOG_CACHE_DIR: "/var/lib/markiro/release-journal" },
    { RELEASE_CATALOG_JOURNAL_DIR: "/var/lib/markiro/release-cache/ledger" },
  ])("fails closed without echoing credential values", (patch) => {
    expect(() => configureCatalog({ ...catalogEnvironment, ...patch })).toThrow(
      "Invalid release catalog configuration",
    );
  });
});
