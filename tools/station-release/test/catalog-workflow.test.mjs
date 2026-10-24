import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";
for (const name of ["station-beta-release", "station-stable-release", "station-release-reseed"])
  test(`${name} pins tooling and uses protected catalog mutations with retained recovery evidence`, async () => {
    const text = await readFile(
      new URL(`../../../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    );
    const workflow = load(text),
      job = workflow.jobs.release ?? workflow.jobs.reseed;
    assert.equal(job.environment, "station-release");
    assert.equal(job.permissions["id-token"], "write");
    const commands = job.steps.map((s) => s.run ?? "").join("\n");
    assert.match(commands, /pnpm --filter @markiro\/platform-contracts build/);
    assert.doesNotMatch(commands, /git checkout --detach "\$release_sha"/);
    assert.doesNotMatch(commands, /HEAD:refs\/heads\/\$candidate_ref/);
    assert.match(commands, /catalog-cli\.mjs/);
    assert.doesNotMatch(
      commands,
      /yandex-publisher\.mjs|rollback_transaction|gh release delete station-(beta|stable)-channel/,
    );
    assert.doesNotMatch(commands, /https:\/\/s3\.twcstorage\.ru\//);
    assert.match(commands, /catalog-cli\.mjs verify-channel/);
    const receipts = job.steps.find((s) => s.name === "Preserve catalog operation journal");
    assert.equal(receipts.if, "always()");
    assert.match(receipts.with.path, /station-catalog-/);
  });
