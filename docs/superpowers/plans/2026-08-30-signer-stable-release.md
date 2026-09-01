# Signer Agent Stable Release Implementation Plan

> **Historical plan:** This records the initial release implementation. The
> workflow-owned version, distribution-repository, and exact-byte repair
> extension is implemented by
> `docs/superpowers/plans/2026-09-01-signer-distribution-release.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a signed, installable Windows build of the Chestny ZNAK signer agent to `https://releases.markiro.app/signer/stable/` and to a GitHub Release, and teach the installed agent to update itself with the operator's consent.

**Architecture:** One `workflow_dispatch` workflow: an `authorize` job gates on the repository owner and a typed confirmation, then a `windows-latest` job builds the agent with the existing `tauri.stable.conf.json` overlay, signs it with the owner's minisign key, uploads the artifacts and a Tauri updater manifest to the object-storage mirror, verifies them by reading back over public HTTPS, and only then creates the GitHub Release. The YAML stays thin; its logic lives in `tools/signer-release/*.mjs` under `node --test`, the way `tools/station-release/` is arranged. Separately, the agent gains an update check that never installs without confirmation.

**Tech Stack:** GitHub Actions, Tauri 2 (`@tauri-apps/cli` 2.11.4, `@tauri-apps/plugin-updater` 2.10.1), `@aws-sdk/client-s3`, Node's built-in test runner, vitest, React 19, i18next.

## Global Constraints

- Monorepo: pnpm + turbo. **Never use `git stash`** — the stash stack is shared across sessions and worktrees.
- **The agent is Windows-only.** `apps/signer/src-tauri/tauri.conf.json` sets `productName: "Markiro Signer"`, `identifier: "app.markiro.signer"`, `version: "0.1.0"`, `targets: ["nsis"]`, `createUpdaterArtifacts: true`.
- **Build the release with `--config src-tauri/tauri.stable.conf.json`.** The base config keeps the beta endpoint plus the `pubkey`; the overlay only overrides the endpoint to `https://releases.markiro.app/signer/stable/latest.json`. `apps/signer/test/tauri-release-config.test.ts` pins both facts and must keep passing untouched.
- **With `targets: ["nsis"]`, Tauri 2's updater artifact is the setup `.exe` itself plus a sibling `.exe.sig`** — there is no `.nsis.zip`. This is what `station-stable-release.yml`'s signing step does (`bundle="$installer"; signature="$bundle.sig"`), and it is the single most likely thing to get wrong here.
- **Everything the release needs is in the `station-release` GitHub environment** and nowhere else. Verified present: secrets `SIGNER_TAURI_SIGNING_PRIVATE_KEY`, `SIGNER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `YANDEX_STATION_RELEASE_ACCESS_KEY_ID`, `YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY`; variables `YANDEX_STATION_RELEASE_BUCKET`, `YANDEX_STATION_RELEASE_ENDPOINT` (`https://storage.yandexcloud.net`). There are no repository-level secrets.
- **The GitHub Release goes to this repository** (`thevladbog/markiro`, public) with `permissions: contents: write` and `github.token`. Unlike the Station, the signer needs no cross-repository release token.
- **The mirror is written before the GitHub Release.** The updater endpoint reads the mirror, so a failure between the two must leave clients with a consistent update rather than an announcement they cannot fetch.
- **The signing key must never be echoed.** Validate it through `node tools/station-release/normalize-signing-key.mjs` (lossless — it returns the stored value unchanged), write it to a `chmod 600` file under `$RUNNER_TEMP` with a `trap` to remove it, and give Tauri the _file path_. Never the value on a command line.
- **Nothing installs without operator confirmation.** Installing restarts the agent, and the agent is what keeps the tenant's True API token fresh.
- **A failed update check is logged and never fatal.** An agent that cannot reach the mirror must keep signing.
- Node tooling tests run with `node --test` and are registered as a root `package.json` script, next to `"test:station-release:contract"`.
- The manifest is Tauri v2's updater format and nothing else: exactly the keys `version`, `pub_date`, `platforms`, with `platforms["windows-x86_64"]` holding exactly `url` and `signature`.
- The signer's i18n throws on a missing key under `MODE === "test"`, so every new string must land in **both** `apps/signer/src/i18n/ru.json` and `en.json`.
- Commit footer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## File Structure

| File                                              | Responsibility                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `tools/signer-release/version.mjs`                | Read the version from `tauri.conf.json`; derive and gate the tag |
| `tools/signer-release/manifest.mjs`               | Build and validate `latest.json`                                 |
| `tools/signer-release/object-storage.mjs`         | Keys confined to `signer/`; put; read back and compare SHA-256   |
| `tools/signer-release/publish.mjs`                | The CLI the workflow calls: upload, manifest, verify             |
| `tools/signer-release/test/*.test.mjs`            | `node --test` coverage, including a workflow-shape test          |
| `.github/workflows/signer-stable-release.yml`     | Authorize, build, sign, publish, announce                        |
| `apps/signer/src/lib/updates.ts`                  | Check and install                                                |
| `apps/signer/src/components/UpdateBanner.tsx`     | The consent surface                                              |
| `apps/signer/src-tauri/capabilities/default.json` | Grant `updater:default`                                          |
| `docs/runbooks/signer-release.md`                 | How to cut a release and how to verify one                       |

---

### Task 1: Version gate and manifest builder

**Files:**

- Create: `tools/signer-release/version.mjs`
- Create: `tools/signer-release/manifest.mjs`
- Create: `tools/signer-release/test/version.test.mjs`
- Create: `tools/signer-release/test/manifest.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: nothing.
- Produces, used by Tasks 3 and 4:
  - `SIGNER_TAURI_CONFIG: string`
  - `readSignerVersion(configPath?: string): Promise<string>`
  - `signerReleaseTag(version: string): string`
  - `assertTagIsFree(tag: string, existingTags: string[]): void`
  - `signerArtifactNames(version: string): { installer: string; signature: string }`
  - `SIGNER_CHANNEL_BASE_URL: string`
  - `buildSignerManifest({ version, pubDate, bundleUrl, signature }): object`
  - `assertValidSignerManifest(manifest: object): void`

- [ ] **Step 1: Write the failing tests**

Create `tools/signer-release/test/version.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTagIsFree,
  readSignerVersion,
  signerArtifactNames,
  signerReleaseTag,
} from "../version.mjs";

