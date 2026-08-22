import assert from "node:assert/strict";
import test from "node:test";

import { runPlatformAdminProvisionProbeCli } from "../platform-admin-provision-probe.mjs";

test("provisioning probe resolves the only healthy API container by exact Compose labels", async () => {
  const commands = [];
  let stdout = "";
  let stderr = "";
  const exitCode = await runPlatformAdminProvisionProbeCli({
    environment: {
      MARKIRO_PLATFORM_ADMIN_PROVISION_PROBE: "1",
      PLATFORM_ADMIN_EMAIL: "vladislav.bogatyrev@gmail.com",
    },
    dependencies: {
      run: async (command, args) => {
        commands.push({ command, args });
        if (args[0] === "ps") return { code: 0, stdout: "0123456789ab\n", stderr: "" };
        if (args[0] === "inspect") {
          return {
            code: 0,
            stdout: '{"Status":"running","Health":{"Status":"healthy"}}\n',
            stderr: "",
          };
        }
        if (args[0] === "exec" && args.includes("test")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        return {
          code: 0,
          stdout: '{"userId":"user-123","deliveryId":"delivery-456"}\n',
          stderr: "",
        };
      },
    },
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });

  assert.equal(exitCode, 0);
  assert.equal(
    stdout,
    'MARKIRO_PLATFORM_ADMIN_PROVISIONED {"userId":"user-123","deliveryId":"delivery-456"}\n',
  );
  assert.equal(stderr, "");
  assert.deepEqual(commands[0], {
    command: "docker",
    args: [
      "ps",
      "-a",
      "--filter",
      "label=com.docker.compose.project=markiro-production",
      "--filter",
      "label=com.docker.compose.service=api",
      "--format",
      "{{.ID}}",
    ],
  });
  assert.ok(commands.some(({ args }) => args[0] === "exec" && args[1] === "0123456789ab"));
  assert.equal(
    commands.some(({ args }) => args.includes("markiro-production-api-1")),
    false,
  );
});

test("provisioning probe returns only a closed container stage for missing runtime state", async () => {
  let stdout = "";
  let stderr = "";
  const privateEvidence = "database-password activation-token";
  const exitCode = await runPlatformAdminProvisionProbeCli({
    environment: {
      MARKIRO_PLATFORM_ADMIN_PROVISION_PROBE: "1",
      PLATFORM_ADMIN_EMAIL: "vladislav.bogatyrev@gmail.com",
    },
    dependencies: {
      run: async () => ({ code: 1, stdout: "", stderr: privateEvidence }),
    },
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout, "MARKIRO_PLATFORM_ADMIN_PROVISION_FAILURE container\n");
  assert.equal(stderr, "");
  assert.equal(`${stdout}${stderr}`.includes(privateEvidence), false);
});
