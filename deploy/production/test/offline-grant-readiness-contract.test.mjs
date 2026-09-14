import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("production API image includes readiness persistence before readers", async () => {
  await access(new URL("packages/db/migrations/0151_offline_grant_readiness.sql", root));
  const activationMigration = await read(
    "packages/db/migrations/0152_offline_grant_activation.sql",
  );
  const dockerfile = await read("deploy/production/api.Dockerfile");

  assert.match(
    dockerfile,
    /COPY --from=build --chown=node:node \/workspace\/packages\/db\/migrations \/app\/node_modules\/@markiro\/db\/migrations/,
  );
  assert.doesNotMatch(
    activationMigration,
    /INSERT\s+INTO\s+"?(?:offline_grant_activation|entitlement_lifecycle_policies)/i,
  );
});

test("production sources register both native readiness routes", async () => {
  const [station, kiosk] = await Promise.all([
    read("apps/api/src/modules/device-grants/device-grants.controller.ts"),
    read("apps/api/src/modules/device-grants/kiosk-grants.controller.ts"),
  ]);

  for (const [source, base] of [
    [station, "station/grants/v1"],
    [kiosk, "kiosk/grants/v1"],
  ]) {
    assert.match(source, new RegExp(`@Controller\\("${base}"\\)`));
    assert.match(source, /@Post\("readiness"\)[\s\S]{0,180}@AllowSubscriptionReadOnly\("read"\)/);
    assert.match(source, /grantClientReadinessRequestSchema/);
    assert.match(source, /grantClientReadinessResponseSchema/);
  }
});

test("production sources expose read and preview without a readiness activation route", async () => {
  const source = await read(
    "apps/api/src/modules/device-grants/platform-grant-readiness.controller.ts",
  );

  assert.match(source, /@Controller\("platform\/offline-grants"\)/);
  assert.match(source, /@Get\("readiness"\)/);
  assert.match(source, /@Post\("readiness\/preview"\)/);
  assert.match(source, /@RequirePlatformCapabilities\("tenants\.read", "catalog\.read"\)/);
  assert.match(
    source,
    /@RequirePlatformCapabilities\("tenants\.read", "catalog\.read", "catalog\.write"\)/,
  );
  assert.doesNotMatch(
    source,
    /@(?:Post|Patch|Put)\("readiness\/(?:confirm|activate|cohort|policy)/,
  );
});

test("API startup validates offline grant signing as one configuration", async () => {
  const source = await read("apps/api/src/env.ts");

  for (const name of [
    "OFFLINE_GRANT_ORIGIN",
    "OFFLINE_GRANT_KID",
    "OFFLINE_GRANT_PRIVATE_KEY_PEM",
    "OFFLINE_GRANT_KEYSET_JSON",
  ]) {
    assert.match(source, new RegExp(`${name}: z\\.string\\(\\)\\.optional\\(\\)`));
  }
  assert.match(source, /\.superRefine\(\(env, ctx\) => \{[\s\S]*configureGrantSigning\(env\)/);
  assert.match(source, /Invalid offline grant signing configuration/);
});
