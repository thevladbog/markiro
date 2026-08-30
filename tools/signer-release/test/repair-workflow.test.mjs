import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { load } from "js-yaml";

const source = await readFile(".github/workflows/signer-download-repair.yml", "utf8");
const workflow = load(source);

test("repair is manual, owner-gated, and serialized with stable releases", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.concurrency.group, "signer-stable-release");
  assert.equal(workflow.jobs.authorize.permissions.constructor, Object);
  assert.equal(Object.keys(workflow.jobs.authorize.permissions).length, 0);
  assert.match(source, /REPAIR-SIGNER-DOWNLOAD/);
  assert.match(source, /test "\$REPAIR_ACTOR" = "\$REPOSITORY_OWNER"/);
});

test("repair writes only after the protected release environment approves it", () => {
  const repair = workflow.jobs.repair;
  assert.equal(repair.needs, "authorize");
  assert.equal(repair.environment, "station-release");
  assert.equal(repair.permissions.contents, "read");
  assert.match(source, /tools\/signer-release\/repair-download\.mjs/);
  assert.match(source, /secrets\.YANDEX_STATION_RELEASE_ACCESS_KEY_ID/);
  assert.match(source, /secrets\.YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(source, /SIGNER_TAURI_SIGNING_PRIVATE_KEY/);
});
