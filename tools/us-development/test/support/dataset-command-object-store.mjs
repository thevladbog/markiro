import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

const IMAGE =
  "chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d";
// Exact public registry config digests for the selected linux amd64/arm64 images.
const IMAGE_IDS = [
  "sha256:7b5ca1f11aa4c91593612d2d4a9e253ec9152a4bd13a19e551290a042a4c52f5",
  "sha256:8f17c8c82e037886f6aaceb3f6282a5c2a1b52bbef5339d323b0067a75bbbc79",
];
const COMMAND = [
  "mini",
  "-dir=/data",
  "-s3.port=8333",
  "-s3.config=/run/us-s3.json",
  "-admin.ui=false",
  "-webdav=false",
  "-s3.port.iceberg=0",
  "-s3.port.lance=0",
  "-master.telemetry=false",
  "-s3.autoCreateBucket=false",
];
const fail = (operation) => {
  throw new Error(`us_dataset_object_store_${operation}`);
};
const check = (condition, operation) => {
  if (!condition) fail(operation);
};

function contract({ owner, uid, gid, configPath }) {
  check(typeof owner === "string" && /^[a-f0-9-]{36}$/.test(owner), "config_failed");
  check(
    Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0,
    "config_failed",
  );
  check(
    typeof configPath === "string" && isAbsolute(configPath) && !/[\n\r,]/.test(configPath),
    "config_failed",
  );
  return {
    image: IMAGE,
    command: [...COMMAND],
    user: `${uid}:${gid}`,
    tmpfs: `rw,uid=${uid},gid=${gid},mode=0700`,
    configPath,
    owner,
  };
}

/** Pure: consumes generated identities, never discovers/adopts credentials. */
export function datasetObjectStoreConfig(input) {
  contract(input);
  const { accounts, buckets } = input;
  check(
    Array.isArray(buckets) &&
      buckets.length === 2 &&
      new Set(buckets).size === 2 &&
      buckets.every((b) => typeof b === "string" && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(b)),
    "config_failed",
  );
  check(Array.isArray(accounts) && accounts.length === 3, "config_failed");
  for (const key of ["name", "accountId", "accessKeyId", "secretAccessKey"])
    check(
      accounts.every((a) => typeof a?.[key] === "string" && /^[a-zA-Z0-9-]{3,128}$/.test(a[key])) &&
        new Set(accounts.map((a) => a[key])).size === 3,
      "config_failed",
    );
  check(
    accounts.every((a) => a.name !== "anonymous"),
    "config_failed",
  );
  return {
    identities: accounts.map((a, i) => ({
      name: a.name,
      account: { id: a.accountId },
      credentials: [{ accessKey: a.accessKeyId, secretKey: a.secretAccessKey }],
      actions:
        i === 0
          ? ["Admin"]
          : [`Read:${buckets[i - 1]}`, `Write:${buckets[i - 1]}`, `List:${buckets[i - 1]}`],
    })),
  };
}

export function datasetObjectStoreContainer(input) {
  const expected = contract(input);
  return {
    ...expected,
    args: [
      "create",
      "--name",
      `us-dataset-positive-${input.owner}`,
      "--log-driver",
      "none",
      "--label",
      `markiro.us-dataset-positive=${input.owner}`,
      "--entrypoint",
      "/usr/bin/weed",
      "--user",
      expected.user,
      "--workdir",
      "/data",
      "--publish",
      "127.0.0.1:19002:8333",
      "--tmpfs",
      `/data:${expected.tmpfs}`,
      "--mount",
      `type=bind,source=${input.configPath},target=/run/us-s3.json,readonly`,
      IMAGE,
      ...COMMAND,
    ],
  };
}

