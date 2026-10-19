import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
const api = () => import("../backup/worker-recipes.mjs").catch(() => ({}));
test("ICU is an explicit pinned worker route and libc remains the default", async () => {
  const m = await api();
  assert.equal(typeof m.workerRecipe, "function");
  assert.match(m.workerRecipe("libc"), /postgres:17-bookworm/);
  const recipe = m.workerRecipe("icu");
  assert.match(
    recipe,
    /postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24/,
  );
  assert.match(
    recipe,
    /node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd/,
  );
  assert.match(recipe, /USER postgres/);
  assert.match(recipe, /999/);
  assert.doesNotMatch(recipe, /apk|upgrade|cap-add/);
  assert.deepEqual(m.parseWorkerMode(["--local-ci"]), { mode: "libc", args: ["--local-ci"] });
  assert.deepEqual(m.parseWorkerMode(["--local-ci", "--icu"]), {
    mode: "icu",
    args: ["--local-ci"],
  });
  assert.throws(() => m.workerRecipe("unknown"));
  assert.throws(() => m.parseWorkerMode(["--local-ci", "--icu", "--icu"]));
});
test("ICU fixture and CI route retain separate artifact allowlists", async () => {
  const harness = await readFile(new URL("../backup/backup-ci.mjs", import.meta.url), "utf8");
  assert.match(harness, /verifyIcuFixtures/);
  const ci = await readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /--local-ci --icu --export-image/);
  assert.match(ci, /platform-recovery-image-icu\/recovery-image.tar/);
  assert.match(ci, /platform-recovery-image\/recovery-image.tar/);
});
