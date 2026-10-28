import assert from "node:assert/strict";
import test from "node:test";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { forwardEdgeCommandFixture as fixture } from "./forward-edge-successor-fixture.mjs";
import { loadUpgradeOperation } from "../host/upgrade-command.mjs";

test("edge successor loader authenticates all five historical source cohorts without a child process", async (t) => {
  const f = await fixture(t),
    loaded = await loadUpgradeOperation(f.directory, f.options);
  assert.equal(loaded.record.operation.admission.kind, "platform-forward-edge-successor");
  assert.equal(f.commands.length, 0);
  await loaded.verifySources();
  assert.equal(f.commands.length, 0);
});
for (const issue of [
  "missing parent source",
  "parent source bytes",
  "new source bytes",
  "source inspection",
  "callback",
])
  test(`edge successor loader rejects ${issue} before process`, async (t) => {
    const f = await fixture(t);
    if (issue === "missing parent source") delete f.record.historicalSources.priorEdgeReceiptSha256;
    if (issue === "parent source bytes")
      await appendFile(
        join(
          dirname(f.root),
          "upgrade-bootstrap",
          f.prior.identity.executorSha,
          "deploy/platform/host/probe-worker.mjs",
        ),
        "\n// changed\n",
      );
    if (issue === "new source bytes")
      await appendFile(
        join(f.record.installedRoot, "deploy/platform/host/forward-edge-successor-admission.mjs"),
        "\n// changed\n",
      );
    if (issue === "source inspection")
      await appendFile(
        join(f.root, `forward-edge-source-${f.prior.identity.operationId}.json`),
        " ",
      );
    if (issue === "callback") f.record.operation.adapters = { migrate: "unsafe" };
    await f.publish();
    await assert.rejects(loadUpgradeOperation(f.directory, f.options));
    assert.equal(f.commands.length, 0);
  });
