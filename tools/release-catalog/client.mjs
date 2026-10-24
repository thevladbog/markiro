import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  catalogIntentViewSchema,
  catalogPublicationResultSchema,
  channelSnapshotSchema,
  channelChangeRequestSchema,
  publicationIntentRequestSchema,
  publicationCommitRequestSchema,
  releaseOperationIdSchema,
  releaseVersionIdSchema,
  publicationRequestSchema,
} from "../../packages/platform-contracts/dist/release-catalog.js";

const API = "https://saas-admin.markiro.app/api/release-publisher";
const PUBLIC = "https://releases.markiro.app";
const AUDIENCE = "markiro-release-catalog";
const JSON_LIMIT = 128 * 1024;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function invalid() {
  throw new Error("invalid release catalog request or response");
}
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) invalid();
  return result.data;
}
function sameIdentity(a, b) {
  return a.product === b.product && a.channel === b.channel && a.version === b.version;
}
function sameFiles(a, b) {
  return (
    a.length === b.length &&
    a.every((file) =>
      b.some(
        (other) =>
          other.name === file.name &&
          other.sha256 === file.sha256 &&
          other.sizeBytes === file.sizeBytes &&
          other.contentType === file.contentType,
      ),
    )
  );
}
async function readBounded(response, limit) {
  if (!response.body) invalid();
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) invalid();
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function json(response) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(response, JSON_LIMIT)),
    );
  } catch {
    invalid();
  }
}
/** Product credentials write only private staging objects. No release-path PUT/HEAD fallback. */
export function createCatalogUploadStore({ env = process.env, Client = S3Client } = {}) {
  if (
    env.RELEASES_S3_ENDPOINT !== "https://s3.twcstorage.ru" ||
    (env.RELEASES_S3_REGION && env.RELEASES_S3_REGION !== "ru-1") ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.RELEASES_S3_BUCKET ?? "") ||
    env.RELEASES_S3_BUCKET.includes("..") ||
    !env.RELEASES_S3_ACCESS_KEY_ID ||
    !env.RELEASES_S3_SECRET_ACCESS_KEY
  )
    invalid();
  const client = new Client({
    endpoint: "https://s3.twcstorage.ru",
    region: "ru-1",
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: env.RELEASES_S3_ACCESS_KEY_ID,
      secretAccessKey: env.RELEASES_S3_SECRET_ACCESS_KEY,
    },
  });
  return {
    async put({ key, body, contentType }) {
      if (!/^(station|handheld)\/_uploads\/[0-9a-f-]{36}\/[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(key))
        invalid();
      try {
        const result = await client.send(
          new PutObjectCommand({
            Bucket: env.RELEASES_S3_BUCKET,
            Key: key,
            Body: body,
            ContentType: contentType,
            ContentMD5: createHash("md5").update(body).digest("base64"),
            CacheControl: "private, no-store",
          }),
          { abortSignal: AbortSignal.timeout(600000) },
        );
        return parse(releaseVersionIdSchema, result.VersionId);
      } catch {
        throw new Error("release catalog staged upload failed; reconcile before retry");
      }
    },
  };
}
/** No automatic mutation retries: callers retain their operation IDs across ambiguous replies. */
export function createCatalogClient({
  env = process.env,
  fetchImpl = fetch,
  store,
  now = Date.now,
} = {}) {
  const verified = new Map();
  let uploadStore = store;
  async function token() {
    try {
      const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".actions.githubusercontent.com") ||
        url.username ||
        url.password ||
        url.port ||
        url.hash ||
        !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
      )
        invalid();
      url.searchParams.set("audience", AUDIENCE);
      const response = await fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) invalid();
      const result = await json(response);
      if (
        typeof result.value !== "string" ||
        result.value.length > 16384 ||
        !/^[A-Za-z0-9_.-]+$/.test(result.value)
      )
        invalid();
      return result.value;
    } catch {
      throw new Error("release catalog OIDC unavailable");
    }
  }
  async function request(method, path, body, schema) {
    const authorization = await token();
    let response;
    try {
      response = await fetchImpl(API + path, {
        method,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(3600000),
        headers: { Authorization: `Bearer ${authorization}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error("release catalog response unavailable; retry only the same operation");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`release catalog request refused (${response.status})`);
    }
    return parse(schema, await json(response));
  }
  async function verifyPublic(result) {
    for (const file of result.files) {
      const response = await fetchImpl(PUBLIC + file.publicPath, {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(3600000),
      });
      if (!response.ok || !response.body)
        throw new Error("release catalog public readback unavailable");
      const hash = createHash("sha256");
      let size = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > file.sizeBytes) invalid();
          hash.update(value);
        }
        if (size !== file.sizeBytes || hash.digest("hex") !== file.sha256)
          throw new Error("release catalog public readback mismatch");
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    verified.set(result.publicationId, result.identity);
  }
  return {
    async createIntent(idempotencyKey, publication) {
      const input = parse(publicationIntentRequestSchema, { idempotencyKey, publication });
      if (!["station", "handheld"].includes(input.publication.identity.product)) invalid();
      const result = await request("POST", "/intents", input, catalogIntentViewSchema);
      if (
        !sameIdentity(result.identity, publication.identity) ||
        !sameFiles(result.files, publication.files)
      )
        invalid();
      return result;
    },
    async getPublication(input) {
      const expected = parse(publicationRequestSchema, input),
        scope = expected.identity;
      if (!["station", "handheld"].includes(scope.product)) invalid();
      const result = await request(
        "GET",
        `/publications/${scope.product}/${scope.channel}/${scope.version}`,
        undefined,
        catalogPublicationResultSchema.nullable(),
      );
      if (result === null) return null;
      if (!sameIdentity(scope, result.identity) || !sameFiles(expected.files, result.files))
        invalid();
      await verifyPublic(result);
      return result;
    },
    async getIntent(id) {
      parse(releaseOperationIdSchema, id);
      const result = await request("GET", `/intents/${id}`, undefined, catalogIntentViewSchema);
      if (result.id !== id) invalid();
      return result;
    },
    async getChannel(identity) {
      const scope = parse(channelSnapshotSchema.shape.identity, identity);
      if (!["station", "handheld"].includes(scope.product)) invalid();
      const result = await request(
        "GET",
        `/channels/${scope.product}/${scope.channel}`,
        undefined,
        channelSnapshotSchema,
      );
      if (result.identity.product !== scope.product || result.identity.channel !== scope.channel)
        invalid();
      return result;
    },
    async uploadFile(input, name, body) {
      const intent = parse(catalogIntentViewSchema, input),
        file = intent.files.find((f) => f.name === name);
      if (
        !file ||
        !["station", "handheld"].includes(intent.identity.product) ||
        intent.state !== "pending" ||
        Date.parse(intent.expiresAt) <= now() ||
        !(body instanceof Uint8Array) ||
        body.byteLength !== file.sizeBytes ||
        sha(body) !== file.sha256
      )
        invalid();
      uploadStore ??= createCatalogUploadStore({ env });
      let versionId;
      try {
        versionId = await uploadStore.put({ key: file.key, body, contentType: file.contentType });
      } catch {
        throw new Error("release catalog staged upload failed; reconcile before retry");
      }
      return { name, versionId: parse(releaseVersionIdSchema, versionId) };
    },
    async commitIntent(input, files) {
      const intent = parse(catalogIntentViewSchema, input),
        commit = parse(publicationCommitRequestSchema, { files });
      if (
        commit.files.length !== intent.files.length ||
        commit.files.some((f) => !intent.files.some((s) => s.name === f.name))
      )
        invalid();
      const result = await request(
        "POST",
        `/intents/${intent.id}/commit`,
        commit,
        catalogPublicationResultSchema,
      );
      if (!sameIdentity(intent.identity, result.identity) || !sameFiles(intent.files, result.files))
        invalid();
      // A retry may return the ORIGINAL physical VersionIds. Semantic identity must match.
      await verifyPublic(result);
      return result;
    },
    async changeChannel(identity, input) {
      const scope = parse(channelSnapshotSchema.shape.identity, identity),
        change = parse(channelChangeRequestSchema, input);
      const accepted = verified.get(change.targetPublicationId);
      if (!accepted || accepted.product !== scope.product || accepted.channel !== scope.channel)
        throw new Error("release catalog publication has not been verified");
      const result = await request(
        "PUT",
        `/channels/${scope.product}/${scope.channel}`,
        change,
        channelSnapshotSchema,
      );
      if (
        result.identity.product !== scope.product ||
        result.identity.channel !== scope.channel ||
        result.publicationId !== change.targetPublicationId ||
        result.revision !== (BigInt(change.expectedRevision) + 1n).toString() ||
        !result.readable
      )
        invalid();
      return result;
    },
  };
}
