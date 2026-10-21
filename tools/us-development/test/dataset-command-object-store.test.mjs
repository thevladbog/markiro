import assert from "node:assert/strict";
import test from "node:test";
import {
  datasetObjectStoreConfig,
  datasetObjectStoreContainer,
  assertDatasetObjectStoreContainer,
  verifyDatasetObjectStoreCapabilities,
  datasetObjectStoreFailureCategory,
} from "./support/dataset-command-object-store.mjs";

const image =
  "chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d";
const input = {
  owner: "11111111-2222-4333-8444-555555555555",
  uid: 1001,
  gid: 1001,
  configPath: "/tmp/owned-positive/s3.json",
  buckets: ["dataset-plan-owned", "dataset-package-owned"],
  accounts: ["admin", "plan", "request"].map((name, i) => ({
    name,
    accountId: `account-${name}`,
    accessKeyId: `${i}`.repeat(32),
    secretAccessKey: `${i + 3}`.repeat(64),
  })),
};
function inspected() {
  return {
    Id: "a".repeat(64),
    Image: "sha256:7b5ca1f11aa4c91593612d2d4a9e253ec9152a4bd13a19e551290a042a4c52f5",
    Config: {
      Image: image,
      Labels: { "markiro.us-dataset-positive": input.owner },
      Entrypoint: ["/usr/bin/weed"],
      User: "1001:1001",
      WorkingDir: "/data",
      Cmd: [
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
      ],
    },
    HostConfig: {
      Binds: [],
      Mounts: [
        { Type: "bind", Source: input.configPath, Target: "/run/us-s3.json", ReadOnly: true },
      ],
      Tmpfs: { "/data": "rw,uid=1001,gid=1001,mode=0700" },
      PortBindings: { "8333/tcp": [{ HostIp: "127.0.0.1", HostPort: "19002" }] },
      LogConfig: { Type: "none" },
      Privileged: false,
      PublishAllPorts: false,
      NetworkMode: "default",
    },
    Mounts: [{ Type: "bind", Source: input.configPath, Destination: "/run/us-s3.json", RW: false }],
  };
}

// Independent literal OCI metadata, not produced by the helper under test.
const indexDigest = "sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d";
const platforms = {
  amd64: {
    manifest: "sha256:aba492e2a4e4c90bff795745e8e660affa1f09e7650f5981bd7bccd1a06cd931",
    config: "sha256:7b5ca1f11aa4c91593612d2d4a9e253ec9152a4bd13a19e551290a042a4c52f5",
  },
  arm64: {
    manifest: "sha256:f1f303474940e9e088edbd2c1658f7ac38cb0dd90f91a2b0a51916d74b8575a1",
    config: "sha256:8f17c8c82e037886f6aaceb3f6282a5c2a1b52bbef5339d323b0067a75bbbc79",
  },
};
function imageInspected(architecture = "amd64", index = false) {
  return {
    Id: index ? indexDigest : platforms[architecture].config,
    Os: "linux",
    Architecture: architecture,
    RepoDigests: [`chrislusf/seaweedfs@${indexDigest}`],
    ...(index
      ? {
          Descriptor: { digest: indexDigest, mediaType: "application/vnd.oci.image.index.v1+json" },
        }
      : {}),
  };
}
function selectedManifest(architecture = "amd64") {
  return {
    digest: platforms[architecture].manifest,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    size: 2193,
    platform: { os: "linux", architecture },
  };
}

