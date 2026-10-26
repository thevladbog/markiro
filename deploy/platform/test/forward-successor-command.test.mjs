import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digest } from "../backup/schemas.mjs";
import { UPGRADE_BUNDLE_FILES, loadUpgradeOperation } from "../host/upgrade-command.mjs";
import { forwardSuccessorFixture } from "./forward-successor-fixture.mjs";
import { forwardRuntimeDescriptor } from "./forward-backup-fixture.mjs";
async function fixture(t) {
  const f = await forwardSuccessorFixture(t),
    id = f.input.identity.operationId,
    executor = f.input.identity.executorSha;
  const installed = join(dirname(f.root), "upgrade-bootstrap", executor),
    directory = join(dirname(f.root), "upgrade-operations", id, "post-migration-prepare");
  const record = structuredClone(f.record);
  record.installedRoot = installed;
  record.dispatch = f.input.dispatch;
  record.operation.admission = f.input;
  record.historicalSources.priorForwardReceiptSha256 =
    f.input.priorForward.hashes.installedExecutor;
  const receipt = {
    version: 1,
    kind: "platform-upgrade-installed-executor",
    operationId: id,
    executorSha: executor,
    ci: f.input.executorCi,
    installationDispatch: f.input.dispatch,
    files: {},
  };
  for (const path of UPGRADE_BUNDLE_FILES) {
    const b = await readFile(new URL(`../../../${path}`, import.meta.url)),
      dest = join(installed, path);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await writeFile(dest, b, { mode: path.endsWith("pg_hba.conf") ? 0o644 : 0o600 });
    receipt.files[path] = digest(b);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const publish = async () => {
    await f.put(join(directory, "operation.json"), record);
    await f.put(join(f.root, `upgrade-installed-executor-${id}.json`), receipt);
  };
  await publish();
  await f.put(
    join(f.root, `forward-backup-runtime-${id}.json`),
    forwardRuntimeDescriptor(executor),
  );
  return {
    ...f,
    newRecord: record,
    newReceipt: receipt,
    newDirectory: directory,
    publishNew: publish,
  };
}
test("successor loader verifies all three historical receipts before any process", async (t) => {
  const f = await fixture(t),
    loaded = await loadUpgradeOperation(f.newDirectory, f.options);
  assert.equal(loaded.record.operation.admission.kind, "platform-forward-admission-successor");
  assert.equal(f.commands.length, 0);
  await loaded.verifySources();
  await appendFile(join(f.installed, "deploy/platform/host/command.mjs"), "x");
  await assert.rejects(loaded.verifySources());
});
for (const fault of [
  "missing-prior-receipt",
  "wrong-prior-hash",
  "prior-source",
  "prior-runtime",
  "prior-input",
  "foreign-owner",
])
  test(`successor loader denies ${fault} before process`, async (t) => {
    const f = await fixture(t);
    if (fault === "missing-prior-receipt")
      delete f.newRecord.historicalSources.priorForwardReceiptSha256;
    if (fault === "wrong-prior-hash")
      f.newRecord.historicalSources.priorForwardReceiptSha256 = "2".repeat(64);
    if (fault === "prior-source")
      await appendFile(join(f.installed, "deploy/platform/host/command.mjs"), "\n// changed");
    if (fault === "prior-runtime")
      await f.put(
        join(f.root, `forward-backup-runtime-${f.prior.identity.operationId}.json`),
        forwardRuntimeDescriptor("2".repeat(40)),
      );
    if (fault === "prior-input") await f.put(join(f.directory, "operation.json"), {});
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
