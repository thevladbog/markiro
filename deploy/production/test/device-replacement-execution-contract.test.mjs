import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyChangedFiles } from "../../../tools/ci/affected.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("replacement migrations ship in journal order and API image before readers", async () => {
  const journal = JSON.parse(await read("packages/db/migrations/meta/_journal.json"));
  const names = [
    "0162_device_replacement_execution",
    "0163_validate_device_replacement_execution",
    "0164_device_replacement_closure_ack",
    "0165_device_replacement_execution_preview",
    "0166_device_replacement_capabilities",
    "0167_device_replacement_repair_schedule",
  ];
  assert.deepEqual(
    journal.entries.slice(162, 168).map((entry) => entry.tag),
    names,
  );
  for (const name of names) assert.ok((await read(`packages/db/migrations/${name}.sql`)).length);
  assert.match(
    await read("packages/db/src/runtime-migrate.ts"),
    /packaged\.indexOf\("0163_validate_device_replacement_execution"\)/,
  );
  const dockerfile = await read("deploy/production/api.Dockerfile");
  assert.match(
    dockerfile,
    /COPY --from=build --chown=node:node \/workspace\/packages\/db\/migrations \/app\/node_modules\/@markiro\/db\/migrations/,
  );
  assert.match(dockerfile, /--filter @markiro\/api deploy --legacy --prod \/out\/api/);
  assert.match(dockerfile, /COPY --from=build --chown=node:node \/out\/api \/app/);
  const compose = await read("compose.production.yml");
  assert.match(compose, /migrate:[\s\S]*service_completed_successfully/);
});

test("every replacement runtime has a release artifact and owned CI gate", async () => {
  const edge = await read("deploy/production/edge.Dockerfile");
  for (const app of ["admin", "saas-admin"]) {
    assert.ok(edge.includes(`/workspace/apps/${app}/dist /srv/${app}`));
    assert.equal(
      classifyChangedFiles([`apps/${app}/src/replacement.ts`]).jobs.production_bundle,
      true,
    );
  }
  assert.match(
    await read(".github/workflows/release-images.yml"),
    /deploy\/production\/api\.Dockerfile/,
  );
  assert.match(
    await read(".github/workflows/release-images.yml"),
    /deploy\/production\/edge\.Dockerfile/,
  );
  assert.match(await read(".github/workflows/station-beta-release.yml"), /apps\/station/);
  assert.match(await read(".github/workflows/station-stable-release.yml"), /source_beta_tag/);
  assert.match(await read(".github/workflows/handheld-release.yml"), /assembleRelease/);
  for (const [path, jobs] of [
    [
      "apps/api/src/cli/repair-device-replacement.ts",
      ["verify_static", "verify_api_tests", "production_bundle"],
    ],
    [
      "apps/station/src/lib/device-replacement.ts",
      ["verify_app_tests", "station_rust", "station_windows_build"],
    ],
    ["apps/handheld/app/src/main/kotlin/Replacement.kt", ["handheld_android"]],
    [
      "packages/platform-contracts/fixtures/station-recovery/replacement.json",
      ["handheld_android", "verify_api_tests", "verify_app_tests"],
    ],
    [
      "tools/production-browser/device-replacement-tests/replacement.spec.ts",
      ["production_bundle"],
    ],
  ]) {
    const result = classifyChangedFiles([path]);
    for (const job of jobs) assert.equal(result.jobs[job], true, `${path} must run ${job}`);
  }
});

test("production CI runs both replacement browser suites and API registers durable repair", async () => {
  const ci = await read(".github/workflows/ci.yml");
  assert.match(ci, /pnpm --dir tools\/production-browser --ignore-workspace test:tenant-equipment/);
  assert.match(ci, /playwright test --config device-replacement\.playwright\.config\.ts/);
  const config = await read("tools/production-browser/tenant-equipment.playwright.config.ts");
  assert.match(config, /tenant-equipment-tests/);
  const module = await read("apps/api/src/modules/device-licensing/device-licensing.module.ts");
  assert.match(module, /providers:\s*\[[\s\S]*DeviceReplacementExecutionRepairService/);
  const manifest = JSON.parse(await read("apps/api/package.json"));
  assert.equal(
    manifest.scripts["repair:device-replacement"],
    "node dist/cli/repair-device-replacement.js",
  );
});
