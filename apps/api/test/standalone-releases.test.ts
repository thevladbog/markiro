import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpException } from "@nestjs/common";
import {
  platformCapabilitiesForRole,
  standaloneLatestPointerSchema,
} from "@markiro/platform-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";
import type { PlatformAuditEvent } from "../src/platform-auth/platform-audit.service";
import { PlatformStandaloneReleasesController } from "../src/modules/standalone-releases/platform-standalone-releases.controller";
import { standaloneLatestBuildSource } from "../src/modules/standalone-releases/release-runtime";
import { STANDALONE_RELEASE_KEYSET } from "../src/modules/standalone-releases/release-trust-keys";
import {
  StandaloneReleasesService,
  type StandaloneReleasesRuntime,
} from "../src/modules/standalone-releases/standalone-releases.service";
import {
  admin,
  installerKey,
  KEYSET,
  manifest,
  manifestKey,
  MemoryStore,
  NOW,
  ORIGIN,
  release,
  sha,
  stranger,
} from "./support/standalone-releases";

describe("standalone releases (spec 2026-10-20 §5)", () => {
  let store: MemoryStore;
  let events: PlatformAuditEvent[];
  let locks: number;
  let service: StandaloneReleasesService;

  function build(runtime: StandaloneReleasesRuntime | null, keyset = KEYSET) {
    const db = {
      transaction: async <T>(work: (tx: unknown) => Promise<T>) =>
        work({ execute: () => Promise.resolve((locks += 1)) }),
    };
    const audit = {
      record: (_tx: unknown, event: PlatformAuditEvent) => {
        events.push(event);
        return Promise.resolve();
      },
    };
    return new StandaloneReleasesService(db as never, audit as never, runtime, keyset, () => NOW);
  }

  function upload(version: string, installer: Buffer, manifestBytes: Buffer, channel = "stable") {
    store.objects.set(installerKey(channel, version), {
      body: installer,
      contentType: "application/octet-stream",
    });
    store.objects.set(manifestKey(channel, version), {
      body: manifestBytes,
      contentType: "application/octet-stream",
    });
  }

  async function registered(version: string, installer = Buffer.from(`installer ${version}`)) {
    upload(version, installer, manifest(version, installer));
    await service.register(admin, { channel: "stable", version });
    events.length = 0;
    return installer;
  }

  async function refusal(work: Promise<unknown>): Promise<{ status: number; code: string }> {
    const error = await work.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    return { status: http.getStatus(), code: (http.getResponse() as { code: string }).code };
  }

  beforeEach(() => {
    store = new MemoryStore();
    events = [];
    locks = 0;
    service = build({
      config: {
        endpoint: "https://storage.example.test",
        region: "ru-central1",
        bucket: "releases.markiro.app",
        accessKeyId: "key",
        secretAccessKey: "secret",
        publicOrigin: ORIGIN,
      },
      store,
    });
  });

  it("says «не настроено» without storage, and refuses every write the same way", async () => {
    const bare = build(null);
    expect(await bare.list()).toEqual({ configured: false });
    expect(
      await refusal(bare.createUpload(admin, { channel: "stable", version: "0.4.0" })),
    ).toEqual({ status: 503, code: "standalone_releases_not_configured" });
    expect(await refusal(bare.register(admin, { channel: "stable", version: "0.4.0" }))).toEqual({
      status: 503,
      code: "standalone_releases_not_configured",
    });
    expect(await refusal(bare.setLatest(admin, "stable", "0.4.0"))).toEqual({
      status: 503,
      code: "standalone_releases_not_configured",
    });
    expect(await bare.latestVersion("stable")).toBeNull();
  });

  it("hands out presigned PUTs into the version's own folder and audits who asked", async () => {
    const upload = await service.createUpload(admin, { channel: "beta", version: "0.4.0" });
    expect(store.presigned).toEqual([
      { key: installerKey("beta", "0.4.0"), contentType: "application/octet-stream", expires: 900 },
      { key: manifestKey("beta", "0.4.0"), contentType: "application/octet-stream", expires: 900 },
    ]);
    expect(upload).toEqual({
      channel: "beta",
      version: "0.4.0",
      expiresAt: "2026-10-21T12:15:00.000Z",
      installer: {
        name: "markiro-standalone-0.4.0-windows-x86_64-setup.exe",
        uploadUrl: expect.stringContaining(installerKey("beta", "0.4.0")),
        contentType: "application/octet-stream",
      },
      manifest: {
        name: "markiro-standalone-0.4.0.update.jws",
        uploadUrl: expect.stringContaining(manifestKey("beta", "0.4.0")),
        contentType: "application/octet-stream",
      },
    });
    expect(events).toEqual([
      {
        actorPlatformUserId: "platform-admin-1",
        actorRole: "platform_admin",
        action: "standalone.release.upload.authorize",
        outcome: "success",
        tenantId: null,
        targetType: "standalone_release",
        targetId: "beta/0.4.0",
        reason: null,
        before: null,
        after: { channel: "beta", version: "0.4.0", expiresAt: "2026-10-21T12:15:00.000Z" },
        requestId: null,
      },
    ]);
  });

  it("never opens a registered folder for writing, nor one at or below the newest version", async () => {
    await registered("0.4.0");
    expect(
      await refusal(service.createUpload(admin, { channel: "stable", version: "0.4.0" })),
    ).toEqual({ status: 409, code: "standalone_release_version_exists" });
    expect(
      await refusal(service.createUpload(admin, { channel: "stable", version: "0.3.9" })),
    ).toEqual({ status: 409, code: "standalone_release_version_not_newer" });
    expect(store.presigned).toEqual([]);
    expect(events).toEqual([]);
    // Channels are independent.
    await service.createUpload(admin, { channel: "beta", version: "0.3.9" });
  });

  it("registers a correctly signed release, writes its record and audits the facts", async () => {
    const installer = Buffer.from("MZ installer bytes");
    const manifestBytes = manifest("0.4.0", installer);
    upload("0.4.0", installer, manifestBytes);

    const result = await service.register(admin, { channel: "stable", version: "0.4.0" });

    expect(locks).toBe(1);
    expect(result).toEqual({
      outcome: "registered",
      release: {
        channel: "stable",
        version: "0.4.0",
        releasedAt: "2026-11-02T10:00:00.000Z",
        registeredAt: "2026-10-21T12:00:00.000Z",
        kid: "upd-test",
        sourceSha: "0123456789abcdef0123456789abcdef01234567",
        protocol: 2,
        minProtocol: 1,
        minUpgradeFrom: "0.1.0",
        notes: ["Печать паллет", "Исправления"],
        installer: {
          name: "markiro-standalone-0.4.0-windows-x86_64-setup.exe",
          url: `${ORIGIN}/${installerKey("stable", "0.4.0")}`,
          sha256: sha(installer),
          sizeBytes: installer.byteLength,
        },
        manifest: {
          name: "markiro-standalone-0.4.0.update.jws",
          url: `${ORIGIN}/${manifestKey("stable", "0.4.0")}`,
          sha256: sha(manifestBytes),
          sizeBytes: manifestBytes.byteLength,
        },
      },
    });
    const record = store.objects.get("standalone/stable/0.4.0/release.json");
    expect(record?.contentType).toBe("application/json");
    expect(JSON.parse(record?.body.toString("utf8") ?? "")).toMatchObject({
      v: 1,
      product: "markiro-standalone",
      version: "0.4.0",
      installer: { sha256: sha(installer) },
    });
    expect(events).toEqual([
      {
        actorPlatformUserId: "platform-admin-1",
        actorRole: "platform_admin",
        action: "standalone.release.register",
        outcome: "success",
        tenantId: null,
        targetType: "standalone_release",
        targetId: "stable/0.4.0",
        reason: null,
        before: null,
        after: {
          channel: "stable",
          version: "0.4.0",
          kid: "upd-test",
          installerSha256: sha(installer),
          installerSizeBytes: installer.byteLength,
          manifestSha256: sha(manifestBytes),
          sourceSha: "0123456789abcdef0123456789abcdef01234567",
        },
        requestId: null,
      },
    ]);
    // Registration does not move the pointer.
    expect(store.objects.has("standalone/stable/latest.json")).toBe(false);
  });

  const refusals: {
    name: string;
    code: string;
    status: number;
    arrange: (installer: Buffer) => Buffer;
    installer?: Buffer;
  }[] = [
    {
      name: "a signature that does not verify",
      code: "standalone_release_manifest_bad_signature",
      status: 422,
      arrange: (installer) =>
        manifest("0.4.0", installer, {}, { kid: release.kid, privateKey: stranger.privateKey }),
    },
    {
      name: "a key the hosts do not know",
      code: "standalone_release_manifest_unknown_key",
      status: 422,
      arrange: (installer) => manifest("0.4.0", installer, {}, stranger),
    },
    {
      name: "a manifest that is not a JWS",
      code: "standalone_release_manifest_malformed",
      status: 422,
      arrange: () => Buffer.from("not a manifest\n"),
    },
    {
      name: "a manifest of another channel",
      code: "standalone_release_manifest_mismatch",
      status: 422,
      arrange: (installer) => manifest("0.4.0", installer, { channel: "beta" }),
    },
    {
      name: "a manifest of another version",
      code: "standalone_release_manifest_mismatch",
      status: 422,
      arrange: (installer) => manifest("0.4.1", installer),
    },
    {
      name: "an installer of another size",
      code: "standalone_release_installer_size_mismatch",
      status: 422,
      arrange: (installer) =>
        manifest("0.4.0", installer, {
          installer: {
            name: "markiro-standalone-0.4.0-windows-x86_64-setup.exe",
            sha256: sha(installer),
            sizeBytes: installer.byteLength + 1,
          },
        }),
    },
    {
      name: "an installer whose bytes the manifest does not sign",
      code: "standalone_release_installer_hash_mismatch",
      status: 422,
      arrange: (installer) =>
        manifest("0.4.0", installer, {
          installer: {
            name: "markiro-standalone-0.4.0-windows-x86_64-setup.exe",
            sha256: "f".repeat(64),
            sizeBytes: installer.byteLength,
          },
        }),
    },
  ];

  for (const testCase of refusals) {
    it(`refuses ${testCase.name}, audits it and removes the unregistered files`, async () => {
      const installer = Buffer.from("MZ installer bytes");
      const manifestBytes = testCase.arrange(installer);
      upload("0.4.0", installer, manifestBytes);

      expect(
        await refusal(service.register(admin, { channel: "stable", version: "0.4.0" })),
      ).toEqual({ status: testCase.status, code: testCase.code });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorPlatformUserId: "platform-admin-1",
        actorRole: "platform_admin",
        action: "standalone.release.register",
        outcome: "rejected",
        tenantId: null,
        targetType: "standalone_release",
        targetId: "stable/0.4.0",
        reason: testCase.code,
        before: null,
        after: { channel: "stable", version: "0.4.0", manifestSha256: sha(manifestBytes) },
      });
      expect(store.objects.has("standalone/stable/0.4.0/release.json")).toBe(false);
      expect(store.removed.sort()).toEqual(
        [installerKey("stable", "0.4.0"), manifestKey("stable", "0.4.0")].sort(),
      );
    });
  }

  it("names the measured and the signed installer in a hash refusal", async () => {
    const installer = Buffer.from("MZ installer bytes");
    const other = Buffer.from("MZ installer bytez");
    upload("0.4.0", other, manifest("0.4.0", installer));
    await refusal(service.register(admin, { channel: "stable", version: "0.4.0" }));
    expect(events[0]?.after).toEqual({
      channel: "stable",
      version: "0.4.0",
      kid: "upd-test",
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      manifestVersion: "0.4.0",
      manifestChannel: "stable",
      expectedSha256: sha(installer),
      expectedSizeBytes: installer.byteLength,
      installerSha256: sha(other),
      installerSizeBytes: other.byteLength,
    });
  });

  it("refuses a version at or below the newest registered one (no downgrade)", async () => {
    await registered("0.4.0");
    const installer = Buffer.from("older");
    upload("0.3.9", installer, manifest("0.3.9", installer));
    expect(await refusal(service.register(admin, { channel: "stable", version: "0.3.9" }))).toEqual(
      { status: 409, code: "standalone_release_version_not_newer" },
    );
    expect(events[0]).toMatchObject({
      outcome: "rejected",
      reason: "standalone_release_version_not_newer",
      after: { version: "0.3.9", newestVersion: "0.4.0" },
    });
  });

  it("refuses files that are not there yet", async () => {
    const installer = Buffer.from("MZ");
    store.objects.set(manifestKey("stable", "0.4.0"), {
      body: manifest("0.4.0", installer),
      contentType: "application/octet-stream",
    });
    expect(await refusal(service.register(admin, { channel: "stable", version: "0.4.0" }))).toEqual(
      { status: 422, code: "standalone_release_files_missing" },
    );
    expect(events[0]).toMatchObject({
      outcome: "rejected",
      reason: "standalone_release_files_missing",
    });
  });

  it("answers a repeated registration of the same bytes as unchanged, without a new audit", async () => {
    const installer = await registered("0.4.0");
    const again = await service.register(admin, { channel: "stable", version: "0.4.0" });
    expect(again.outcome).toBe("unchanged");
    expect(again.release.installer.sha256).toBe(sha(installer));
    expect(events).toEqual([]);
  });

  it("refuses the same version with other bytes and keeps the registered files", async () => {
    await registered("0.4.0");
    const replaced = Buffer.from("a different installer");
    upload("0.4.0", replaced, manifest("0.4.0", replaced));
    expect(await refusal(service.register(admin, { channel: "stable", version: "0.4.0" }))).toEqual(
      { status: 409, code: "standalone_release_immutable" },
    );
    expect(events[0]).toMatchObject({
      action: "standalone.release.register",
      outcome: "rejected",
      reason: "standalone_release_immutable",
      after: { installerSha256: sha(replaced) },
    });
    expect(store.removed).toEqual([]);
    expect(store.objects.has("standalone/stable/0.4.0/release.json")).toBe(true);
  });

  it("writes latest.json in the shape of §5.3 and audits the move", async () => {
    const installer = await registered("0.4.0");
    const view = await service.setLatest(admin, "stable", "0.4.0");

    const latest = store.objects.get("standalone/stable/latest.json");
    expect(latest?.cacheControl).toBe("no-cache");
    expect(latest?.contentType).toBe("application/json");
    const pointer = JSON.parse(latest?.body.toString("utf8") ?? "");
    expect(standaloneLatestPointerSchema.parse(pointer)).toEqual(pointer);
    expect(pointer).toEqual({
      v: 1,
      product: "markiro-standalone",
      channel: "stable",
      version: "0.4.0",
      releasedAt: "2026-11-02T10:00:00Z",
      installer: {
        url: `${ORIGIN}/${installerKey("stable", "0.4.0")}`,
        sha256: sha(installer),
        sizeBytes: installer.byteLength,
      },
      manifestUrl: `${ORIGIN}/${manifestKey("stable", "0.4.0")}`,
      notes: ["Печать паллет", "Исправления"],
    });
    expect(view).toMatchObject({ channel: "stable", latest: "0.4.0", latestReadable: true });
    expect(events).toEqual([
      {
        actorPlatformUserId: "platform-admin-1",
        actorRole: "platform_admin",
        action: "standalone.release.latest.set",
        outcome: "success",
        tenantId: null,
        targetType: "standalone_release",
        targetId: "stable/0.4.0",
        reason: null,
        before: { version: null },
        after: {
          channel: "stable",
          version: "0.4.0",
          direction: "promote",
          installerSha256: sha(installer),
        },
        requestId: null,
      },
    ]);
    expect(await service.latestVersion("stable")).toBe("0.4.0");
  });

  it("rolls the pointer back to an earlier version and leaves every version's files", async () => {
    await registered("0.4.0");
    await registered("0.5.0");
    await service.setLatest(admin, "stable", "0.5.0");
    events.length = 0;

    const view = await service.setLatest(admin, "stable", "0.4.0");

    expect(view.latest).toBe("0.4.0");
    expect(view.releases.map((entry) => entry.version)).toEqual(["0.5.0", "0.4.0"]);
    expect(store.removed).toEqual([]);
    expect(store.objects.has(installerKey("stable", "0.5.0"))).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        action: "standalone.release.latest.set",
        outcome: "success",
        before: { version: "0.5.0" },
        after: expect.objectContaining({ version: "0.4.0", direction: "rollback" }),
      }),
    ]);
  });

  it("does not move the pointer to an unregistered version or to bytes changed since", async () => {
    expect(await refusal(service.setLatest(admin, "stable", "0.9.0"))).toEqual({
      status: 404,
      code: "standalone_release_not_found",
    });
    expect(events[0]).toMatchObject({
      action: "standalone.release.latest.set",
      outcome: "rejected",
      reason: "standalone_release_not_found",
    });

    await registered("0.4.0");
    store.objects.set(installerKey("stable", "0.4.0"), {
      body: Buffer.from("tampered after registration"),
      contentType: "application/octet-stream",
    });
    expect(await refusal(service.setLatest(admin, "stable", "0.4.0"))).toEqual({
      status: 409,
      code: "standalone_release_integrity_failed",
    });
    expect(events[0]).toMatchObject({
      action: "standalone.release.latest.set",
      outcome: "rejected",
      reason: "standalone_release_integrity_failed",
      before: { version: null },
    });
    expect(store.objects.has("standalone/stable/latest.json")).toBe(false);
  });

  it("does not move the pointer to a release whose key has since been retired", async () => {
    await registered("0.4.0");
    const retired = build(
      {
        config: (service as unknown as { runtime: StandaloneReleasesRuntime }).runtime.config,
        store,
      },
      { keys: [release.trusted], retiredKids: [release.kid] },
    );
    expect(await refusal(retired.setLatest(admin, "stable", "0.4.0"))).toEqual({
      status: 409,
      code: "standalone_release_integrity_failed",
    });
  });

  it("lists channels newest first, with the pointer and unfinished uploads", async () => {
    await registered("0.4.0");
    await registered("0.10.0");
    await service.setLatest(admin, "stable", "0.4.0");
    upload("0.11.0", Buffer.from("x"), Buffer.from("y"));

    const list = await service.list();

    expect(list).toMatchObject({
      configured: true,
      publicOrigin: ORIGIN,
      channels: [
        { channel: "stable", latest: "0.4.0", latestReadable: true, pending: ["0.11.0"] },
        { channel: "beta", latest: null, latestReadable: true, releases: [], pending: [] },
      ],
    });
    if (!list.configured) throw new Error("configured");
    expect(list.channels[0]?.releases.map((entry) => entry.version)).toEqual(["0.10.0", "0.4.0"]);
  });

  it("flags a latest.json it would not have written", async () => {
    store.objects.set("standalone/stable/latest.json", {
      body: Buffer.from('{"v":2}'),
      contentType: "application/json",
    });
    const list = await service.list();
    if (!list.configured) throw new Error("configured");
    expect(list.channels[0]).toMatchObject({ latest: null, latestReadable: false });
  });

  it("turns a storage failure into one retryable answer", async () => {
    store.failReads = true;
    expect(await refusal(service.list())).toEqual({
      status: 503,
      code: "standalone_releases_storage_unavailable",
    });
  });
});