test("reads the version from the signer's own Tauri config", async () => {
  // One source of truth. Anything that names the version a second time
  // eventually disagrees with this one.
  assert.match(await readSignerVersion(), /^\d+\.\d+\.\d+$/);
});

test("derives the tag from the version", () => {
  assert.equal(signerReleaseTag("0.1.0"), "signer-v0.1.0");
});

test("refuses a version that was already published", () => {
  // Re-dispatching after a partial failure is the normal way this workflow
  // gets used. Replacing a published artifact would break the signature
  // clients already trust, so the gate refuses instead of overwriting.
  assert.throws(
    () => assertTagIsFree("signer-v0.1.0", ["signer-v0.0.9", "signer-v0.1.0"]),
    /already published/,
  );
});

test("accepts a version that has never been published", () => {
  assert.doesNotThrow(() => assertTagIsFree("signer-v0.2.0", ["signer-v0.1.0"]));
});

test("names the NSIS installer and its detached signature", () => {
  // With targets: ["nsis"], Tauri 2's updater artifact is the setup .exe
  // itself plus a sibling .sig — there is no .nsis.zip.
  assert.deepEqual(signerArtifactNames("0.1.0"), {
    installer: "markiro-signer-0.1.0-windows-x86_64-setup.exe",
    signature: "markiro-signer-0.1.0-windows-x86_64-setup.exe.sig",
  });
});
```

Create `tools/signer-release/test/manifest.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidSignerManifest,
  buildSignerManifest,
  SIGNER_CHANNEL_BASE_URL,
} from "../manifest.mjs";

const VALID = {
  version: "0.1.0",
  pubDate: "2026-08-30T12:00:00.000Z",
  bundleUrl: `${SIGNER_CHANNEL_BASE_URL}/releases/0.1.0/markiro-signer-0.1.0-windows-x86_64-setup.exe`,
  signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=",
};

test("builds exactly the Tauri v2 updater shape", () => {
  const manifest = buildSignerManifest(VALID);
  assert.deepEqual(Object.keys(manifest).sort(), ["platforms", "pub_date", "version"]);
  assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64"]);
  assert.deepEqual(Object.keys(manifest.platforms["windows-x86_64"]).sort(), ["signature", "url"]);
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.pub_date, VALID.pubDate);
  assert.equal(manifest.platforms["windows-x86_64"].url, VALID.bundleUrl);
  assert.equal(manifest.platforms["windows-x86_64"].signature, VALID.signature);
});

test("refuses a bundle URL outside the channel the agent polls", () => {
  // A manifest pointing somewhere the agent does not look is the defect most
  // likely to ship unnoticed: the release goes green and no client updates.
  assert.throws(
    () =>
      buildSignerManifest({
        ...VALID,
        bundleUrl:
          "https://releases.markiro.app/signer/beta/releases/0.1.0/markiro-signer-0.1.0-windows-x86_64-setup.exe",
      }),
    /signer\/stable/,
  );
});

test("rejects an empty signature", () => {
  assert.throws(() => buildSignerManifest({ ...VALID, signature: "" }), /signature/);
});

test("rejects an unparseable publication date", () => {
  assert.throws(() => buildSignerManifest({ ...VALID, pubDate: "yesterday" }), /invalid/);
});

