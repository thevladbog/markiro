import {
  standaloneInstallerFileName,
  standaloneManifestFileName,
  type StandaloneRelease,
  type StandaloneReleaseChannel,
  type StandaloneReleaseChannelView,
  type StandaloneReleaseList,
} from "@markiro/platform-contracts";
import { vi } from "vitest";

import type { PlatformPrincipal } from "../src/auth/PlatformAuthBoundary.js";
import { jsonResponse, PLATFORM_ADMIN_ME } from "./render.js";

export const RELEASE_ORIGIN = "https://releases.markiro.app";
export const BUCKET_ORIGIN = "https://storage.example.net";
export const INSTALLER_SHA = "ab".repeat(32);
export const MANIFEST_SHA = "cd".repeat(32);
export const UPLOAD_INTENT = "11111111-1111-4111-8111-111111111111";
export const PENDING_INTENT = "22222222-2222-4222-8222-222222222222";
export const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

export function release(
  channel: StandaloneReleaseChannel,
  version: string,
  overrides: Partial<StandaloneRelease> = {},
): StandaloneRelease {
  const folder = `${RELEASE_ORIGIN}/standalone/${channel}/${version}`;
  const installerName = standaloneInstallerFileName(version);
  const manifestName = standaloneManifestFileName(version);
  return {
    channel,
    version,
    releasedAt: "2026-10-20T09:00:00.000Z",
    registeredAt: "2026-10-20T10:30:00.000Z",
    kid: "release-2026-1",
    sourceSha: SOURCE_SHA,
    protocol: 4,
    minProtocol: 3,
    minUpgradeFrom: "0.1.0",
    notes: [`Изменения ${version}`],
    installer: {
      name: installerName,
      url: `${folder}/${installerName}`,
      sha256: INSTALLER_SHA,
      sizeBytes: 62_914_560,
    },
    manifest: {
      name: manifestName,
      url: `${folder}/${manifestName}`,
      sha256: MANIFEST_SHA,
      sizeBytes: 912,
    },
    ...overrides,
  };
}

export const STABLE_VIEW = {
  channel: "stable",
  revision: "7",
  latest: "0.4.0",
  latestReadable: true,
  releases: [release("stable", "0.5.0"), release("stable", "0.4.0"), release("stable", "0.3.0")],
  pending: [{ version: "0.6.0", intentId: PENDING_INTENT }],
} satisfies StandaloneReleaseChannelView;

export const BETA_VIEW = {
  channel: "beta",
  revision: "0",
  latest: null,
  latestReadable: true,
  releases: [],
  pending: [],
} satisfies StandaloneReleaseChannelView;

export const RELEASE_LIST = {
  configured: true,
  publicOrigin: RELEASE_ORIGIN,
  channels: [STABLE_VIEW, BETA_VIEW],
} satisfies StandaloneReleaseList;

export interface ReleaseApiCall {
  url: string;
  method: string;
  body: unknown;
}

const BASE = "/api/platform/standalone-releases";

