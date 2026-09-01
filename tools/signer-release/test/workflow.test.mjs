import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";

// Normalised, because this file's guard runs inside the very workflow it
// guards — on a Windows runner, where git checks the YAML out with CRLF and
// every `^`/`\n` anchor below would otherwise miss.
const workflow = (await readFile(".github/workflows/signer-stable-release.yml", "utf8")).replaceAll(
  "\r\n",
  "\n",
);
const parsed = load(workflow);

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

test("offers publish or repair and semantic bump choices", () => {
  const inputs = parsed.on.workflow_dispatch.inputs;
  assert.deepEqual(inputs.mode.options, ["publish", "repair"]);
  assert.equal(inputs.mode.default, "publish");
  assert.deepEqual(inputs.bump.options, ["patch", "minor", "major"]);
  assert.equal(inputs.bump.default, "patch");
});

test("authorizes in a job that holds no permissions and no secrets", () => {
  // The gate must not be able to publish anything even if it is subverted.
  const authorize = workflow.slice(workflow.indexOf("  authorize:"), workflow.indexOf("  state:"));
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
  assert.match(workflow, /secrets\.STATION_RELEASE_REPOSITORY_TOKEN/);
  // The Station's key must never sign a signer build, and vice versa.
  assert.doesNotMatch(workflow, /secrets\.TAURI_SIGNING_PRIVATE_KEY\b/);
});

test("builds Windows with the stable config overlay", () => {
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /--config src-tauri\/tauri\.stable\.conf\.json/);
  assert.match(workflow, /--config "\$VERSION_OVERLAY"/);
  assert.match(workflow, /signer-version-overlay\.json/);
  // CI's signer job uses --no-bundle to prove compilation; a release must bundle.
  assert.doesNotMatch(workflow, /--no-bundle/);
});

test("resolves runner paths only after each job starts", () => {
  for (const [jobName, job] of Object.entries(parsed.jobs)) {
    for (const [variableName, value] of Object.entries(job.env ?? {})) {
      assert.doesNotMatch(
        String(value),
        /\$\{\{\s*runner\./,
        `${jobName}.env.${variableName} cannot access the runner context`,
      );
    }
  }
  assert.match(workflow, /\$RUNNER_TEMP\/signer-version-overlay\.json/);
  assert.match(workflow, /\$RUNNER_TEMP\/signer-release/);
  assert.match(workflow, />> "\$GITHUB_ENV"/);
});

test("never puts the signing key on a command line", () => {
  assert.match(workflow, /normalize-signing-key\.mjs/);
  assert.match(workflow, /chmod 600/);
  assert.doesNotMatch(workflow, /tauri build[^\n]*\$TAURI_SIGNING_PRIVATE_KEY/);
});

test("stages exact assets in a distribution-repository draft before publishing", () => {
  assert.match(workflow, /SIGNER_RELEASE_REPOSITORY: thevladbog\/markiro-station-releases/);
  const draft = workflow.indexOf("gh release create");
  const mirror = workflow.indexOf("signer-release/publish.mjs");
  const release = workflow.indexOf("gh release edit");
  assert.ok(draft > 0, "the draft GitHub Release must exist");
  assert.ok(mirror > 0, "the mirror publish step must exist");
  assert.ok(release > 0, "the draft publication step must exist");
  assert.ok(draft < mirror, "the exact draft assets must exist before mirror publication");
  assert.ok(mirror < release, "mirror verification must precede draft publication");
  assert.match(workflow, /gh release create[^\n]*--draft/);
  assert.match(workflow, /--repo "\$SIGNER_RELEASE_REPOSITORY"/);
  assert.match(workflow, /tools\/signer-release\/prepare\.mjs/);
  assert.match(workflow, /download_url=.*sed -n 3p/);
  assert.match(workflow, /Постоянная ссылка: https:\/\/releases\.markiro\.app\/signer\/download/);
});

test("refuses channel disagreement and repairs from draft bytes without rebuilding", () => {
  assert.match(workflow, /resolveSignerReleaseAction/);
  assert.match(workflow, /https:\/\/releases\.markiro\.app\/signer\/stable\/latest\.json/);
  assert.match(workflow, /if: inputs\.mode == 'publish'/);
  assert.match(workflow, /if: inputs\.mode == 'repair'/);
  assert.match(workflow, /gh release download/);
  assert.match(workflow, /verifyPreparedSignerRelease/);
  assert.doesNotMatch(workflow, /readSignerVersion/);
  assert.doesNotMatch(workflow, /git (commit|push)/);
});

test("looks for the bundle where this crate layout actually puts it", async () => {
  // The Station's src-tauri is a standalone crate, so its bundle lands under
  // src-tauri/target. The signer's is a workspace member, so cargo shares one
  // target dir at the workspace root. Copying the Station's path here builds
  // the installer successfully and then fails to find it.
  const cargo = await readFile("apps/signer/Cargo.toml", "utf8");
  assert.match(cargo, /^\[workspace\]/m, "apps/signer is expected to be a cargo workspace");
  assert.match(workflow, /bundle_dir="apps\/signer\/target\/release\/bundle\/nsis"/);
  assert.doesNotMatch(workflow, /apps\/signer\/src-tauri\/target/);
});

test("runs the tooling contract before it builds anything", () => {
  const contract = workflow.indexOf("pnpm test:signer-release:contract");
  const build = workflow.indexOf("tauri build");
  assert.ok(contract > 0 && contract < build);
});
