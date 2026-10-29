import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { createUsHostedAdminConfig } from "../../../apps/admin/vite.us-hosted.config.ts";
import { createUsAdminConfig } from "../../../apps/admin/vite.us.config.ts";
import { createUsEntryBoundary } from "../../../apps/admin/vite.us-entry-boundary.ts";

test("hosted static admits only explicit US production build", () => {
  const env = { VITE_DEPLOYMENT_EDITION: "US" };
  const config = createUsHostedAdminConfig(env, "production", "build", false);
  assert.equal(config.envDir, false);
  assert.deepEqual(config.envPrefix, []);
  assert.equal(config.publicDir, false);
  assert.equal(config.server, undefined);
  assert.equal(config.preview, undefined);
  assert.equal(config.build.manifest, true);
  assert.equal(config.build.sourcemap, false);
  assert.ok(config.root.endsWith("/apps/admin/us-hosted"));
  assert.ok(config.build.outDir.endsWith("/apps/admin/dist-us"));
  for (const [raw, mode, command, preview] of [
    [{}, "production", "build", false],
    [{ VITE_DEPLOYMENT_EDITION: "RU" }, "production", "build", false],
    [{ ...env, MARKIRO_DEPLOYMENT_EDITION: "RU" }, "production", "build", false],
    [env, "development", "build", false],
    [env, "test", "build", false],
    [env, "production", "serve", false],
    [env, "production", "build", true],
  ]) {
    assert.throws(
      () => createUsHostedAdminConfig(raw, mode, command, preview),
      /us_hosted_static_build_refused/,
    );
  }
  assert.throws(() => createUsAdminConfig(env, "production"));
});
test("shared source boundary rejects RU and permits US/assets", () => {
  const plugin = createUsEntryBoundary();
  const source = new URL("../../../apps/admin/src/", import.meta.url).pathname;
  const context = {
    error(message) {
      throw new Error(message);
    },
  };
  for (const id of [source + "us/main.tsx", source + "assets/font.woff2"])
    assert.doesNotThrow(() => plugin.transform.call(context, "", id));
  assert.throws(
    () => plugin.transform.call(context, "", source + "main.tsx"),
    /US entry cannot import RU/,
  );
});
const oldImport =
  'import { defineConfig, type Plugin, type UserConfig, type ViteDevServer } from "vite";';
const newImport =
  'import { defineConfig, type UserConfig, type ViteDevServer } from "vite";\nimport { createUsEntryBoundary } from "./vite.us-entry-boundary.ts";';
const block =
  '  const adminSource = fileURLToPath(new URL("./src/", import.meta.url));\n  const entryBoundary = {\n    name: "us-entry-boundary",\n    enforce: "pre",\n    transform(_source: string, id: string) {\n      if (\n        id.startsWith(adminSource) &&\n        !id.startsWith(`${adminSource}us/`) &&\n        !id.startsWith(`${adminSource}assets/`)\n      ) {\n        this.error("US entry cannot import RU application code");\n      }\n    },\n  } satisfies Plugin;\n';
const helper =
  'import { fileURLToPath } from "node:url";\nimport type { Plugin } from "vite";\n\nexport function createUsEntryBoundary(): Plugin {\n  const adminSource = fileURLToPath(new URL("./src/", import.meta.url));\n  const entryBoundary = {\n    name: "us-entry-boundary",\n    enforce: "pre",\n    transform(_source: string, id: string) {\n      if (\n        id.startsWith(adminSource) &&\n        !id.startsWith(`${adminSource}us/`) &&\n        !id.startsWith(`${adminSource}assets/`)\n      ) {\n        this.error("US entry cannot import RU application code");\n      }\n    },\n  } satisfies Plugin;\n  return entryBoundary;\n}\n';
const originalSha = "8039d5e2cc95bd773f3be2eee629c24f97792325ea973394827b2771ce8c491b";
test("local config and original boundary restore exact bytes", () => {
  const local = readFileSync("apps/admin/vite.us.config.ts", "utf8");
  assert.equal(local.split(newImport).length, 2);
  const call = "  const entryBoundary = createUsEntryBoundary();\n";
  assert.equal(local.split(call).length, 2);
  const restored = local.replace(newImport, oldImport).replace(call, block);
  assert.equal(createHash("sha256").update(restored).digest("hex"), originalSha);
  assert.equal(readFileSync("apps/admin/vite.us-entry-boundary.ts", "utf8"), helper);
});
