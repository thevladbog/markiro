import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/signer-stable-release.yml", "utf8");

test("is dispatch-only", () => {
  // A release is a deliberate act; nothing about a merge to main should ship one.
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^ {2}(push|pull_request|schedule):/m);
});

test("gates on the repository owner and a typed confirmation", () => {
  assert.match(workflow, /owner_confirmation:/);
  assert.match(workflow, /PUBLISH-SIGNER-STABLE/);
  assert.match(workflow, /RELEASE_OWNER: \$\{\{ github\.repository_owner \}\}/);
  assert.match(workflow, /test "\$RELEASE_ACTOR" = "\$RELEASE_OWNER"/);
});

test("authorizes in a job that holds no permissions and no secrets", () => {
  // The gate must not be able to publish anything even if it is subverted.
  const authorize = workflow.slice(
    workflow.indexOf("  authorize:"),
    workflow.indexOf("  release:"),
  );
  assert.match(authorize, /permissions: \{\}/);
  assert.doesNotMatch(authorize, /environment:/);
  assert.match(workflow, /needs: authorize/);
});

test("draws every credential from the station-release environment", () => {
  assert.match(workflow, /environment: station-release/);
  assert.match(workflow, /secrets\.SIGNER_TAURI_SIGNING_PRIVATE_KEY\b/);
  assert.match(workflow, /secrets\.SIGNER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD\b/);
  assert.match(workflow, /secrets\.YANDEX_STATION_RELEASE_ACCESS_KEY_ID/);
  assert.match(workflow, /secrets\.YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY/);
  assert.match(workflow, /vars\.YANDEX_STATION_RELEASE_BUCKET/);
  // The Station's key must never sign a signer build, and vice versa.
  assert.doesNotMatch(workflow, /secrets\.TAURI_SIGNING_PRIVATE_KEY\b/);
});

test("builds Windows with the stable config overlay", () => {
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /--config src-tauri\/tauri\.stable\.conf\.json/);
  // CI's signer job uses --no-bundle to prove compilation; a release must bundle.
  assert.doesNotMatch(workflow, /--no-bundle/);
});

test("never puts the signing key on a command line", () => {
  assert.match(workflow, /normalize-signing-key\.mjs/);
  assert.match(workflow, /chmod 600/);
  assert.doesNotMatch(workflow, /tauri build[^\n]*\$TAURI_SIGNING_PRIVATE_KEY/);
});

test("writes the mirror before creating the GitHub Release", () => {
  // The updater endpoint reads the mirror. Announcing first would advertise a
  // release clients cannot fetch.
  const mirror = workflow.indexOf("signer-release/publish.mjs");
  const release = workflow.indexOf("gh release create");
  assert.ok(mirror > 0, "the mirror publish step must exist");
  assert.ok(release > 0, "the GitHub Release step must exist");
  assert.ok(mirror < release, "the mirror publish must precede the GitHub Release");
});

test("runs the tooling contract before it builds anything", () => {
  const contract = workflow.indexOf("pnpm test:signer-release:contract");
  const build = workflow.indexOf("tauri build");
  assert.ok(contract > 0 && contract < build);
});
