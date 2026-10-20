import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { backupProof } from "./host-fixtures.mjs";
import { operationFixture } from "./host-command-fixture.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
export async function recoveryDeliveryFixture(t, existing) {
  const api = await import("../host/recovery-command.mjs");
  const f = existing ?? (await operationFixture(t));
  for (const path of api.RECOVERY_BUNDLE_FILES) {
    const bytes = await readFile(new URL(`../../../${path}`, import.meta.url));
    await mkdir(dirname(join(f.installed, path)), { recursive: true, mode: 0o700 });
    const destination = join(f.installed, path);
    const priorBytes = await readFile(destination).catch(() => null);
    if (!priorBytes?.equals(bytes))
      await writeFile(destination, bytes, { mode: path.endsWith("pg_hba.conf") ? 0o644 : 0o600 });
    f.receipt.files[path] = hash(bytes);
  }
  const prior = structuredClone(f.identity);
  prior.operationId = randomUUID();
  const state = Buffer.from(
    JSON.stringify({
      version: 1,
      sequence: 14,
      previousHealthy: null,
      current: {
        identity: prior,
        phase: "api-started",
        status: "recovery-required",
        backup: backupProof(prior),
      },
    }),
  );
  await writeFile(join(f.root, "state.json"), state, { mode: 0o600 });
  const dispatch = { toolingSha: "a".repeat(40), runId: "1234", runAttempt: "1" };
  const admission = {
    version: 1,
    kind: "platform-failed-activation-recovery",
    identity: f.identity,
    predecessor: { identity: prior, sequence: 14, stateSha256: hash(state) },
    executorCi: f.receipt.ci,
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
  };
  const record = {
    version: 1,
    kind: "platform-recovery-host-operation",
    phase: "prepare",
    installedRoot: f.installed,
    dispatch,
    observationPolicy: f.record.observationPolicy,
    operation: {
      root: f.root,
      admission,
      configuration: f.record.deployment.configuration,
      dockerConfig: join(f.root, "docker"),
      connectionFile: join(f.root, "connection.json"),
      roleMapping: f.record.deployment.preparedPolicy.roleMapping,
    },
  };
  const receipt = {
    version: 1,
    kind: "platform-recovery-installed-executor",
    executorSha: f.identity.executorSha,
    operationId: f.identity.operationId,
    ci: f.receipt.ci,
    installationDispatch: dispatch,
    files: f.receipt.files,
  };
  const directoryFor = () =>
    join(f.root, "recovery-operations", f.identity.operationId, record.phase);
  const publish = async () => {
    await mkdir(directoryFor(), { recursive: true, mode: 0o700 });
    const token = await readFile(join(f.root, "github-token")).catch(() => null);
    if (token) await writeFile(join(directoryFor(), "github-token"), token, { mode: 0o600 });
    await writeFile(
      join(f.root, `recovery-installed-executor-${f.identity.operationId}.json`),
      JSON.stringify(receipt),
      { mode: 0o600 },
    );
    await writeFile(join(directoryFor(), "operation.json"), JSON.stringify(record), {
      mode: 0o600,
    });
  };
  if (!existing) await writeFile(join(f.root, "connection.json"), "{}", { mode: 0o600 });
  await publish();
  return {
    ...f,
    api,
    record,
    receipt,
    publish,
    get directory() {
      return directoryFor();
    },
    options: { root: f.root, installedRoot: f.installed, ambient: {} },
  };
}
