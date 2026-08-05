import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifyContainerRuntime } from "../container-runtime.mjs";

test("compose validation uses an existing synthetic service environment", async () => {
  const contract = await readFile(new URL("../compose-contract.env", import.meta.url), "utf8");
  assert.match(contract, /^MARKIRO_ENV_FILE=\/etc\/markiro\/compose-contract\.env$/m);
  assert.doesNotMatch(contract, /production\.env/);
});

test("runtime contract verifies exact Engine and Compose v2 versions and renders production compose", async () => {
  const calls = [];
  await verifyContainerRuntime({
    engineVersion: "28.5.2",
    composeVersion: "2.40.3",
    run: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === "version") return "28.5.2\n";
      if (args[0] === "compose" && args[1] === "version") return "2.40.3\n";
      return "";
    },
  });

  assert.deepEqual(calls, [
    ["docker", ["version", "--format", "{{.Server.Version}}"]],
    ["docker", ["compose", "version", "--short"]],
    [
      "docker",
      [
        "compose",
        "--env-file",
        "/etc/markiro/compose-contract.env",
        "-f",
        "/opt/markiro/compose.production.yml",
        "config",
        "--quiet",
      ],
    ],
  ]);
});

test("runtime contract fails closed on version drift before rendering compose", async () => {
  await assert.rejects(
    verifyContainerRuntime({
      engineVersion: "28.5.2",
      composeVersion: "2.40.3",
      run: async (_command, args) => (args[0] === "version" ? "29.0.0\n" : "2.40.3\n"),
    }),
    /container runtime contract failed/,
  );
});