/** All errors are fixed identifiers: never serialize inspect/config secrets. */
export function assertDatasetObjectStoreContainer(item, input) {
  const expected = contract(input),
    same = isDeepStrictEqual;
  const valid =
    /^[a-f0-9]{64}$/.test(input.id) &&
    item?.Id === input.id &&
    item.Config?.Image === IMAGE &&
    IMAGE_IDS.includes(item.Image) &&
    item.Config.Labels?.["markiro.us-dataset-positive"] === expected.owner &&
    same(item.Config.Entrypoint, ["/usr/bin/weed"]) &&
    same(item.Config.Cmd, COMMAND) &&
    item.Config.User === expected.user &&
    item.Config.WorkingDir === "/data" &&
    !(item.Config.Env ?? []).some((e) => /^(?:MINIO_|AWS_|S3_)/.test(e)) &&
    Object.keys(item.Config.Volumes ?? {}).every((path) => path === "/data") &&
    item.HostConfig?.LogConfig?.Type === "none" &&
    item.HostConfig.Privileged === false &&
    item.HostConfig.PublishAllPorts === false &&
    ["default", "bridge"].includes(item.HostConfig.NetworkMode) &&
    (item.HostConfig.CapAdd ?? []).length === 0 &&
    (item.HostConfig.Devices ?? []).length === 0 &&
    same(item.HostConfig.Binds ?? [], []) &&
    same(item.HostConfig.Tmpfs, { "/data": expected.tmpfs }) &&
    same(item.HostConfig.PortBindings, {
      "8333/tcp": [{ HostIp: "127.0.0.1", HostPort: "19002" }],
    }) &&
    item.HostConfig.Mounts?.length === 1 &&
    item.HostConfig.Mounts[0].Type === "bind" &&
    item.HostConfig.Mounts[0].Source === expected.configPath &&
    item.HostConfig.Mounts[0].Target === "/run/us-s3.json" &&
    item.HostConfig.Mounts[0].ReadOnly === true &&
    Array.isArray(item.Mounts) &&
    item.Mounts.filter((m) => m.Type === "bind").length === 1 &&
    item.Mounts.every(
      (m) =>
        (m.Type === "bind" &&
          m.Source === expected.configPath &&
          m.Destination === "/run/us-s3.json" &&
          m.RW === false) ||
        (m.Type === "tmpfs" && m.Destination === "/data" && m.RW === true),
    );
  try {
    check(valid, "attestation_failed");
  } catch (error) {
    // Diagnostic replay only: the acceptance expression and all-must-pass
    // decision above stay unchanged. Never attach actual/expected values.
    const fields = [
      ["container_id_format", () => /^[a-f0-9]{64}$/.test(input.id)],
      ["container_id", () => item?.Id === input.id],
      ["configured_image", () => item.Config?.Image === IMAGE],
      ["image_id", () => IMAGE_IDS.includes(item.Image)],
      ["owner_label", () => item.Config.Labels?.["markiro.us-dataset-positive"] === expected.owner],
      ["entrypoint", () => same(item.Config.Entrypoint, ["/usr/bin/weed"])],
      ["command", () => same(item.Config.Cmd, COMMAND)],
      ["user", () => item.Config.User === expected.user],
      ["working_directory", () => item.Config.WorkingDir === "/data"],
      [
        "secret_environment",
        () => !(item.Config.Env ?? []).some((e) => /^(?:MINIO_|AWS_|S3_)/.test(e)),
      ],
      [
        "declared_volumes",
        () => Object.keys(item.Config.Volumes ?? {}).every((path) => path === "/data"),
      ],
      ["log_driver", () => item.HostConfig?.LogConfig?.Type === "none"],
      ["privileged", () => item.HostConfig.Privileged === false],
      ["publish_all_ports", () => item.HostConfig.PublishAllPorts === false],
      ["network", () => ["default", "bridge"].includes(item.HostConfig.NetworkMode)],
      ["capabilities", () => (item.HostConfig.CapAdd ?? []).length === 0],
      ["devices", () => (item.HostConfig.Devices ?? []).length === 0],
      ["binds", () => same(item.HostConfig.Binds ?? [], [])],
      ["tmpfs", () => same(item.HostConfig.Tmpfs, { "/data": expected.tmpfs })],
      [
        "port_bindings",
        () =>
          same(item.HostConfig.PortBindings, {
            "8333/tcp": [{ HostIp: "127.0.0.1", HostPort: "19002" }],
          }),
      ],
      ["configured_mount_count", () => item.HostConfig.Mounts?.length === 1],
      ["configured_mount_type", () => item.HostConfig.Mounts[0].Type === "bind"],
      ["configured_mount_source", () => item.HostConfig.Mounts[0].Source === expected.configPath],
      ["configured_mount_target", () => item.HostConfig.Mounts[0].Target === "/run/us-s3.json"],
      ["configured_mount_read_only", () => item.HostConfig.Mounts[0].ReadOnly === true],
      ["observed_mounts_array", () => Array.isArray(item.Mounts)],
      ["observed_bind_count", () => item.Mounts.filter((m) => m.Type === "bind").length === 1],
      [
        "observed_mounts",
        () =>
          item.Mounts.every(
            (m) =>
              (m.Type === "bind" &&
                m.Source === expected.configPath &&
                m.Destination === "/run/us-s3.json" &&
                m.RW === false) ||
              (m.Type === "tmpfs" && m.Destination === "/data" && m.RW === true),
          ),
      ],
    ];
    error.fields = fields.flatMap(([field, matches]) => {
      try {
        return matches() ? [] : [field];
      } catch {
        // A missing/malformed inspect member is a failed field, not raw output.
        return [field];
      }
    });
    throw error;
  }
}

