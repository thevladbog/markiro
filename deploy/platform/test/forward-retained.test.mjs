import assert from "node:assert/strict";
import test from "node:test";
import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { withForwardPreparationState } from "../host/forward-state.mjs";
const load = () => import("../host/forward-retained.mjs");
import { forwardRetainedFixture as fixture } from "./forward-retained-fixture.mjs";
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

for (const mode of ["rejected", "wrong-identity"]) {
  test(`retained capture authorization ${mode} refuses inspection and publication`, async (t) => {
    const f = await fixture(t),
      { captureForwardRetained } = await load();
    let verified = false;
    await assert.rejects(
      withForwardPreparationState(
        f.root,
        f.input,
        (store) =>
          store.guard((cap) =>
            captureForwardRetained(f.inputCapture, cap, {
              verifyAdmission: async (held) => {
                await held.verify();
                verified = true;
                if (mode === "rejected") throw new Error("synthetic authorization refusal");
                return { ...f.input.identity, operationId: "11111111-1111-4111-8111-111111111111" };
              },
            }),
          ),
        f.options,
      ),
    );
    assert.equal(verified, true);
    assert.deepEqual(f.commands, []);
    await assert.rejects(
      readFile(join(f.root, `forward-retained-${f.input.identity.operationId}.json`)),
      { code: "ENOENT" },
    );
  });
}

test("mixed source capture retains the replaced API image and original edge under genuine authority", async (t) => {
  const { forwardEdgeSuccessorFixture } = await import("./forward-edge-successor-fixture.mjs");
  const f = await forwardEdgeSuccessorFixture(t);
  const { captureForwardRetained, readForwardRetained } = await load();
  const previous = JSON.parse(f.failedEdgeBytes.retainedRuntime);
  const containers = structuredClone(previous.containers),
    images = structuredClone(previous.images);
  const apiImage = f.prior.identity.admission.registry.api;
  containers.api.Id = f.sourceIds.api;
  containers.api.Image = apiImage.imageId;
  containers.api.Config.Image = apiImage.reference;
  images.api = {
    Id: apiImage.imageId,
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [apiImage.reference],
  };
  const requests = [];
  const input = {
    root: f.root,
    admission: f.input,
    postgresImageId: previous.postgresImageId,
    runProcess: async (request) => {
      const [kind, , id] = request.args.slice(2);
      const collection = kind === "container" ? containers : images;
      const row = Object.values(collection).find((value) => value.Id === id);
      assert.ok(row, "capture must inspect exact source container and image IDs");
      requests.push([kind, id]);
      return { stdout: Buffer.from(JSON.stringify([row])) };
    },
  };
  await withForwardPreparationState(
    f.root,
    f.input,
    (store) => store.guard((cap) => captureForwardRetained(input, cap)),
    f.options,
  );
  const proof = await readForwardRetained(f.root, f.input);
  assert.equal(proof.record.containers.api.Id, f.sourceIds.api);
  assert.equal(proof.record.images.api.Id, apiImage.imageId);
  assert.equal(proof.record.containers.edge.Id, f.prior.baseline.containers.edge);
  assert.equal(requests.length, 6);
});
