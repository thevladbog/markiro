import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
export async function operationFixture(t) {
  const { preparedFixture } = await import("./prepared-target-fixture.mjs");
  const { readFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { HOST_BUNDLE_FILES } = await import("../host/command.mjs");
  const { digest } = await import("../backup/schemas.mjs");
  const f = await preparedFixture(t);
  const installed = join(f.root, "installed");
  await mkdir(installed, { mode: 0o700 });
  const files = {};
  for (const path of HOST_BUNDLE_FILES) {
    const source = await readFile(new URL(`../../../${path}`, import.meta.url));
    await mkdir(dirname(join(installed, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(installed, path), source, {
      mode: path === "deploy/platform/postgres/pg_hba.conf" ? 0o644 : 0o600,
    });
    files[path] = digest(source);
  }
  f.identity.target = {
    hostId: "a".repeat(32),
    databaseId: "123456789",
    volumeId: "markiro-platform_postgres-data",
  };
  f.record.target = f.identity.target;
  f.document.target = f.identity.target;
  f.evidence.target = f.identity.target;
  f.document.provenance = "live-source";
  f.evidence.provenance = "live-source";
  f.record.provenance = "live-source";
  f.document.runtime.architecture = "amd64";
  f.evidence.runtime.architecture = "amd64";
  for (const pair of [f.document.fence, f.evidence.fence])
    for (const v of Object.values(pair)) v.target = f.identity.target;
  await f.publish();
  const preparedPolicy = Object.fromEntries(
    [
      "backup",
      "restoreEvidence",
      "roleMapping",
      "postgres",
      "tls",
      "rolePolicySha256",
      "provenance",
      "maxAgeMs",
      "producers",
    ].map((k) => [k, f.expected[k]]),
  );
  preparedPolicy.provenance = "live-source";
  const record = {
    version: 1,
    kind: "platform-host-operation",
    installedRoot: installed,
    deployment: {
      root: f.root,
      identity: f.identity,
      configuration: f.expected.configuration,
      dockerConfig: join(f.root, "docker"),
      preparedTarget: f.record,
      preparedPolicy,
    },
    observationPolicy: {
      machineId: "a".repeat(32),
      dockerId: "fixture-daemon",
      postgresImageId: `sha256:${"f".repeat(64)}`,
      volume: {
        name: "markiro-platform_postgres-data",
        createdAt: "2026-10-18T00:00:00Z",
        mountpoint: "/var/lib/docker/volumes/markiro-platform_postgres-data/_data",
      },
      networks: {
        default: { name: "markiro-platform_default", id: "1".repeat(64) },
        database: { name: "markiro-platform_database", id: "2".repeat(64) },
      },
    },
  };
  const receipt = {
    version: 1,
    kind: "platform-installed-executor",
    executorSha: f.identity.executorSha,
    ci: { runId: "123", runAttempt: "1" },
    files,
  };
  await writeFile(join(f.root, "installed-executor.json"), JSON.stringify(receipt), {
    mode: 0o600,
  });
  const publish = () =>
    writeFile(join(f.root, "operation.json"), JSON.stringify(record), { mode: 0o600 });
  await publish();
  return { ...f, record, installed, receipt, publish, publishBackup: f.publish };
}