// These doubles model only external SDK outcomes. The real helper's checks,
// body draining, race orchestration, cleanup and failure return are exercised.
function boundary(fault) {
  const objects = new Map();
  let active = 0,
    maximum = 0,
    raceCalls = 0,
    applicationDeletes = 0,
    pendingBodies = 0;
  const deny = (status) => {
    throw Object.assign(new Error("secret-provider-message"), {
      name: status === 400 ? "BadDigest" : "AccessDenied",
      $metadata: { httpStatusCode: status },
    });
  };
  const unexpectedRead = () => {
    pendingBodies++;
    return {
      Body: {
        async transformToByteArray() {
          pendingBodies--;
          return Buffer.alloc(0);
        },
      },
    };
  };
  const client = (role) => ({
    async send(command) {
      const name = command.constructor.name,
        value = command.input;
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (name === "CreateBucketCommand") return fault === "global-create" ? {} : deny(403);
        if (role === "anonymous")
          return fault === `anonymous-${name}`
            ? name === "GetObjectCommand"
              ? unexpectedRead()
              : {}
            : deny(403);
        const own = input.buckets[role === "plan" ? 0 : 1];
        if (role !== "admin" && value.Bucket !== own)
          return fault === `cross-${name}`
            ? name === "GetObjectCommand"
              ? unexpectedRead()
              : {}
            : deny(403);
        const key = `${value.Bucket}/${value.Key}`;
        if (name === "PutObjectCommand") {
          if (
            value.ChecksumSHA256 &&
            value.ChecksumSHA256 === Buffer.alloc(32).toString("base64")
          ) {
            if (fault === "invalid-checksum") return {};
            if (fault === "wrong-checksum-error")
              throw Object.assign(new Error("secret-provider-message"), {
                name: "InvalidRequest",
                $metadata: { httpStatusCode: 400 },
              });
            return deny(400);
          }
          const bytes = Buffer.isBuffer(value.Body)
            ? value.Body
            : Buffer.concat(await Array.fromAsync(value.Body));
          if (value.IfNoneMatch && objects.has(key) && fault !== "overwrite") return deny(412);
          if (value.IfNoneMatch && value.Key.includes("race")) {
            raceCalls++;
            await new Promise((resolve) => setImmediate(resolve));
            if (objects.has(key) && fault !== "two-winners") return deny(412);
          }
          objects.set(key, fault === "corrupt-bytes" ? Buffer.from("wrong") : bytes);
          return { $metadata: { httpStatusCode: 200 } };
        }
        if (name === "GetObjectCommand") {
          const bytes = objects.get(key) ?? Buffer.alloc(0);
          return {
            Body: {
              async transformToByteArray() {
                return bytes;
              },
            },
          };
        }
        if (name === "DeleteObjectCommand") {
          if (role !== "admin") applicationDeletes++;
          if (fault !== "cleanup") objects.delete(key);
          return {};
        }
        if (name === "ListObjectsV2Command")
          return {
            IsTruncated: false,
            Contents: [...objects.keys()]
              .filter((k) => k.startsWith(`${value.Bucket}/`))
              .map((k) => ({ Key: k.slice(value.Bucket.length + 1) })),
          };
        throw Error("unexpected-sdk-command");
      } finally {
        active--;
      }
    },
  });
  return {
    options: {
      admin: client("admin"),
      plan: client("plan"),
      request: client("request"),
      anonymous: client("anonymous"),
      buckets: input.buckets,
    },
    objects,
    state: () => ({ active, maximum, raceCalls, applicationDeletes, pendingBodies }),
  };
}

test(
  "object store builds distinct scoped identities and refuses unsafe uid/config contracts",
  { timeout: 5000 },
  () => {
    const config = datasetObjectStoreConfig(input);
    assert.deepEqual(
      config.identities.map((i) => i.actions),
      [
        ["Admin"],
        ["Read:dataset-plan-owned", "Write:dataset-plan-owned", "List:dataset-plan-owned"],
        ["Read:dataset-package-owned", "Write:dataset-package-owned", "List:dataset-package-owned"],
      ],
    );
    assert.equal(new Set(config.identities.map((i) => i.account.id)).size, 3);
    assert.equal(
      new Set(config.identities.flatMap((i) => i.credentials.map((c) => c.accessKey))).size,
      3,
    );
    for (const bad of [
      { uid: 0 },
      { uid: -1 },
      { gid: undefined },
      { configPath: "relative.json" },
      { buckets: [input.buckets[0], input.buckets[0]] },
      { accounts: [input.accounts[0], input.accounts[0], input.accounts[2]] },
      {
        accounts: [
          input.accounts[0],
          { ...input.accounts[1], name: "anonymous" },
          input.accounts[2],
        ],
      },
    ])
      assert.throws(() => datasetObjectStoreConfig({ ...input, ...bad }));
    const container = datasetObjectStoreContainer(input);
    assert.equal(container.image, image);
    assert.ok(container.args.includes("/usr/bin/weed"));
    assert.ok(container.args.includes("1001:1001"));
    assert.ok(container.args.includes("/data"));
    assert.ok(!JSON.stringify(container).includes(input.accounts[0].secretAccessKey));
  },
);

