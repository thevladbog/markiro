import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { upgradeObservationFixture } from "./upgrade-observation-fixture.mjs";
import { preparedFixture } from "./prepared-target-fixture.mjs";
import { dockerFixture } from "./host-observe-fixture.mjs";
import { upgradeHash } from "./upgrade-fixture.mjs";
export async function upgradeCommandFixture(t, options = {}) {
  const { UPGRADE_BUNDLE_FILES } = await import("../host/upgrade-command.mjs");
  const base = options.production
    ? await (
        await import("./production-activation-fixture.mjs")
      ).productionFixture(t, { nested: true })
    : await preparedFixture(t, { nested: true });
  const f = await upgradeObservationFixture(t, {
    daemonFixture: await dockerFixture(t, { fixture: base }),
    ...(options.production ? { candidateOperationId: base.identity.operationId } : {}),
  });
  f.candidateOperation.configuration.runtimeSnapshot.interpolation = {
    ...base.expected.configuration.runtimeSnapshot.interpolation,
    MARKIRO_PLATFORM_ENV_FILE: f.candidateOperation.configuration.runtimeSnapshot.path,
  };
  f.input.expiresAt = new Date(Date.now() + 1800000).toISOString();
  const installed = join(dirname(f.root), "upgrade-bootstrap", f.input.identity.executorSha);
  const directory = join(
    dirname(f.root),
    "upgrade-operations",
    f.input.identity.operationId,
    "prepare",
  );
  await mkdir(installed, { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const record = {
    version: 1,
    kind: "platform-upgrade-host-operation",
    phase: "prepare",
    installedRoot: installed,
    dispatch: f.input.dispatch,
    authorization: {
      actorId: "11",
      actorLogin: "publisher",
      reviewerId: "12",
      reviewerLogin: "reviewer",
      environmentId: "44",
    },
    observationPolicy: f.policy,
    operation: {
      root: f.root,
      admission: f.input,
      configuration: f.candidateOperation.configuration,
      dockerConfig: join(f.root, "docker"),
      predecessorContainers: f.predecessorContainers,
      connectionFile: join(f.root, "connection.json"),
      roleMapping: { version: 1, roles: [], allowedDeltas: [] },
    },
  };
  const receipt = {
    version: 1,
    kind: "platform-upgrade-installed-executor",
    executorSha: f.input.identity.executorSha,
    operationId: f.input.identity.operationId,
    ci: f.input.executorCi,
    installationDispatch: f.input.dispatch,
    files: {},
  };
  for (const path of UPGRADE_BUNDLE_FILES) {
    const bytes = await readFile(new URL(`../../../${path}`, import.meta.url));
    await mkdir(dirname(join(installed, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(installed, path), bytes, {
      mode: path.endsWith("pg_hba.conf") ? 0o644 : 0o600,
    });
    receipt.files[path] = upgradeHash(bytes);
  }
  const runtime = (executorSha) => ({
    version: 1,
    executorSha,
    dockerExecutable: "/usr/bin/docker",
    endpoint: "unix:///var/run/docker.sock",
    image: `sha256:${"e".repeat(64)}`,
    provenance: "live-source",
  });
  for (const [path, executor] of [
    ["backup-runtime.json", f.records.original.current.identity.executorSha],
    [
      `recovery-backup-runtime-${f.input.predecessor.identity.operationId}.json`,
      f.input.predecessor.identity.executorSha,
    ],
    [`upgrade-backup-runtime-${f.input.identity.operationId}.json`, f.input.identity.executorSha],
  ])
    await writeFile(join(f.root, path), JSON.stringify(runtime(executor)), { mode: 0o600 });
  await writeFile(record.operation.connectionFile, "{}", { mode: 0o600 });
  const publish = async () => {
    await writeFile(join(directory, "operation.json"), JSON.stringify(record), { mode: 0o600 });
    await writeFile(
      join(f.root, `upgrade-installed-executor-${f.input.identity.operationId}.json`),
      JSON.stringify(receipt),
      { mode: 0o600 },
    );
  };
  await publish();
  return {
    ...f,
    base,
    installed,
    directory,
    record,
    receipt,
    publish,
    options: { hostRoot: dirname(f.root), ambient: {} },
  };
}