test("rejects a manifest carrying an extra key", () => {
  const manifest = { ...buildSignerManifest(VALID), notes: "hello" };
  assert.throws(() => assertValidSignerManifest(manifest), /invalid signer manifest/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tools/signer-release/test/*.test.mjs`
Expected: FAIL — neither module exists (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Implement**

Create `tools/signer-release/version.mjs`:

```js
import { readFile } from "node:fs/promises";

export const SIGNER_TAURI_CONFIG = "apps/signer/src-tauri/tauri.conf.json";

/** The single source of the release version; nothing else may name it. */
export async function readSignerVersion(configPath = SIGNER_TAURI_CONFIG) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const version = config?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${configPath} has no usable semantic version`);
  }
  return version;
}

export function signerReleaseTag(version) {
  return `signer-v${version}`;
}

export function assertTagIsFree(tag, existingTags) {
  if (existingTags.includes(tag)) {
    throw new Error(
      `${tag} is already published; bump "version" in ${SIGNER_TAURI_CONFIG} rather than republishing`,
    );
  }
}

/**
 * `targets: ["nsis"]` with `createUpdaterArtifacts` yields the setup .exe and
 * a sibling .sig. The .exe is both the installer a human downloads and the
 * bundle the updater fetches, so there is exactly one artifact plus its
 * signature.
 */
export function signerArtifactNames(version) {
  const installer = `markiro-signer-${version}-windows-x86_64-setup.exe`;
  return { installer, signature: `${installer}.sig` };
}
```

Create `tools/signer-release/manifest.mjs`:

```js
/** The one channel the released agent is configured to poll. */
export const SIGNER_CHANNEL_BASE_URL = "https://releases.markiro.app/signer/stable";

export function buildSignerManifest({ version, pubDate, bundleUrl, signature }) {
  if (typeof signature !== "string" || signature.trim().length === 0) {
    throw new Error("signer manifest needs a non-empty signature");
  }
  if (typeof bundleUrl !== "string" || !bundleUrl.startsWith(`${SIGNER_CHANNEL_BASE_URL}/`)) {
    throw new Error(`bundle URL must live under ${SIGNER_CHANNEL_BASE_URL} (signer/stable)`);
  }
  const manifest = {
    version,
    pub_date: pubDate,
    platforms: { "windows-x86_64": { url: bundleUrl, signature } },
  };
  assertValidSignerManifest(manifest);
  return manifest;
}

export function assertValidSignerManifest(manifest) {
  const invalid = () => {
    throw new Error("invalid signer manifest");
  };
  if (!manifest || typeof manifest !== "object") invalid();
  if (Object.keys(manifest).sort().join(",") !== "platforms,pub_date,version") invalid();
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) invalid();
  if (typeof manifest.pub_date !== "string" || Number.isNaN(Date.parse(manifest.pub_date))) {
    invalid();
  }
  if (!manifest.platforms || Object.keys(manifest.platforms).join(",") !== "windows-x86_64") {
    invalid();
  }
  const platform = manifest.platforms["windows-x86_64"];
  if (Object.keys(platform).sort().join(",") !== "signature,url") invalid();
  if (typeof platform.url !== "string" || typeof platform.signature !== "string") invalid();
}
```

Add to the root `package.json` `scripts`, on the line immediately after `"test:station-release:contract"`:

```json
    "test:signer-release:contract": "node --test tools/signer-release/test/*.test.mjs",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:signer-release:contract`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add tools/signer-release package.json && git commit -m "feat(signer-release): version gate and updater manifest builder"
```

---

### Task 2: Object storage, prefix-guarded and verified

**Files:**

- Create: `tools/signer-release/object-storage.mjs`
- Create: `tools/signer-release/test/object-storage.test.mjs`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces, used by Task 3:
  - `SIGNER_PREFIX: string`, `SIGNER_MANIFEST_KEY: string`, `SIGNER_PUBLIC_BASE_URL: string`
  - `assertSignerKey(key: string): void`
  - `signerObjectKey({ version, filename }): string`
  - `signerPublicUrl(key: string): string`
  - `createSignerObjectStore({ env?, Client? }): { bucket: string; put(key, body, contentType): Promise<void> }`
  - `putSignerObject({ client, bucket, key, body, contentType }): Promise<void>`
  - `verifyPublishedObject({ url, expectedSha256, fetchImpl? }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tools/signer-release/test/object-storage.test.mjs`:

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertSignerKey,
  createSignerObjectStore,
  SIGNER_MANIFEST_KEY,
  signerObjectKey,
  signerPublicUrl,
  verifyPublishedObject,
} from "../object-storage.mjs";

const ENV = {
  YANDEX_STATION_RELEASE_ENDPOINT: "https://storage.yandexcloud.net",
  YANDEX_STATION_RELEASE_BUCKET: "markiro-prod-station-releases-b1gi7na10jf4j62m62df",
  YANDEX_STATION_RELEASE_ACCESS_KEY_ID: "id",
  YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY: "secret",
};

test("places a release artifact under the stable channel", () => {
  assert.equal(
    signerObjectKey({ version: "0.1.0", filename: "markiro-signer-0.1.0-setup.exe" }),
    "signer/stable/releases/0.1.0/markiro-signer-0.1.0-setup.exe",
  );
  assert.equal(SIGNER_MANIFEST_KEY, "signer/stable/latest.json");
});

test("maps a key onto the public URL the agent fetches", () => {
  assert.equal(
    signerPublicUrl(SIGNER_MANIFEST_KEY),
    "https://releases.markiro.app/signer/stable/latest.json",
  );
});

test("refuses a key outside the signer prefix", () => {
  // This bucket also holds the Station's releases. Nothing in this tool may be
  // able to write to them, however it is called.
  assert.throws(() => assertSignerKey("station/stable/latest.json"), /signer\//);
  assert.throws(() => assertSignerKey("../signer/stable/latest.json"), /signer\//);
  assert.throws(() => assertSignerKey("signer/stable/../../station/x"), /signer\//);
  assert.doesNotThrow(() => assertSignerKey("signer/stable/latest.json"));
});

test("refuses to build a store from an unexpected endpoint", () => {
  assert.throws(
    () =>
      createSignerObjectStore({
        env: { ...ENV, YANDEX_STATION_RELEASE_ENDPOINT: "https://example.invalid" },
      }),
    /endpoint/,
  );
});

test("refuses to build a store when a credential is missing", () => {
  assert.throws(
    () =>
      createSignerObjectStore({
        env: { ...ENV, YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY: "" },
      }),
    /credential/,
  );
});

test("accepts a published object whose bytes hash to what was uploaded", async () => {
  const body = Buffer.from("installer bytes");
  await verifyPublishedObject({
    url: signerPublicUrl(SIGNER_MANIFEST_KEY),
    expectedSha256: createHash("sha256").update(body).digest("hex"),
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
});

test("rejects a published object whose bytes differ", async () => {
  // The failure this step exists for: a truncated or half-propagated upload,
  // which otherwise reaches a customer as a broken update rather than a red
  // build.
  await assert.rejects(
    verifyPublishedObject({
      url: signerPublicUrl(SIGNER_MANIFEST_KEY),
      expectedSha256: createHash("sha256").update(Buffer.from("expected")).digest("hex"),
      fetchImpl: async () => new Response(Buffer.from("truncated"), { status: 200 }),
    }),
    /does not match/,
  );
});

test("rejects a published object that is not publicly readable", async () => {
  await assert.rejects(
    verifyPublishedObject({
      url: signerPublicUrl(SIGNER_MANIFEST_KEY),
      expectedSha256: "0".repeat(64),
      fetchImpl: async () => new Response("", { status: 403 }),
    }),
    /403/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:signer-release:contract`
Expected: FAIL — `object-storage.mjs` does not exist.

- [ ] **Step 3: Implement**

Create `tools/signer-release/object-storage.mjs`:

```js
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

export const SIGNER_PREFIX = "signer/";
export const SIGNER_MANIFEST_KEY = "signer/stable/latest.json";
export const SIGNER_PUBLIC_BASE_URL = "https://releases.markiro.app";

const YANDEX_S3_ENDPOINT = "https://storage.yandexcloud.net";

/**
 * The signer shares a bucket with the Station's releases, so every key goes
 * through this guard before it can reach a PutObjectCommand.
 */
export function assertSignerKey(key) {
  if (typeof key !== "string" || !key.startsWith(SIGNER_PREFIX) || key.includes("..")) {
    throw new Error(`object key must live under ${SIGNER_PREFIX}: ${key}`);
  }
}

export function signerObjectKey({ version, filename }) {
  const key = `signer/stable/releases/${version}/${filename}`;
  assertSignerKey(key);
  return key;
}

export function signerPublicUrl(key) {
  assertSignerKey(key);
  return `${SIGNER_PUBLIC_BASE_URL}/${key}`;
}

export function createSignerObjectStore({ env = process.env, Client = S3Client } = {}) {
  if (env.YANDEX_STATION_RELEASE_ENDPOINT !== YANDEX_S3_ENDPOINT) {
    throw new Error(`unexpected object storage endpoint; expected ${YANDEX_S3_ENDPOINT}`);
  }
  const bucket = env.YANDEX_STATION_RELEASE_BUCKET;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? "") || bucket.includes("..")) {
    throw new Error("YANDEX_STATION_RELEASE_BUCKET is not a usable bucket name");
  }
  const accessKeyId = env.YANDEX_STATION_RELEASE_ACCESS_KEY_ID;
  const secretAccessKey = env.YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("object storage credential is missing");
  }
  const client = new Client({
    endpoint: YANDEX_S3_ENDPOINT,
    region: "ru-central1",
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    bucket,
    put: (key, body, contentType) => putSignerObject({ client, bucket, key, body, contentType }),
  };
}

export async function putSignerObject({ client, bucket, key, body, contentType }) {
  assertSignerKey(key);
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
}

/**
 * Reads the object back over the public URL the agent will use, not over the
 * S3 API: a put that succeeded says nothing about what a client fetches.
 */
export async function verifyPublishedObject({ url, expectedSha256, fetchImpl = fetch }) {
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`published object is not readable: ${url} returned ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(
      `published object does not match what was uploaded: ${url} (${actual} != ${expectedSha256})`,
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:signer-release:contract`
Expected: PASS, 18 tests across three files.

- [ ] **Step 5: Commit**

```bash
git add tools/signer-release && git commit -m "feat(signer-release): prefix-guarded object storage with read-back verification"
```

---

### Task 3: The publish CLI and the release workflow

**Files:**

- Create: `tools/signer-release/publish.mjs`
- Create: `.github/workflows/signer-stable-release.yml`
- Create: `tools/signer-release/test/publish.test.mjs`
- Create: `tools/signer-release/test/workflow.test.mjs`

**Interfaces:**

- Consumes: everything Tasks 1 and 2 produce.
- Produces: `publishSignerRelease({ version, bundleDir, pubDate, store, fetchImpl }): Promise<{ installerUrl: string; manifestUrl: string }>`, plus a `node tools/signer-release/publish.mjs <version> <bundleDir>` entry point the workflow calls.

- [ ] **Step 1: Write the failing tests**

Create `tools/signer-release/test/publish.test.mjs`:

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishSignerRelease } from "../publish.mjs";

const VERSION = "0.1.0";
const INSTALLER_BYTES = Buffer.from("nsis installer");
const SIGNATURE = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=";

async function bundleDirWith({ installer = true, signature = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "signer-publish-"));
  if (installer) {
    await writeFile(join(dir, "Markiro Signer_0.1.0_x64-setup.exe"), INSTALLER_BYTES);
  }
  if (signature) {
    await writeFile(join(dir, "Markiro Signer_0.1.0_x64-setup.exe.sig"), `${SIGNATURE}\n`);
  }
  return dir;
}

/** A store that records puts and serves them back, standing in for the mirror. */
function fakeMirror() {
  const objects = new Map();
  return {
    objects,
    store: {
      bucket: "bucket",
      put: async (key, body) => {
        objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
      },
    },
    fetchImpl: async (url) => {
      const key = new URL(url).pathname.slice(1);
      const body = objects.get(key);
      return body ? new Response(body, { status: 200 }) : new Response("", { status: 404 });
    },
  };
}

test("uploads the installer, its signature and a manifest that points at them", async () => {
  const mirror = fakeMirror();
  const result = await publishSignerRelease({
    version: VERSION,
    bundleDir: await bundleDirWith(),
    pubDate: "2026-08-30T12:00:00.000Z",
    store: mirror.store,
    fetchImpl: mirror.fetchImpl,
  });

  assert.deepEqual([...mirror.objects.keys()].sort(), [
    "signer/stable/latest.json",
    "signer/stable/releases/0.1.0/markiro-signer-0.1.0-windows-x86_64-setup.exe",
    "signer/stable/releases/0.1.0/markiro-signer-0.1.0-windows-x86_64-setup.exe.sig",
  ]);

  const manifest = JSON.parse(mirror.objects.get("signer/stable/latest.json").toString("utf8"));
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.platforms["windows-x86_64"].url, result.installerUrl);
  // The .sig file's trailing newline must not reach the manifest: Tauri
  // compares the signature verbatim.
  assert.equal(manifest.platforms["windows-x86_64"].signature, SIGNATURE);
});

test("verifies the published bytes over the public URL", async () => {
  const mirror = fakeMirror();
  // A mirror that serves back something other than what was put is exactly the
  // half-propagated upload this step exists to catch.
  const corrupting = async (url) => {
    const key = new URL(url).pathname.slice(1);
    if (key.endsWith("-setup.exe")) return new Response(Buffer.from("truncated"), { status: 200 });
    return mirror.fetchImpl(url);
  };
  await assert.rejects(
    publishSignerRelease({
      version: VERSION,
      bundleDir: await bundleDirWith(),
      pubDate: "2026-08-30T12:00:00.000Z",
      store: mirror.store,
      fetchImpl: corrupting,
    }),
    /does not match/,
  );
});

test("refuses a bundle directory with no signature", async () => {
  const mirror = fakeMirror();
  await assert.rejects(
    publishSignerRelease({
      version: VERSION,
      bundleDir: await bundleDirWith({ signature: false }),
      pubDate: "2026-08-30T12:00:00.000Z",
      store: mirror.store,
      fetchImpl: mirror.fetchImpl,
    }),
    /signature/,
  );
});

test("refuses a bundle directory with no installer", async () => {
  const mirror = fakeMirror();
  await assert.rejects(
    publishSignerRelease({
      version: VERSION,
      bundleDir: await bundleDirWith({ installer: false }),
      pubDate: "2026-08-30T12:00:00.000Z",
      store: mirror.store,
      fetchImpl: mirror.fetchImpl,
    }),
    /installer/,
  );
});

test("uploads the manifest only after the artifacts it names", async () => {
  // latest.json is what the agent reads. Publishing it first would advertise a
  // download that is not there yet.
  const mirror = fakeMirror();
  const order = [];
  const store = {
    bucket: "bucket",
    put: async (key, body) => {
      order.push(key);
      await mirror.store.put(key, body);
    },
  };
  await publishSignerRelease({
    version: VERSION,
    bundleDir: await bundleDirWith(),
    pubDate: "2026-08-30T12:00:00.000Z",
    store,
    fetchImpl: mirror.fetchImpl,
  });
  assert.equal(order.at(-1), "signer/stable/latest.json");
});
```

Create `tools/signer-release/test/workflow.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/signer-stable-release.yml", "utf8");

test("is dispatch-only", () => {
  // A release is a deliberate act; nothing about a merge to main should ship one.
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^ {2}(push|pull_request|schedule):/m);
});

test("gates on the repository owner and a typed confirmation", () => {
  assert.match(workflow, /owner_confirmation:/);
  assert.match(workflow, /PUBLISH-SIGNER-STABLE/);
  assert.match(workflow, /RELEASE_OWNER: \$\{\{ github\.repository_owner \}\}/);
  assert.match(workflow, /test "\$RELEASE_ACTOR" = "\$RELEASE_OWNER"/);
});

test("authorizes in a job that holds no permissions and no secrets", () => {
  // The gate must not be able to publish anything even if it is subverted.
  const authorize = workflow.slice(
    workflow.indexOf("  authorize:"),
    workflow.indexOf("  release:"),
  );
  assert.match(authorize, /permissions: \{\}/);
  assert.doesNotMatch(authorize, /environment:/);
  assert.match(workflow, /needs: authorize/);
});

test("draws every credential from the station-release environment", () => {
  assert.match(workflow, /environment: station-release/);
  assert.match(workflow, /secrets\.SIGNER_TAURI_SIGNING_PRIVATE_KEY\b/);
  assert.match(workflow, /secrets\.SIGNER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD\b/);
  assert.match(workflow, /secrets\.YANDEX_STATION_RELEASE_ACCESS_KEY_ID/);
  assert.match(workflow, /secrets\.YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY/);
  assert.match(workflow, /vars\.YANDEX_STATION_RELEASE_BUCKET/);
  // The Station's key must never sign a signer build, and vice versa.
  assert.doesNotMatch(workflow, /secrets\.TAURI_SIGNING_PRIVATE_KEY\b/);
});

test("builds Windows with the stable config overlay", () => {
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /--config src-tauri\/tauri\.stable\.conf\.json/);
  // CI's signer job uses --no-bundle to prove compilation; a release must bundle.
  assert.doesNotMatch(workflow, /--no-bundle/);
});

test("never puts the signing key on a command line", () => {
  assert.match(workflow, /normalize-signing-key\.mjs/);
  assert.match(workflow, /chmod 600/);
  assert.doesNotMatch(workflow, /tauri build[^\n]*\$TAURI_SIGNING_PRIVATE_KEY/);
});

test("writes the mirror before creating the GitHub Release", () => {
  // The updater endpoint reads the mirror. Announcing first would advertise a
  // release clients cannot fetch.
  const mirror = workflow.indexOf("signer-release/publish.mjs");
  const release = workflow.indexOf("gh release create");
  assert.ok(mirror > 0, "the mirror publish step must exist");
  assert.ok(release > 0, "the GitHub Release step must exist");
  assert.ok(mirror < release, "the mirror publish must precede the GitHub Release");
});

test("runs the tooling contract before it builds anything", () => {
  const contract = workflow.indexOf("pnpm test:signer-release:contract");
  const build = workflow.indexOf("tauri build");
  assert.ok(contract > 0 && contract < build);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:signer-release:contract`
Expected: FAIL — `publish.mjs` and the workflow file do not exist.

- [ ] **Step 3: Implement the publish CLI**

Create `tools/signer-release/publish.mjs`:

```js
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import process from "node:process";

import { buildSignerManifest } from "./manifest.mjs";
import {
  createSignerObjectStore,
  SIGNER_MANIFEST_KEY,
  signerObjectKey,
  signerPublicUrl,
  verifyPublishedObject,
} from "./object-storage.mjs";
import { signerArtifactNames } from "./version.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Tauri names the bundle from productName and version ("Markiro Signer_0.1.0_
 * x64-setup.exe"), which is not a name to put in a URL. The exact spelling has
 * changed between Tauri releases, so the directory is searched by suffix
 * rather than by a name this file predicts.
 */
async function locateBundle(bundleDir) {
  const entries = await readdir(bundleDir);
  const installer = entries.find((name) => name.endsWith("-setup.exe"));
  if (!installer) {
    throw new Error(`no NSIS installer (*-setup.exe) in ${bundleDir}`);
  }
  const signature = `${installer}.sig`;
  if (!entries.includes(signature)) {
    throw new Error(`no detached signature ${signature} in ${bundleDir}; the build was not signed`);
  }
  return { installer, signature };
}

export async function publishSignerRelease({
  version,
  bundleDir,
  pubDate,
  store,
  fetchImpl = fetch,
}) {
  const found = await locateBundle(bundleDir);
  const names = signerArtifactNames(version);
  const installerBytes = await readFile(join(bundleDir, found.installer));
  const signatureBytes = await readFile(join(bundleDir, found.signature));
  // Tauri compares the manifest signature verbatim; the .sig file ends with a
  // newline that must not travel with it.
  const signature = signatureBytes.toString("utf8").trim();

  const installerKey = signerObjectKey({ version, filename: names.installer });
  const signatureKey = signerObjectKey({ version, filename: names.signature });
  const installerUrl = signerPublicUrl(installerKey);

  const manifest = buildSignerManifest({ version, pubDate, bundleUrl: installerUrl, signature });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await store.put(installerKey, installerBytes, "application/vnd.microsoft.portable-executable");
  await store.put(signatureKey, signatureBytes, "text/plain");
  // Last, deliberately: latest.json is what the agent reads, so it may not
  // name a download that has not landed yet.
  await store.put(SIGNER_MANIFEST_KEY, manifestBytes, "application/json");

  const manifestUrl = signerPublicUrl(SIGNER_MANIFEST_KEY);
  await verifyPublishedObject({
    url: installerUrl,
    expectedSha256: sha256(installerBytes),
    fetchImpl,
  });
  await verifyPublishedObject({
    url: manifestUrl,
    expectedSha256: sha256(manifestBytes),
    fetchImpl,
  });

  return { installerUrl, manifestUrl };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  const [version, bundleDir] = process.argv.slice(2);
  if (!version || !bundleDir) {
    console.error("usage: node tools/signer-release/publish.mjs <version> <bundle-dir>");
    process.exit(2);
  }
  const result = await publishSignerRelease({
    version,
    bundleDir,
    pubDate: new Date().toISOString(),
    store: createSignerObjectStore({}),
  });
  console.log(result.manifestUrl);
  console.log(result.installerUrl);
}
```

- [ ] **Step 4: Implement the workflow**

Create `.github/workflows/signer-stable-release.yml`. The setup steps below are the pinned action SHAs from `ci.yml`'s `signer-windows-build` job; verify they still match that job before committing, and take that job's versions if they have moved.

```yaml
name: Publish signer stable

on:
  workflow_dispatch:
    inputs:
      owner_confirmation:
        description: Type PUBLISH-SIGNER-STABLE; only the repository owner may dispatch
        required: true
        type: string

permissions:
  contents: read

concurrency:
  group: signer-stable-release
  cancel-in-progress: false

jobs:
  authorize:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions: {}
    steps:
      - name: Authorize signer stable release owner
        shell: bash
        env:
          OWNER_CONFIRMATION: ${{ inputs.owner_confirmation }}
          RELEASE_ACTOR: ${{ github.actor }}
          RELEASE_OWNER: ${{ github.repository_owner }}
        run: |
          set -euo pipefail
          test "$GITHUB_REF" = "refs/heads/main"
          test "$RELEASE_ACTOR" = "$RELEASE_OWNER"
          test "$OWNER_CONFIRMATION" = "PUBLISH-SIGNER-STABLE"

  release:
    if: github.ref == 'refs/heads/main'
    needs: authorize
    runs-on: windows-latest
    timeout-minutes: 60
    environment: station-release
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 24
          cache: pnpm
      - uses: dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4 # stable

      - name: Install locked workspace dependencies
        shell: bash
        run: pnpm install --frozen-lockfile

      - name: Resolve and gate the release version
        id: version
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          SIGNING_KEY: ${{ secrets.SIGNER_TAURI_SIGNING_PRIVATE_KEY }}
          SIGNING_KEY_PASSWORD: ${{ secrets.SIGNER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        run: |
          set -euo pipefail
          test -n "$SIGNING_KEY"
          test -n "$SIGNING_KEY_PASSWORD"
          pnpm test:signer-release:contract
          version="$(node -e 'import("./tools/signer-release/version.mjs").then(async (m) => process.stdout.write(await m.readSignerVersion()))')"
          tag="signer-v$version"
          existing="$(gh release list --limit 200 --json tagName --jq '[.[].tagName] | join(",")')"
          node -e 'import("./tools/signer-release/version.mjs").then((m) => m.assertTagIsFree(process.argv[1], process.argv[2] ? process.argv[2].split(",") : []))' "$tag" "$existing"
          printf 'version=%s\n' "$version" >> "$GITHUB_OUTPUT"
          printf 'tag=%s\n' "$tag" >> "$GITHUB_OUTPUT"

      - name: Verify the signer before releasing it
        shell: bash
        run: |
          set -euo pipefail
          pnpm turbo build --filter '@markiro/signer...'
          pnpm --filter @markiro/signer test
          pnpm --filter @markiro/signer typecheck
          pnpm --filter @markiro/signer lint
          # The CryptoAPI and DPAPI paths only compile on Windows, so this is
          # the last chance to run them before the build a customer installs.
          cargo test --manifest-path apps/signer/Cargo.toml

      - name: Build signed Windows artifacts
        id: build
        shell: bash
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.SIGNER_TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.SIGNER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        run: |
          set -euo pipefail
          printf '%s' "$TAURI_SIGNING_PRIVATE_KEY" | node tools/station-release/normalize-signing-key.mjs > /dev/null
          signing_key_file="$RUNNER_TEMP/signer-stable-updater.key"
          trap 'rm -f "$signing_key_file"' EXIT
          printf '%s' "$TAURI_SIGNING_PRIVATE_KEY" > "$signing_key_file"
          chmod 600 "$signing_key_file"
          export TAURI_SIGNING_PRIVATE_KEY="$signing_key_file"
          pnpm --filter @markiro/signer tauri build \
            --config src-tauri/tauri.stable.conf.json
          bundle_dir="apps/signer/src-tauri/target/release/bundle/nsis"
          test -n "$(find "$bundle_dir" -maxdepth 1 -type f -name '*-setup.exe' -print -quit)"
          printf 'bundle_dir=%s\n' "$bundle_dir" >> "$GITHUB_OUTPUT"

      - name: Publish to the release mirror
        id: mirror
        shell: bash
        env:
          YANDEX_STATION_RELEASE_ENDPOINT: ${{ vars.YANDEX_STATION_RELEASE_ENDPOINT }}
          YANDEX_STATION_RELEASE_BUCKET: ${{ vars.YANDEX_STATION_RELEASE_BUCKET }}
          YANDEX_STATION_RELEASE_ACCESS_KEY_ID: ${{ secrets.YANDEX_STATION_RELEASE_ACCESS_KEY_ID }}
          YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY: ${{ secrets.YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY }}
          RELEASE_VERSION: ${{ steps.version.outputs.version }}
          BUNDLE_DIR: ${{ steps.build.outputs.bundle_dir }}
        run: |
          set -euo pipefail
          node tools/signer-release/publish.mjs "$RELEASE_VERSION" "$BUNDLE_DIR" \
            | tee "$RUNNER_TEMP/published.txt"
          printf 'manifest_url=%s\n' "$(sed -n 1p "$RUNNER_TEMP/published.txt")" >> "$GITHUB_OUTPUT"
          printf 'installer_url=%s\n' "$(sed -n 2p "$RUNNER_TEMP/published.txt")" >> "$GITHUB_OUTPUT"

      - name: Announce the GitHub Release
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          RELEASE_VERSION: ${{ steps.version.outputs.version }}
          RELEASE_TAG: ${{ steps.version.outputs.tag }}
          BUNDLE_DIR: ${{ steps.build.outputs.bundle_dir }}
          INSTALLER_URL: ${{ steps.mirror.outputs.installer_url }}
        run: |
          set -euo pipefail
          installer="$(find "$BUNDLE_DIR" -maxdepth 1 -type f -name '*-setup.exe' -print -quit)"
          named="$RUNNER_TEMP/markiro-signer-$RELEASE_VERSION-windows-x86_64-setup.exe"
          cp "$installer" "$named"
          notes="$RUNNER_TEMP/notes.md"
          {
            printf 'Установщик агента подписи Честного ЗНАКа для Windows.\n\n'
            printf 'Прямая ссылка: %s\n\n' "$INSTALLER_URL"
            printf 'Установленный агент обновляется сам, с подтверждением оператора.\n'
          } > "$notes"
          gh release create "$RELEASE_TAG" "$named" \
            --title "Markiro Подписант $RELEASE_VERSION" \
            --notes-file "$notes"
```

- [ ] **Step 5: Run the tests**

```bash
pnpm test:signer-release:contract && pnpm exec prettier --check .github/workflows/signer-stable-release.yml
```

Expected: PASS, 31 tests across four files, and prettier clean.

- [ ] **Step 6: Commit**

```bash
git add tools/signer-release .github/workflows/signer-stable-release.yml && git commit -m "feat(signer-release): dispatch-only stable release workflow"
```

---

### Task 4: The agent updates itself, with consent

**Files:**

- Create: `apps/signer/src/lib/updates.ts`
- Create: `apps/signer/src/components/UpdateBanner.tsx`
- Create: `apps/signer/test/updates.test.tsx`
- Modify: `apps/signer/src/App.tsx`
- Modify: `apps/signer/src/lib/bridge.ts`
- Modify: `apps/signer/src-tauri/src/lib.rs`, `apps/signer/src-tauri/src/commands.rs`
- Modify: `apps/signer/src-tauri/capabilities/default.json`
- Modify: `apps/signer/src/i18n/ru.json`, `apps/signer/src/i18n/en.json`

**Interfaces:**

- Consumes: `@tauri-apps/plugin-updater` (a dependency at 2.10.1, registered in `apps/signer/src-tauri/src/lib.rs:33`) and `@tauri-apps/plugin-process` (for the relaunch after install).
- Produces:
  - `interface SignerUpdate { version: string; notes: string | null; install: () => Promise<void> }`
  - `UPDATE_CHECK_INTERVAL_MS: number`
  - `checkForUpdate(): Promise<SignerUpdate | null>`
  - `announceUpdate(update: SignerUpdate, announced: Set<string>): Promise<void>`
  - `<UpdateBanner update={SignerUpdate | null} onInstalled={() => void} />`
  - `bridge.notifyUpdateAvailable(version: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `apps/signer/test/updates.test.tsx`. The signer's tests are vitest with `@testing-library/react` and no jest-dom; assert on raw DOM, the way `apps/signer/test/certificate-picker.test.tsx` does.

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkMock = vi.fn();
const relaunchMock = vi.fn();
const notifyMock = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunchMock() }));
vi.mock("../src/lib/bridge.js", () => ({
  bridge: { notifyUpdateAvailable: (version: string) => notifyMock(version) },
}));

import "../src/i18n/index.js";
import { UpdateBanner } from "../src/components/UpdateBanner.js";
import { announceUpdate, checkForUpdate } from "../src/lib/updates.js";

describe("signer updates", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    checkMock.mockReset();
    relaunchMock.mockReset();
    notifyMock.mockReset();
    notifyMock.mockResolvedValue(undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("reports no update when the mirror has nothing newer", async () => {
    checkMock.mockResolvedValue(null);
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("surfaces an available update without installing it", async () => {
    const downloadAndInstall = vi.fn();
    checkMock.mockResolvedValue({ version: "0.2.0", body: "fixes", downloadAndInstall });

    const update = await checkForUpdate();

    expect(update).toMatchObject({ version: "0.2.0", notes: "fixes" });
    // Installing restarts the agent, and the agent is what keeps the tenant's
    // token fresh. A restart nobody asked for reads as a dead integration.
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("survives a mirror that cannot be reached", async () => {
    checkMock.mockRejectedValue(new Error("ENOTFOUND releases.markiro.app"));
    // Losing token refresh because an update check failed would be far worse
    // than running an old build.
    await expect(checkForUpdate()).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("renders nothing when there is no update", () => {
    const { container } = render(<UpdateBanner update={null} onInstalled={() => undefined} />);
    expect(container.textContent).toBe("");
  });

  it("installs and relaunches only when the operator asks", async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    checkMock.mockResolvedValue({ version: "0.2.0", body: null, downloadAndInstall });
    const update = await checkForUpdate();

    render(<UpdateBanner update={update} onInstalled={() => undefined} />);
    expect(screen.getByText(/0\.2\.0/)).toBeTruthy();
    expect(downloadAndInstall).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /обнов/i }));

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("announces a version to the tray at most once", async () => {
    // An operator who decided to install later must not be told again on
    // every daily check.
    checkMock.mockResolvedValue({ version: "0.2.0", body: null, downloadAndInstall: vi.fn() });
    const update = await checkForUpdate();
    const announced = new Set<string>();

    await announceUpdate(update!, announced);
    await announceUpdate(update!, announced);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith("0.2.0");
  });

  it("still shows the banner when the tray refuses the notification", async () => {
    notifyMock.mockRejectedValue(new Error("notifications are disabled"));
    checkMock.mockResolvedValue({ version: "0.2.0", body: null, downloadAndInstall: vi.fn() });
    const update = await checkForUpdate();

    await expect(announceUpdate(update!, new Set())).resolves.toBeUndefined();
  });

  it("keeps the agent usable when an install fails", async () => {
    const downloadAndInstall = vi.fn().mockRejectedValue(new Error("download failed"));
    checkMock.mockResolvedValue({ version: "0.2.0", body: null, downloadAndInstall });
    const update = await checkForUpdate();

    render(<UpdateBanner update={update} onInstalled={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: /обнов/i }));

    // The banner reports the failure and stays; it must not take the window down.
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/signer exec vitest run test/updates.test.tsx`
Expected: FAIL — `../src/lib/updates.js` cannot be resolved.

- [ ] **Step 3: Implement**

Create `apps/signer/src/lib/updates.ts`:

```ts
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import { bridge } from "./bridge.js";

export interface SignerUpdate {
  readonly version: string;
  readonly notes: string | null;
  /** Downloads, installs and relaunches. Only ever called from an operator action. */
  install: () => Promise<void>;
}

/** Once a day is often enough for a tray agent; the mirror changes far less. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Returns `null` both when there is no update and when the check failed. The
 * agent's job is to keep the tenant's token fresh; an unreachable mirror is a
 * reason to log and carry on, never a reason to stop.
 */
export async function checkForUpdate(): Promise<SignerUpdate | null> {
  try {
    const found = await check();
    if (!found) return null;
    return {
      version: found.version,
      notes: found.body ?? null,
      install: async () => {
        await found.downloadAndInstall();
        await relaunch();
      },
    };
  } catch (error) {
    console.warn("signer update check failed", error);
    return null;
  }
}
```

Create `apps/signer/src/components/UpdateBanner.tsx`. Match the class-name and markup conventions of `apps/signer/src/components/CertificatePicker.tsx` — read it first and follow what it does rather than the placeholder class names below:

```tsx
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { SignerUpdate } from "../lib/updates.js";

export function UpdateBanner({
  update,
  onInstalled,
}: {
  update: SignerUpdate | null;
  onInstalled: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!update) return null;

  const install = async (): Promise<void> => {
    setPending(true);
    setFailed(false);
    try {
      await update.install();
      onInstalled();
    } catch {
      // The raw error carries a mirror URL and a stack; neither helps an
      // operator, and the banner has to stay usable so they can retry.
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="update-banner">
      <p>{t("updates.available", { version: update.version })}</p>
      {update.notes ? <p className="update-banner__notes">{update.notes}</p> : null}
      {failed ? <p role="alert">{t("updates.failed")}</p> : null}
      <button type="button" disabled={pending} onClick={() => void install()}>
        {pending ? t("updates.installing") : t("updates.install")}
      </button>
    </section>
  );
}
```

Modify `apps/signer/src-tauri/capabilities/default.json` — the JS `check()` call is denied without this permission, and the omission only shows up at runtime in a packaged build, which is the worst possible place to find it:

```json
  "permissions": [
    "core:default",
    "process:allow-restart",
    "notification:default",
    "updater:default"
  ]
```

Add the tray notification the spec calls for. There is **no** `@tauri-apps/plugin-notification` npm package in this app — the notification plugin is registered Rust-side only, and `notify_if_actionable` in `apps/signer/src-tauri/src/lib.rs:128` is the existing precedent. Add a command next to it rather than a new JS dependency:

```rust
/// An available update is actionable in the same sense a degraded phase is:
/// it needs the operator's hands. The window's banner is where they consent;
/// this is only how they learn to open the window.
#[tauri::command]
pub fn signer_notify_update(app: tauri::AppHandle, version: String) {
    use tauri_plugin_notification::NotificationExt as _;
    let _ = app
        .notification()
        .builder()
        .title("Markiro Подписант")
        .body(format!("Доступна версия {version}"))
        .show();
}
```

Register it in the `generate_handler!` list in `lib.rs`, and add `notifyUpdateAvailable: (version: string) => invoke<void>("signer_notify_update", { version })` to `bridge` in `apps/signer/src/lib/bridge.ts`.

Add the announce-once rule to `apps/signer/src/lib/updates.ts` so it is testable without rendering `App`:

```ts
/**
 * The tray tells the operator to open the window; the banner is where they
 * consent. An operator who decided to install later must not be told again on
 * every daily check, so each version is announced at most once per process.
 */
export async function announceUpdate(update: SignerUpdate, announced: Set<string>): Promise<void> {
  if (announced.has(update.version)) return;
  announced.add(update.version);
  try {
    await bridge.notifyUpdateAvailable(update.version);
  } catch (error) {
    // A tray that will not show is not a reason to hide the banner.
    console.warn("signer update notification failed", error);
  }
}
```

Modify `apps/signer/src/App.tsx`: add a `useEffect` that calls `checkForUpdate()` on mount, stores the result in state, and repeats on a `setInterval` of `UPDATE_CHECK_INTERVAL_MS`, clearing the interval on unmount and guarding the state write with the same `disposed` pattern the existing status effect uses. When a check returns a version the effect has not already announced, call `bridge.notifyUpdateAvailable(version)` and record it in a ref — an operator who has decided to install later should not be told again every day. Render `<UpdateBanner>` above the `Status` view only: the pairing screen is an operator mid-setup, and an update prompt there competes with the one action they came to do.

Add to both `apps/signer/src/i18n/ru.json` and `apps/signer/src/i18n/en.json` an `updates` object with `available` (carrying a `{{version}}` interpolation), `install`, `installing` and `failed`. Both files, because the test-mode i18n handler throws on a missing key in any configured language.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @markiro/signer test && pnpm --filter @markiro/signer typecheck && pnpm --filter @markiro/signer lint
```

Expected: all green, including the pre-existing `tauri-release-config.test.ts`, `app-status-race.test.tsx` and `pairing.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add apps/signer && git commit -m "feat(signer): check for updates and install with operator consent"
```

---

### Task 5: Runbook and full verification

**Files:**

- Create: `docs/runbooks/signer-release.md`

- [ ] **Step 1: Write the runbook**

Match the tone and structure of `docs/runbooks/signer-agent-manual-e2e.md`. Cover, in the order someone cutting a release needs them:

- **Prerequisites** — the `station-release` environment and exactly which secrets and variables it must hold, and that its `required_reviewers` protection means a dispatch waits for an approval before the job starts.
- **Cutting a release** — bump `version` in `apps/signer/src-tauri/tauri.conf.json` on `main` (the single source, and the thing the gate refuses to republish), then dispatch _Publish signer stable_ from `main` and type `PUBLISH-SIGNER-STABLE`.
- **What to check afterwards** — `https://releases.markiro.app/signer/stable/latest.json` names the new version; the installer URL it names downloads; the GitHub Release exists with the `.exe` attached.
- **Verifying the update path end to end**, which is the part nobody will work out under pressure: install the previous version on a Windows machine, publish the new one, open the agent, confirm it offers the new version and that nothing installs until the button is pressed.
- **When it fails** — a failure in the authorize or version step published nothing; a failure in the build published nothing; a failure in the mirror step may have left artifacts uploaded with no `latest.json` naming them, which is inert and is cleared by a successful re-dispatch of the same version; a failure in the announce step means the mirror is live and clients will update while the GitHub Release is missing, so create that release by hand rather than re-dispatching, since the tag gate will refuse.
- **What this does not cover** — the CryptoPro signing path is exercised by `signer-agent-manual-e2e.md`, not by anything here.

- [ ] **Step 2: Run everything**

```bash
pnpm test:signer-release:contract && pnpm --filter @markiro/signer test && pnpm format:check
```

Then:

```bash
pnpm turbo lint typecheck build --concurrency=1 --force
```

Expected: all green. Record the counts in the report.

- [ ] **Step 3: Confirm the untouched surfaces**

```bash
git diff --stat origin/main -- apps/station apps/api packages/db tools/station-release
```

Expected: no output. This slice touches the signer, its release tooling and one workflow — nothing else. `tools/station-release/normalize-signing-key.mjs` is _called_ by the workflow but not modified.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs(runbook): cutting and verifying a signer release"
```

---

## Out of scope

- A beta channel and beta→stable promotion. The two-config split stays because the agent already ships it, but nothing publishes to `signer/beta/`.
- Rollback tooling; reinstalling a prior GitHub Release asset is the recovery path.
- macOS or Linux builds.
- Any change to the Station's release workflows, tooling or secrets.
- Deferring or dismissing an update from the banner. The operator can simply not press the button; the tray announces each version once and then stays quiet.
