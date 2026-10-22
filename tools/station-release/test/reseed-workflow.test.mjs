import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { load } from "js-yaml";

const root = new URL("../../../", import.meta.url);
const execFile = promisify(execFileCallback);
const source = () =>
  readFile(new URL(".github/workflows/station-release-reseed.yml", root), "utf8");

function step(job, name) {
  const found = job.steps.find((candidate) => candidate.name === name);
  assert.ok(found, name);
  return found;
}

async function authorize({ actor = "thevladbog", confirmation, betaTag = "", stableTag = "" }) {
  const workflow = load(await source());
  const script = workflow.jobs.authorize.steps[0].run;
  // A native temp path through env, as the stable workflow tests do: Git Bash
  // on the Windows runner maps a POSIX /tmp elsewhere than Node does.
  const runnerTemp = await mkdtemp(join(tmpdir(), "markiro-reseed-authorize-"));
  const outputFile = join(runnerTemp, "github-output");
  try {
    await execFile("bash", ["-c", script], {
      env: {
        ...process.env,
        GITHUB_REF: "refs/heads/main",
        GITHUB_OUTPUT: outputFile,
        OWNER_CONFIRMATION: confirmation ?? "RESEED-STATION-RELEASES",
        RELEASE_ACTOR: actor,
        RELEASE_OWNER: "thevladbog",
        BETA_TAG: betaTag,
        STABLE_TAG: stableTag,
      },
    });
    const output = await readFile(outputFile, "utf8");
    return JSON.parse(output.trim().replace(/^channels=/u, ""));
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
}

test("reseed is an owner-only main dispatch with an exact confirmation", async () => {
  const workflow = load(await source());
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "owner_confirmation",
    "beta_tag",
    "stable_tag",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["authorize", "reseed"]);
  assert.equal(workflow.jobs.authorize.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(workflow.jobs.authorize.permissions, {});
  assert.equal(workflow.jobs.reseed.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.jobs.reseed.needs, "authorize");

  assert.deepEqual(
    await authorize({ betaTag: "station-v2.4.0-beta.5", stableTag: "station-v2.3.0" }),
    [
      { channel: "beta", tag: "station-v2.4.0-beta.5" },
      { channel: "stable", tag: "station-v2.3.0" },
    ],
  );
  assert.deepEqual(await authorize({ stableTag: "station-v2.3.0" }), [
    { channel: "stable", tag: "station-v2.3.0" },
  ]);
  for (const rejected of [
    { actor: "someone-else", betaTag: "station-v2.4.0-beta.5" },
    { confirmation: "PUBLISH-STATION-BETA", betaTag: "station-v2.4.0-beta.5" },
    {},
    { betaTag: "station-v2.3.0" },
    { stableTag: "station-v2.4.0-beta.5" },
    { stableTag: 'station-v2.3.0","channel":"beta' },
    { betaTag: "station-v2.4.0-beta.5\nstable" },
  ]) {
    await assert.rejects(authorize(rejected), undefined, JSON.stringify(rejected));
  }
});

test("reseed writes only in the protected release environment and per-channel release lock", async () => {
  const workflow = load(await source());
  const job = workflow.jobs.reseed;
  assert.equal(job.environment, "station-release");
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.deepEqual(job.concurrency, {
    group: "station-${{ matrix.channel }}-release",
    "cancel-in-progress": false,
  });
  assert.deepEqual(job.strategy, {
    "fail-fast": false,
    matrix: { include: "${{ fromJSON(needs.authorize.outputs.channels) }}" },
  });
  assert.equal(job.env.STATION_RELEASE_REPOSITORY, "thevladbog/markiro-station-releases");
  assert.equal(job.env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(job.env.AWS_SECRET_ACCESS_KEY, undefined);

  // The groups are the ones the release workflows hold.
  for (const [file, group] of [
    ["station-beta-release.yml", "station-beta-release"],
    ["station-stable-release.yml", "station-stable-release"],
  ]) {
    const release = load(await readFile(new URL(`.github/workflows/${file}`, root), "utf8"));
    assert.equal(release.concurrency.group, group, file);
  }

  const withCredentials = job.steps.filter((candidate) =>
    JSON.stringify(candidate.env ?? {}).includes("RELEASES_S3_ACCESS_KEY_ID"),
  );
  assert.deepEqual(
    withCredentials.map((candidate) => candidate.name),
    ["Reseed releases.markiro.app from the GitHub tree"],
  );
  const reseed = withCredentials[0];
  assert.deepEqual(reseed.env, {
    AWS_ACCESS_KEY_ID: "${{ secrets.RELEASES_S3_ACCESS_KEY_ID }}",
    AWS_SECRET_ACCESS_KEY: "${{ secrets.RELEASES_S3_SECRET_ACCESS_KEY }}",
    RELEASES_S3_BUCKET: "${{ vars.RELEASES_S3_BUCKET }}",
    RELEASES_S3_ENDPOINT: "${{ vars.RELEASES_S3_ENDPOINT }}",
  });
  assert.match(reseed.run, /set \+x/u);
  assert.match(reseed.run, /::add-mask::\$AWS_ACCESS_KEY_ID/u);
  assert.match(reseed.run, /::add-mask::\$AWS_SECRET_ACCESS_KEY/u);
  assert.match(reseed.run, /trap cleanup_credentials EXIT/u);
  assert.match(
    reseed.run,
    /node tools\/station-release\/yandex-publisher\.mjs reseed-from-github \\\n\s+"\$work\/github" "\$RESEED_TAG" "\$work\/release\.json" \\\n\s+"\$work\/github-channel-latest\.json" "\$CHANNEL" "\$work\/reseed-record\.json" \\\n\s+--confirm-reseed-from-github/u,
  );
});

test("reseed takes its only input from the public GitHub mirror and reads the bucket back", async () => {
  const text = await source();
  const job = load(text).jobs.reseed;
  const names = job.steps.map((candidate) => candidate.name);
  const order = [
    "Verify main provenance",
    "Download the accepted GitHub release",
    "Reseed releases.markiro.app from the GitHub tree",
    "Read the channel back through releases.markiro.app",
    "Record the reseed",
  ].map((name) => names.indexOf(name));
  assert.ok(
    order.every((index, position) => index > (order[position - 1] ?? -1)),
    names.join(),
  );

  const download = step(job, "Download the accepted GitHub release");
  assert.deepEqual(download.env, { GH_TOKEN: "${{ github.token }}" });
  assert.match(
    download.run,
    /gh release view "\$tag" --repo "\$STATION_RELEASE_REPOSITORY" \\\n\s+--json tagName,isDraft,isPrerelease,targetCommitish/u,
  );
  assert.match(
    download.run,
    /env -u GH_TOKEN -u GITHUB_TOKEN node tools\/station-release\/github-public\.mjs \\\n\s+download-channel "\$CHANNEL"/u,
  );
  assert.match(
    download.run,
    /env -u GH_TOKEN -u GITHUB_TOKEN node tools\/station-release\/github-public\.mjs \\\n\s+download-release "\$CHANNEL" "\$version" "\$work\/github"/u,
  );
  assert.match(download.run, /validate-origin github "\$CHANNEL"/u);
  assert.match(download.run, /test "\$\(git rev-parse "\$tag\^\{commit\}"\)" = "\$release_sha"/u);

  const readBack = step(job, "Read the channel back through releases.markiro.app");
  assert.match(
    readBack.run,
    /https:\/\/releases\.markiro\.app\/station\/\$CHANNEL\/releases\/\$version/u,
  );
  assert.match(readBack.run, /--max-redirs 0/u);
  assert.match(readBack.run, /validate-origin yandex "\$CHANNEL"/u);
  assert.match(
    readBack.run,
    /compare-origins \\\n\s+"\$work\/github" "\$public" "\$CHANNEL" "\$version"/u,
  );
  assert.match(readBack.run, /https:\/\/releases\.markiro\.app\/station\/beta\/download/u);
  assert.match(readBack.run, /https:\/\/releases\.markiro\.app\/station\/download"/u);
  assert.match(readBack.run, /cmp "\$work\/channel-latest\.json" "\$public\/latest\.json"/u);

  // Nothing here creates, edits or deletes GitHub releases, and nothing reaches
  // the bucket except the publisher.
  assert.doesNotMatch(text, /gh release (?:create|edit|upload|delete)/u);
  assert.doesNotMatch(text, /seed-baseline|promote|rollback|backup-mutables/u);
  assert.doesNotMatch(text, /s3\.twcstorage\.ru|aws s3|YANDEX_STATION_RELEASE/u);
  assert.doesNotMatch(text, /STATION_RELEASE_REPOSITORY_TOKEN|STATION_SOURCE_REPOSITORY_TOKEN/u);
  for (const uses of text.matchAll(/uses: ([^\s]+)/gu)) {
    assert.match(uses[1], /@[0-9a-f]{40}$/u, uses[1]);
  }
});