describe("standalone release access (spec 2026-10-20 §5.5)", () => {
  it("guards every route with standaloneReleases.manage, which only administrators hold", () => {
    for (const method of ["list", "upload", "register", "setLatest"] as const) {
      expect(
        Reflect.getMetadata(
          PLATFORM_ACCESS_POLICY,
          PlatformStandaloneReleasesController.prototype[method],
        ),
        method,
      ).toEqual({ mode: "capabilities", capabilities: ["standaloneReleases.manage"] });
    }
    expect(platformCapabilitiesForRole.platform_admin).toContain("standaloneReleases.manage");
    expect(platformCapabilitiesForRole.support).not.toContain("standaloneReleases.manage");
    expect(platformCapabilitiesForRole.accountant).not.toContain("standaloneReleases.manage");
  });
});

describe("standalone release trust keys", () => {
  it("are exactly the update keys the hosts are built with", () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, "../../standalone/proto/fixtures/trust-keys.json"), "utf8"),
    ) as { update: unknown };
    expect(STANDALONE_RELEASE_KEYSET).toEqual(fixture.update);
  });
});

describe("latest published build for diagnostics (spec 2026-10-20 §5.3)", () => {
  it("reads the stable pointer's version, caches it a minute and reads failures as unknown", async () => {
    const store = new MemoryStore();
    let clock = 0;
    const source = standaloneLatestBuildSource(store, () => clock);
    expect(await source.latestPublishedVersion()).toBeNull();
    clock = 60_000;
    store.objects.set("standalone/stable/latest.json", {
      body: Buffer.from(
        JSON.stringify({
          v: 1,
          product: "markiro-standalone",
          channel: "stable",
          version: "0.4.0",
          releasedAt: "2026-11-02T10:00:00Z",
          installer: {
            url: `${ORIGIN}/${installerKey("stable", "0.4.0")}`,
            sha256: "a".repeat(64),
            sizeBytes: 10,
          },
          manifestUrl: `${ORIGIN}/${manifestKey("stable", "0.4.0")}`,
          notes: [],
        }),
      ),
      contentType: "application/json",
    });
    expect(await source.latestPublishedVersion()).toBe("0.4.0");
    store.failReads = true;
    expect(await source.latestPublishedVersion()).toBe("0.4.0");
    clock = 120_001;
    expect(await source.latestPublishedVersion()).toBeNull();
    expect(await standaloneLatestBuildSource(null).latestPublishedVersion()).toBeNull();
  });
});