export function datasetObjectStoreFailureCategory(error) {
  if (
    error?.timedOut ||
    error?.evidence?.timedOut ||
    ["ETIMEDOUT", "ABORT_ERR"].includes(error?.code) ||
    ["AbortError", "TimeoutError"].includes(error?.name)
  )
    return "timeout";
  if (["ENOENT", "ENOTFOUND", "ECONNREFUSED"].includes(error?.code)) return "unavailable";
  if (error?.$metadata?.httpStatusCode === 403) return "access_denied";
  return "provider_failure";
}

/** Real SDK command constructors; doubles may exercise orchestration in units only. */
export async function verifyDatasetObjectStoreCapabilities({
  admin,
  plan,
  request,
  anonymous,
  buckets,
  signal,
}) {
  const sdk = createRequire(new URL("../../../../apps/api/package.json", import.meta.url))(
    "@aws-sdk/client-s3",
  );
  const clients = [plan, request],
    probes = new Map();
  let operation = "permissions_failed",
    failed;
  const send = (client, name, input) => client.send(new sdk[name](input), { abortSignal: signal });
  const put = (client, bucket, key, body, extras = {}) => {
    probes.set(`${bucket}/${key}`, { Bucket: bucket, Key: key });
    return send(client, "PutObjectCommand", { Bucket: bucket, Key: key, Body: body, ...extras });
  };
  const bytes = async (client, bucket, key) => {
    const result = await send(client, "GetObjectCommand", { Bucket: bucket, Key: key });
    check(result.Body && typeof result.Body.transformToByteArray === "function", operation);
    return Buffer.from(await result.Body.transformToByteArray());
  };
  const rejects = async (action, statuses, name) => {
    try {
      const result = await action();
      // An unexpectedly allowed GET still owns a streaming response. Drain it
      // before refusing, so failure cleanup never races a live SDK body.
      if (result?.Body?.transformToByteArray) await result.Body.transformToByteArray();
    } catch (error) {
      check(statuses.includes(error?.$metadata?.httpStatusCode), operation);
      if (name) check(error.name === name, operation);
      return;
    }
    fail(operation);
  };
  try {
    check(Array.isArray(buckets) && buckets.length === 2 && buckets[0] !== buckets[1], operation);
    for (const [i, client] of clients.entries()) {
      const bucket = buckets[i],
        other = buckets[1 - i],
        key = "owned-permission-probe";
      const body = Buffer.from("owned synthetic permission probe");
      await put(client, bucket, key, body);
      check((await bytes(client, bucket, key)).equals(body), operation);
      const listing = await send(client, "ListObjectsV2Command", { Bucket: bucket });
      check(!listing.IsTruncated && listing.Contents?.some((o) => o.Key === key), operation);
      await rejects(() => send(client, "ListObjectsV2Command", { Bucket: other }), [403]);
      await rejects(() => send(client, "GetObjectCommand", { Bucket: other, Key: key }), [403]);
      await rejects(() => put(client, other, "denied-probe", Buffer.alloc(0)), [403]);
      await rejects(() => send(anonymous, "GetObjectCommand", { Bucket: bucket, Key: key }), [403]);
      await rejects(() => put(anonymous, bucket, "denied-anonymous-probe", Buffer.alloc(0)), [403]);
      await rejects(
        () => send(client, "CreateBucketCommand", { Bucket: `${bucket}-denied` }),
        [403],
      );
      await send(client, "DeleteObjectCommand", { Bucket: bucket, Key: key });

      operation = "checksum_failed";
      const checksum = createHash("sha256").update(body).digest("base64");
      await put(client, bucket, "owned-stream-checksum-probe", Readable.from([body]), {
        ContentLength: body.length,
        ChecksumSHA256: checksum,
      });
      check((await bytes(client, bucket, "owned-stream-checksum-probe")).equals(body), operation);
      await rejects(
        () =>
          put(client, bucket, "owned-invalid-checksum-probe", body, {
            ChecksumSHA256: Buffer.alloc(32).toString("base64"),
          }),
        [400],
        "BadDigest",
      );

      operation = "conditional_failed";
      const first = Buffer.from("conditional-first"),
        second = Buffer.from("conditional-second");
      await put(client, bucket, "owned-sequential-probe", first, { IfNoneMatch: "*" });
      await rejects(
        () => put(client, bucket, "owned-sequential-probe", second, { IfNoneMatch: "*" }),
        [412],
      );
      check((await bytes(client, bucket, "owned-sequential-probe")).equals(first), operation);
      const results = await Promise.allSettled(
        [first, second].map((body) =>
          put(client, bucket, "owned-race-probe", body, { IfNoneMatch: "*" }),
        ),
      );
      const winner = results.findIndex((r) => r.status === "fulfilled");
      check(winner >= 0 && results.filter((r) => r.status === "fulfilled").length === 1, operation);
      const loser = results[1 - winner];
      check(
        loser.status === "rejected" && [409, 412].includes(loser.reason?.$metadata?.httpStatusCode),
        operation,
      );
      check(
        (await bytes(client, bucket, "owned-race-probe")).equals([first, second][winner]),
        operation,
      );
      operation = "permissions_failed";
    }
  } catch (error) {
    // No cause/raw SDK error: it may contain a credential, private key or URL.
    failed = new Error(`us_dataset_object_store_${operation}`);
    failed.category = datasetObjectStoreFailureCategory(error);
  }
  // Even a partially acquired probe set is ours; all sends/race work settled first.
  let cleanupFailed = false;
  for (const input of probes.values()) {
    try {
      await send(admin, "DeleteObjectCommand", input);
    } catch {
      cleanupFailed = true;
    }
  }
  for (const bucket of buckets) {
    try {
      const listed = await send(admin, "ListObjectsV2Command", { Bucket: bucket });
      if (listed.IsTruncated || (listed.Contents ?? []).length !== 0) cleanupFailed = true;
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) fail("probe_cleanup_failed");
  if (failed) throw failed;
  return {
    status: "verified",
    buckets: 2,
    sequentialRefusals: 2,
    concurrentWinners: 2,
    crossBucketDenials: 6,
    anonymousDenials: 4,
    globalCreateDenials: 2,
    invalidChecksumRefusals: 2,
  };
}
