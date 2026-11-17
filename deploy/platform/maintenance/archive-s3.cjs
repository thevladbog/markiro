"use strict";

const s3 = require("@aws-sdk/client-s3");
const { createHash } = require("node:crypto");
const { once } = require("node:events");

const [mode, key, version] = process.argv.slice(1);
const env = process.env;
const bucket = env.S3_BUCKET;
const keyPattern =
  /^ops\/rollout-archive\/v1\/[a-f0-9-]{36}\/(?:old-images|edge-image)\.tar\.[a-f0-9]{64}\.cms(?:\.json)?$/u;
const config = {
  Bucket: bucket,
  Key: key,
};
const partSize = 32 * 1024 ** 2;
const maxArchive = 2 * 1024 ** 3;

async function main() {
  const endpoint = new URL(env.S3_ENDPOINT);
  if (
    bucket !== "markiro-tmp-media" ||
    bucket === env.RELEASES_S3_BUCKET ||
    !["https://s3.twcstorage.ru", "https://s3.timeweb.cloud"].includes(endpoint.origin) ||
    endpoint.href !== endpoint.origin + "/" ||
    !keyPattern.test(key)
  )
    throw new Error("archive target refused");
  const client = new s3.S3Client({
    endpoint: endpoint.origin,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
  });
  const send = (command) => client.send(command, { abortSignal: AbortSignal.timeout(120000) });
  const checkVersion = (value) => {
    if (!value || value === "null") throw new Error("versioned archive object required");
    return value;
  };
  try {
    if (mode === "download" || mode === "verify") {
      const response = await client.send(
        new s3.GetObjectCommand({ ...config, VersionId: checkVersion(version) }),
        { abortSignal: AbortSignal.timeout(45 * 60 * 1000) },
      );
      if (response.VersionId !== version || !response.Body)
        throw new Error("wrong version returned");
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of response.Body) {
        bytes += chunk.length;
        if (bytes > maxArchive) throw new Error("archive exceeds limit");
        hash.update(chunk);
        if (mode === "download" && !process.stdout.write(chunk))
          await once(process.stdout, "drain");
      }
      if (bytes !== response.ContentLength) throw new Error("archive size mismatch");
      if (mode === "verify")
        console.log(JSON.stringify({ version, bytes, sha256: hash.digest("hex") }));
      return;
    }
    if (mode === "receipt" && key.endsWith(".cms.json")) {
      const chunks = [];
      let count = 0;
      for await (const chunk of process.stdin) {
        count += chunk.length;
        if (count > 8192) throw new Error("receipt too large");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const out = await send(
        new s3.PutObjectCommand({
          ...config,
          Body: body,
          ContentType: "application/json",
        }),
      );
      const receiptVersion = checkVersion(out.VersionId);
      const readback = await send(
        new s3.GetObjectCommand({ ...config, VersionId: receiptVersion }),
      );
      if (
        readback.VersionId !== receiptVersion ||
        !Buffer.from(await readback.Body.transformToByteArray()).equals(body)
      ) {
        throw new Error("receipt readback mismatch");
      }
      console.log(JSON.stringify({ version: receiptVersion }));
      return;
    }
    if (mode !== "put" || key.endsWith(".json")) throw new Error("unknown archive command");
    const policy = await send(new s3.GetBucketPolicyStatusCommand({ Bucket: bucket }));
    const acl = await send(new s3.GetBucketAclCommand({ Bucket: bucket }));
    if (
      policy.PolicyStatus?.IsPublic !== false ||
      !Array.isArray(acl.Grants) ||
      acl.Grants.some((grant) =>
        /\/(?:AllUsers|AuthenticatedUsers)$/u.test(grant.Grantee?.URI ?? ""),
      )
    ) {
      throw new Error("private archive bucket required");
    }
    const info = await send(new s3.GetBucketVersioningCommand({ Bucket: bucket }));
    if (info.Status !== "Enabled") throw new Error("archive bucket versioning must be enabled");
    try {
      const lifecycle = await send(
        new s3.GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
      );
      if (lifecycle.Rules?.some((rule) => rule.Status === "Enabled"))
        throw new Error("review bucket lifecycle");
    } catch (error) {
      if (error.name !== "NoSuchLifecycleConfiguration") throw error;
    }
    const upload = await send(
      new s3.CreateMultipartUploadCommand({
        ...config,
        ContentType: "application/pkcs7-mime",
      }),
    );
    const uploadId = upload.UploadId;
    if (!uploadId) throw new Error("missing multipart upload id");
    const context = { ...config, UploadId: uploadId };
    const hash = createHash("sha256");
    let bytes = 0;
    let used = 0;
    const buffer = Buffer.allocUnsafe(partSize);
    const parts = [];
    const flush = async () => {
      const PartNumber = parts.length + 1;
      const part = await send(
        new s3.UploadPartCommand({
          ...context,
          PartNumber,
          Body: buffer.subarray(0, used),
          ContentLength: used,
        }),
      );
      if (!part.ETag) throw new Error("missing multipart receipt");
      parts.push({ ETag: part.ETag, PartNumber });
      used = 0;
    };
    try {
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > maxArchive) throw new Error("archive exceeds limit");
        hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) {
          const count = Math.min(chunk.length - offset, buffer.length - used);
          chunk.copy(buffer, used, offset, offset + count);
          used += count;
          offset += count;
          if (used === buffer.length) await flush();
        }
      }
      if (used) await flush();
      if (!parts.length) throw new Error("archive input was empty");
      const completed = await send(
        new s3.CompleteMultipartUploadCommand({
          ...context,
          MultipartUpload: { Parts: parts },
        }),
      );
      console.log(
        JSON.stringify({
          version: checkVersion(completed.VersionId),
          bytes,
          sha256: hash.digest("hex"),
        }),
      );
    } catch (error) {
      await send(new s3.AbortMultipartUploadCommand(context)).catch(() => {});
      throw error;
    }
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.name, http: error.$metadata?.httpStatusCode }));
  process.exitCode = 1;
});
