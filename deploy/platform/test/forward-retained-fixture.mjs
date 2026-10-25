import assert from "node:assert/strict";
import { forwardStateFixture } from "./forward-state-fixture.mjs";
export async function forwardRetainedFixture(t, fault) {
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
