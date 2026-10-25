import assert from "node:assert/strict";
import test from "node:test";
import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { forwardStateFixture } from "./forward-state-fixture.mjs";
import { withForwardPreparationState } from "../host/forward-state.mjs";
const load = () => import("../host/forward-retained.mjs");
async function fixture(t, fault) {
  const f = await forwardStateFixture(t),
    commands = [];
  const images = {
    api: f.input.originalPredecessor.identity.admission.registry.api,
    edge: f.input.originalPredecessor.identity.admission.registry.edge,
    postgres: { imageId: `sha256:${"a".repeat(64)}` },
  };
  const input = {
    root: f.root,
    admission: f.input,
    postgresImageId: images.postgres.imageId,
    runProcess: async (request) => {
      const args = request.args.slice(2);
      commands.push(args);
      const service = Object.keys(images).find(
        (name) =>
          args.at(-1) ===
          (args[0] === "image" ? images[name].imageId : f.input.baseline.containers[name]),
      );
      assert.ok(service);
      const selected = images[service];
      let row =
        args[0] === "image"
          ? {
              Id: selected.imageId,
              Os: "linux",
              Architecture: "amd64",
              RepoDigests: selected.reference ? [selected.reference] : [],
            }
          : {
              Id: f.input.baseline.containers[service],
              Image: selected.imageId,
              Config: { Image: selected.reference, Env: ["SYNTHETIC-PRIVATE-ENV"] },
              State: {
                Running: service === "postgres",
                Paused: false,
                Restarting: false,
                Health: { Status: "healthy" },
              },
            };
      if (fault === "running" && service === "api" && args[0] === "container")
        row.State.Running = true;
      if (fault === "id" && service === "edge") row.Id = "b".repeat(64);
      if (fault === "image" && args[0] === "image") row.Id = `sha256:${"b".repeat(64)}`;
      return { stdout: Buffer.from(JSON.stringify([row])) };
    },
  };
  return { ...f, inputCapture: input, commands };
}
test("retained metadata is captured exclusively under typed pre-start authority and read back before replacement", async (t) => {
  const f = await fixture(t),
    { captureForwardRetained, readForwardRetained } = await load();
  let bytes;
  await withForwardPreparationState(
    f.root,
    f.input,
    async (store) => {
      await store.guard(async (cap) => {
        const proof = await captureForwardRetained(f.inputCapture, cap);
        bytes = proof.bytes;
        assert.equal(proof.record.containers.api.Id, f.input.baseline.containers.api);
        await assert.rejects(captureForwardRetained(f.inputCapture, cap));
      });
    },
    f.options,
  );
  assert.equal(
    f.commands.every((args) => args[1] === "inspect"),
    true,
  );
  assert.ok(bytes.includes(Buffer.from("SYNTHETIC-PRIVATE-ENV")));
  const result = await readForwardRetained(f.root, f.input);
  assert.deepEqual(result.bytes, bytes);
  await appendFile(join(f.root, `forward-retained-${f.input.identity.operationId}.json`), " ");
  const changed = await readForwardRetained(f.root, f.input);
  assert.notDeepEqual(changed.bytes, bytes);
});
for (const fault of ["running", "id", "image"])
  test(`retained capture refuses ${fault} before publishing any metadata`, async (t) => {
    const f = await fixture(t, fault),
      { captureForwardRetained } = await load();
    await assert.rejects(
      withForwardPreparationState(
        f.root,
        f.input,
        (store) => store.guard((cap) => captureForwardRetained(f.inputCapture, cap)),
        f.options,
      ),
    );
    await assert.rejects(
      readFile(join(f.root, `forward-retained-${f.input.identity.operationId}.json`)),
      { code: "ENOENT" },
    );
  });
test("JSON cannot forge retained capture capability", async (t) => {
  const f = await fixture(t),
    { captureForwardRetained } = await load();
  await assert.rejects(captureForwardRetained(f.inputCapture, {}));
  assert.deepEqual(f.commands, []);
});