test(
  "object store attestation refuses unknown identity, mutable image, exposed ports and unowned mounts",
  { timeout: 5000 },
  () => {
    const target = { ...input, id: "a".repeat(64), imageInspection: imageInspected() };
    assert.doesNotThrow(() => assertDatasetObjectStoreContainer(inspected(), target));
    const identityFailures = [];
    const verifyIdentity = (candidate, imageInspection, accepted) => {
      try {
        if (accepted)
          assert.doesNotThrow(() =>
            assertDatasetObjectStoreContainer(candidate, { ...target, imageInspection }),
          );
        else
          assert.throws(
            () => assertDatasetObjectStoreContainer(candidate, { ...target, imageInspection }),
            (error) => {
              assert.equal(error.message, "us_dataset_object_store_attestation_failed");
              assert.deepEqual(error.fields, ["image_id"]);
              assert.doesNotMatch(
                JSON.stringify(error) + error.stack,
                /hostile-image-secret|unexpected-private-reference/,
              );
              return true;
            },
          );
      } catch (error) {
        identityFailures.push(error);
      }
    };
    for (const architecture of ["amd64", "arm64"]) {
      const classic = inspected();
      classic.Image = platforms[architecture].config;
      verifyIdentity(classic, imageInspected(architecture), true);
      const indexed = inspected();
      indexed.Image = indexDigest;
      indexed.ImageManifestDescriptor = selectedManifest(architecture);
      verifyIdentity(indexed, imageInspected(architecture, true), true);
    }
    const indexed = inspected();
    indexed.Image = indexDigest;
    indexed.ImageManifestDescriptor = selectedManifest();
    for (const mutate of [
      (c, i) => {
        c.Image = i.Id = `sha256:${"b".repeat(64)}`;
      },
      (c) => {
        c.Image = platforms.amd64.config;
      },
      (_c, i) => {
        i.RepoDigests = [];
      },
      (_c, i) => {
        i.RepoDigests = [`unexpected-private-reference@${indexDigest}`];
      },
      (_c, i) => {
        i.Descriptor.digest = `sha256:${"b".repeat(64)}`;
      },
      (_c, i) => {
        i.Descriptor.mediaType = "application/vnd.oci.image.manifest.v1+json";
      },
      (_c, i) => {
        delete i.Descriptor;
      },
      (_c, i) => {
        i.Architecture = "ppc64le";
      },
      (_c, i) => {
        i.Os = "windows";
      },
      (c) => {
        delete c.ImageManifestDescriptor;
      },
      (c) => {
        c.ImageManifestDescriptor = selectedManifest("arm64");
      },
      (c) => {
        c.ImageManifestDescriptor.digest = `sha256:${"b".repeat(64)}`;
      },
      (c) => {
        c.ImageManifestDescriptor.mediaType = "application/vnd.oci.image.index.v1+json";
      },
      (c) => {
        c.ImageManifestDescriptor.size = 2194;
      },
      (c) => {
        c.ImageManifestDescriptor.platform.os = "windows";
      },
      (c) => {
        c.ImageManifestDescriptor.platform.architecture = "arm64";
      },
      (c, i) => {
        c.Image = i.Id = platforms.amd64.manifest;
      },
      (_c, i) => {
        i.Id = "hostile-image-secret";
        i.RepoDigests = ["unexpected-private-reference"];
      },
    ]) {
      const c = structuredClone(indexed),
        i = imageInspected("amd64", true);
      mutate(c, i);
      verifyIdentity(c, i, false);
    }
    for (const mutate of [
      (_c, i) => {
        i.Id = platforms.arm64.config;
      },
      (_c, i) => {
        i.Architecture = "arm64";
      },
      (_c, i) => {
        i.RepoDigests = ["chrislusf/seaweedfs:4.48"];
      },
      (_c, i) => {
        i.RepoDigests = [`chrislusf/seaweedfs@sha256:${"b".repeat(64)}`];
      },
      (_c, i) => {
        i.Descriptor = { digest: "hostile-image-secret" };
      },
      (c) => {
        c.ImageManifestDescriptor = selectedManifest("arm64");
      },
    ]) {
      const c = inspected(),
        i = imageInspected();
      mutate(c, i);
      verifyIdentity(c, i, false);
    }
    verifyIdentity(inspected(), undefined, false);
    if (identityFailures.length)
      throw new AggregateError(identityFailures, "pinned image provenance not enforced");
    const diagnosticFailures = [];
    const refusesWithFields = (candidate, fields) => {
      try {
        assert.throws(
          () => assertDatasetObjectStoreContainer(candidate, target),
          (error) => {
            assert.equal(error.message, "us_dataset_object_store_attestation_failed");
            assert.deepEqual(error.fields, fields);
            assert.deepEqual(Object.keys(error), ["fields"]);
            assert.doesNotMatch(
              JSON.stringify(error) + error.stack,
              /hostile-secret-value|private-config-path|AWS_SECRET_ACCESS_KEY/,
            );
            return true;
          },
        );
      } catch (error) {
        diagnosticFailures.push(error);
      }
    };
    const wrongImage = inspected();
    wrongImage.Image = `sha256:${"b".repeat(64)}`;
    refusesWithFields(wrongImage, ["image_id"]);
    const multiple = inspected();
    multiple.Id = "c".repeat(64);
    multiple.Config.User = "0:0";
    multiple.Config.WorkingDir = "/";
    refusesWithFields(multiple, ["container_id", "user", "working_directory"]);
    const hostile = inspected();
    hostile.Config.Env = ["AWS_SECRET_ACCESS_KEY=hostile-secret-value"];
    hostile.HostConfig.Mounts[0].Source = "/private-config-path/hostile-secret-value";
    hostile.Mounts[0].Source = "/private-config-path/hostile-secret-value";
    refusesWithFields(hostile, [
      "secret_environment",
      "configured_mount_source",
      "observed_mounts",
    ]);
    if (diagnosticFailures.length)
      throw new AggregateError(diagnosticFailures, "attestation field diagnostics incomplete");
    for (const mutate of [
      (c) => {
        c.Id = "c".repeat(64);
      },
      (c) => {
        c.Config.Image = "chrislusf/seaweedfs:latest";
      },
      (c) => {
        c.Image = `sha256:${"b".repeat(64)}`;
      },
      (c) => {
        c.Config.Labels["markiro.us-dataset-positive"] = "unknown";
      },
      (c) => {
        c.Config.Entrypoint = ["/entrypoint.sh"];
      },
      (c) => {
        c.Config.User = "0:0";
      },
      (c) => {
        c.Config.WorkingDir = "/";
      },
      (c) => {
        c.Config.Cmd.push("-admin.ui=true");
      },
      (c) => {
        c.HostConfig.Tmpfs["/data"] = "rw";
      },
      (c) => {
        c.HostConfig.PortBindings["9333/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "19003" }];
      },
      (c) => {
        c.HostConfig.PortBindings["8333/tcp"][0].HostIp = "0.0.0.0";
      },
      (c) => {
        c.HostConfig.Mounts[0].Source = "/unknown/config";
      },
      (c) => {
        c.Mounts[0].RW = true;
      },
      (c) => {
        c.Mounts.push({ Type: "volume", Destination: "/data", Source: "production" });
      },
      (c) => {
        c.HostConfig.LogConfig.Type = "json-file";
      },
      (c) => {
        c.HostConfig.Privileged = true;
      },
      (c) => {
        c.HostConfig.PublishAllPorts = true;
      },
    ]) {
      const c = inspected();
      mutate(c);
      assert.throws(() => assertDatasetObjectStoreContainer(c, target));
    }
  },
);

test(
  "object store capability failures prevent initialization including false checksum, conditional and permission success",
  { timeout: 5000 },
  async () => {
    const good = boundary();
    const evidence = await verifyDatasetObjectStoreCapabilities(good.options);
    assert.equal(evidence.status, "verified");
    assert.equal(good.objects.size, 0);
    assert.equal(good.state().active, 0);
    assert.equal(good.state().raceCalls, 4);
    assert.equal(good.state().applicationDeletes, 2);
    assert.ok(good.state().maximum >= 2);
    for (const fault of [
      "global-create",
      "anonymous-GetObjectCommand",
      "anonymous-PutObjectCommand",
      "cross-ListObjectsV2Command",
      "cross-GetObjectCommand",
      "cross-PutObjectCommand",
      "invalid-checksum",
      "wrong-checksum-error",
      "overwrite",
      "two-winners",
      "corrupt-bytes",
      "cleanup",
    ]) {
      const bad = boundary(fault);
      let initialized = false;
      await assert.rejects(async () => {
        await verifyDatasetObjectStoreCapabilities(bad.options);
        initialized = true;
      });
      assert.equal(initialized, false, fault);
      assert.equal(bad.state().active, 0, fault);
      assert.equal(bad.state().pendingBodies, 0, fault);
    }
  },
);

test(
  "object store failures expose fixed categories only and settle probe cleanup after partial acquisition",
  { timeout: 5000 },
  async () => {
    for (const [error, expected] of [
      [Object.assign(new Error("secret-config-key"), { code: "ENOENT" }), "unavailable"],
      [Object.assign(new Error("secret-token"), { code: "ETIMEDOUT" }), "timeout"],
      [
        Object.assign(new Error("secret-S3-key"), { $metadata: { httpStatusCode: 403 } }),
        "access_denied",
      ],
      [new Error("secret-provider-output"), "provider_failure"],
    ])
      assert.equal(datasetObjectStoreFailureCategory(error), expected);
    const bad = boundary("invalid-checksum");
    await assert.rejects(verifyDatasetObjectStoreCapabilities(bad.options), (error) => {
      assert.match(error.message, /^us_dataset_object_store_[a-z_]+$/);
      assert.doesNotMatch(
        JSON.stringify(error) + error.stack,
        /secret-provider-message|dataset-plan-owned|permission-probe/,
      );
      return true;
    });
    assert.equal(bad.objects.size, 0);
    assert.equal(bad.state().active, 0);
  },
);
