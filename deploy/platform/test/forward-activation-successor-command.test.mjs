import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { forwardActivationSuccessorFixture } from "./forward-activation-successor-fixture.mjs";
import { forwardRuntimeDescriptor } from "./forward-backup-fixture.mjs";
import { UPGRADE_BUNDLE_FILES, loadUpgradeOperation } from "../host/upgrade-command.mjs";
import { digest } from "../backup/schemas.mjs";
async function fixture(t) {
  const f = await forwardActivationSuccessorFixture(t),
    id = f.input.identity.operationId,
    sha = f.input.identity.executorSha;
  const record = JSON.parse(f.failedActivationBytes.prepareOperation);
  record.installedRoot = join(dirname(f.root), "upgrade-bootstrap", sha);
  record.dispatch = f.input.dispatch;
  record.operation.admission = f.input;
  record.historicalSources.priorActivationReceiptSha256 =
    f.input.priorActivation.hashes.installedExecutor;
  const directory = join(dirname(f.root), "upgrade-operations", id, "post-migration-prepare");
  const receipt = {
    version: 1,
    kind: "platform-upgrade-installed-executor",
    operationId: id,
    executorSha: sha,
    ci: f.input.executorCi,
    installationDispatch: f.input.dispatch,
    files: {},
  };
  for (const path of UPGRADE_BUNDLE_FILES) {
    const b = await readFile(new URL(`../../../${path}`, import.meta.url));
    const dest = join(record.installedRoot, path);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await writeFile(dest, b, { mode: path.endsWith("pg_hba.conf") ? 0o644 : 0o600 });
    receipt.files[path] = digest(b);
  }
  await f.put(join(directory, "github-token"), Buffer.from("SYNTHETIC-PRIVATE-JOB-TOKEN"));
  const publish = async () => {
    await f.put(join(directory, "operation.json"), record);
    await f.put(join(f.root, `upgrade-installed-executor-${id}.json`), receipt);
  };
  await publish();
  await f.put(join(f.root, `forward-backup-runtime-${id}.json`), forwardRuntimeDescriptor(sha));
  return { ...f, newRecord: record, newDirectory: directory, publishNew: publish };
}
test("activation successor loader authenticates all four historical closures before any process", async (t) => {
  const f = await fixture(t),
    loaded = await loadUpgradeOperation(f.newDirectory, f.options);
  assert.equal(loaded.record.operation.admission.kind, "platform-forward-activation-successor");
  assert.equal(f.commands.length, 0);
  await loaded.verifySources();
  await appendFile(
    join(
      dirname(f.root),
      "upgrade-bootstrap",
      f.prior.identity.executorSha,
      "deploy/platform/host/probe-worker.mjs",
    ),
    "\n// changed\n",
  );
  await assert.rejects(loaded.verifySources());
  assert.equal(f.commands.length, 0);
});
for (const fault of [
  "missing-activation-receipt",
  "wrong-activation-receipt",
  "older-forward-source",
  "activation-runtime",
  "foreign-owner",
])
  test(`activation successor loader denies ${fault} before process`, async (t) => {
    const f = await fixture(t);
    if (fault === "missing-activation-receipt")
      delete f.newRecord.historicalSources.priorActivationReceiptSha256;
    if (fault === "wrong-activation-receipt")
      f.newRecord.historicalSources.priorActivationReceiptSha256 = "2".repeat(64);
    if (fault === "older-forward-source")
      await appendFile(join(f.installed, "deploy/platform/host/command.mjs"), "\n// changed\n");
    if (fault === "activation-runtime")
      await f.put(
        join(f.root, `forward-backup-runtime-${f.prior.identity.operationId}.json`),
        forwardRuntimeDescriptor("2".repeat(40)),
      );
    if (fault === "foreign-owner")
      await f.put(join(f.root, "upgrade-index.json"), {
        version: 1,
        kind: "platform-forward-recovery-index",
        operationId: "749b251c-5c80-49aa-84b6-df842fa8fd30",
      });
    await f.publishNew();
    await assert.rejects(loadUpgradeOperation(f.newDirectory, f.options));
    assert.equal(f.commands.length, 0);
  });