export function installStandaloneReleasesApi({
  me = PLATFORM_ADMIN_ME,
  list = RELEASE_LIST,
  uploadStatus = 200,
  uploadError = "standalone_release_version_exists",
  registerStatus = 200,
  registerError = "standalone_release_manifest_bad_signature",
  registerOutcome = "registered",
  latestStatus = 200,
  latestError = "standalone_release_integrity_failed",
}: {
  me?: PlatformPrincipal;
  list?: StandaloneReleaseList;
  uploadStatus?: number;
  uploadError?: string;
  registerStatus?: number;
  registerError?: string;
  registerOutcome?: "registered" | "unchanged";
  latestStatus?: number;
  latestError?: string;
} = {}) {
  const calls: ReleaseApiCall[] = [];
  let uploaded = { channel: "stable" as StandaloneReleaseChannel, version: "0.7.0" };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const path = url.split("?")[0] ?? url;
    if (path === "/api/platform/me") return jsonResponse(200, me);
    if (path === "/api/platform/leads/summary") return jsonResponse(200, { newCount: 0 });
    if (path === BASE && method === "GET") return jsonResponse(200, list);
    const target = (body ?? {}) as { channel: StandaloneReleaseChannel; version: string };
    if (path === `${BASE}/uploads` && method === "POST") {
      if (uploadStatus !== 200) return jsonResponse(uploadStatus, { code: uploadError });
      uploaded = target;
      const folder = `${BUCKET_ORIGIN}/markiro-releases/standalone/_uploads/${UPLOAD_INTENT}`;
      return jsonResponse(200, {
        intentId: UPLOAD_INTENT,
        channel: target.channel,
        version: target.version,
        expiresAt: "2026-10-21T10:15:00.000Z",
        installer: {
          name: standaloneInstallerFileName(target.version),
          uploadUrl: `${folder}/${standaloneInstallerFileName(target.version)}?X-Amz-Signature=i`,
          contentType: "application/octet-stream",
        },
        manifest: {
          name: standaloneManifestFileName(target.version),
          uploadUrl: `${folder}/${standaloneManifestFileName(target.version)}?X-Amz-Signature=m`,
          contentType: "application/octet-stream",
        },
      });
    }
    if (path === `${BASE}/registrations` && method === "POST") {
      if (registerStatus !== 200) return jsonResponse(registerStatus, { code: registerError });
      return jsonResponse(200, {
        outcome: registerOutcome,
        release:
          (body as { intentId: string }).intentId === PENDING_INTENT
            ? release("stable", "0.6.0")
            : release(uploaded.channel, uploaded.version),
      });
    }
    const latest = /^\/api\/platform\/standalone-releases\/(stable|beta)\/latest$/.exec(path);
    if (latest && method === "PUT") {
      if (latestStatus !== 200) return jsonResponse(latestStatus, { code: latestError });
      const channel = latest[1] as StandaloneReleaseChannel;
      const view = list.configured
        ? list.channels.find((entry) => entry.channel === channel)
        : undefined;
      return jsonResponse(200, {
        ...(view ?? { ...BETA_VIEW, channel }),
        latest: (body as { version: string }).version,
        revision: (BigInt((body as { expectedRevision: string }).expectedRevision) + 1n).toString(),
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    writes: () => calls.filter((call) => call.method !== "GET"),
    lists: () => calls.filter((call) => call.method === "GET" && call.url === BASE),
    fetchMock,
  };
}

type XhrMode = "auto" | "manual" | "error" | "reject";

/** A scriptable XMLHttpRequest: only what a presigned PUT with progress needs. */
export class FakeXhr {
  static instances: FakeXhr[] = [];
  static mode: XhrMode = "auto";

  static reset(mode: XhrMode = "auto") {
    FakeXhr.instances = [];
    FakeXhr.mode = mode;
  }

  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  withCredentials = false;
  status = 0;
  aborted = false;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    this.body = body;
    FakeXhr.instances.push(this);
    const mode = FakeXhr.mode;
    if (mode === "auto") queueMicrotask(() => this.respond(200));
    if (mode === "error") queueMicrotask(() => this.fail());
    if (mode === "reject") queueMicrotask(() => this.respond(403));
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }

  respond(status: number) {
    this.status = status;
    this.onload?.();
  }

  fail() {
    this.onerror?.();
  }
}

export function installFakeXhr(mode: XhrMode = "auto") {
  FakeXhr.reset(mode);
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return FakeXhr;
}

function base64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export const INSTALLER_BYTES = "MZ-fake-installer-bytes";

export function manifestJws(
  overrides: Record<string, unknown> = {},
  installer: Record<string, unknown> = {},
): string {
  const version = typeof overrides.version === "string" ? overrides.version : "0.7.0";
  const payload = {
    v: 1,
    product: "markiro-standalone",
    version,
    channel: "stable",
    releasedAt: "2026-10-21T08:00:00Z",
    sourceSha: SOURCE_SHA,
    installer: {
      name: standaloneInstallerFileName(version),
      sha256: INSTALLER_SHA,
      sizeBytes: INSTALLER_BYTES.length,
      ...installer,
    },
    protocol: 4,
    minProtocol: 3,
    minUpgradeFrom: "0.1.0",
    notes: ["Печать на втором принтере"],
    ...overrides,
  };
  return `${base64Url(JSON.stringify({ alg: "EdDSA", kid: "release-2026-1" }))}.${base64Url(
    JSON.stringify(payload),
  )}.c2lnbmF0dXJl`;
}

export function manifestFile(text = manifestJws(), version = "0.7.0"): File {
  return new File([`${text}\n`], standaloneManifestFileName(version), {
    type: "application/octet-stream",
  });
}

export function installerFile(version = "0.7.0", bytes = INSTALLER_BYTES): File {
  return new File([bytes], standaloneInstallerFileName(version), {
    type: "application/x-msdownload",
  });
}
