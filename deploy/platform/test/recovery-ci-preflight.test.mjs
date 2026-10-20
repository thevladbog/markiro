import assert from "node:assert/strict";
import test from "node:test";
import * as preflight from "../recovery-ci-preflight.mjs";
const input = () => ({
  argv: ["--local-ci"],
  platform: "linux",
  arch: "x64",
  endpoint: "unix:///var/run/docker.sock",
  executable: "/usr/bin/docker",
  info: { OSType: "linux", Architecture: "x86_64", ID: "test-daemon" },
  containers: [],
  volumes: [],
  networks: ["bridge", "host", "none"],
});
test("recovery harness preflight accepts an empty local Linux Docker host", () => {
  assert.equal(preflight.validateRecoveryCiHost(input()), "test-daemon");
});
for (const [name, change] of [
  [
    "missing explicit invocation",
    (v) => {
      v.argv = [];
    },
  ],
  [
    "remote endpoint",
    (v) => {
      v.endpoint = "tcp://example.invalid:2376";
    },
  ],
  [
    "Podman socket",
    (v) => {
      v.endpoint = "unix:///tmp/podman.sock";
    },
  ],
  [
    "non-Linux host",
    (v) => {
      v.platform = "darwin";
    },
  ],
  [
    "non-amd64 host",
    (v) => {
      v.arch = "arm64";
    },
  ],
  [
    "foreign daemon architecture",
    (v) => {
      v.info.Architecture = "aarch64";
    },
  ],
  [
    "missing daemon identity",
    (v) => {
      v.info.ID = "";
    },
  ],
  [
    "unexpected executable",
    (v) => {
      v.executable = "/tmp/docker";
    },
  ],
  [
    "existing stopped container",
    (v) => {
      v.containers = ["a".repeat(64)];
    },
  ],
  [
    "existing platform volume",
    (v) => {
      v.volumes = ["markiro-platform_postgres-data"];
    },
  ],
  [
    "existing platform network",
    (v) => {
      v.networks.push("markiro-platform_database");
    },
  ],
])
  test(`recovery harness refuses ${name} before resource creation`, () => {
    const value = input();
    change(value);
    assert.throws(() => preflight.validateRecoveryCiHost(value), { code: "ERR_RECOVERY_CI_HOST" });
  });

for (const mode of ["valid", "container", "daemon-changed", "command-failed", "wrong-platform"]) {
  test(`recovery harness reads pinned local daemon before mutation: ${mode}`, async () => {
    const calls = [];
    let infos = 0;
    const runProcess = async (request) => {
      calls.push(request);
      assert.equal(request.executable, "/usr/bin/docker");
      assert.deepEqual(request.args.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
      assert.equal(request.env.DOCKER_CONTEXT, undefined);
      assert.equal(request.env.DOCKER_HOST, undefined);
      assert.equal(request.env.DOCKER_CONFIG, "/tmp/recovery-fixture/docker");
      if (mode === "command-failed") throw new Error("fixture private command output");
      const command = request.args[2];
      if (command === "info") {
        infos++;
        return {
          stdout: JSON.stringify({
            OSType: "linux",
            Architecture: "x86_64",
            ID: mode === "daemon-changed" && infos > 1 ? "other" : "test-daemon",
          }),
        };
      }
      if (command === "container") return { stdout: mode === "container" ? "a".repeat(64) : "" };
      if (command === "volume") return { stdout: "" };
      if (command === "network") return { stdout: "bridge\nhost\nnone\n" };
      throw new Error("Unexpected mutation command");
    };
    const execution = preflight.inspectRecoveryCiHost(
      { root: "/tmp/recovery-fixture", argv: ["--local-ci"] },
      { runProcess, platform: mode === "wrong-platform" ? "darwin" : "linux", arch: "x64" },
    );
    if (mode === "valid") assert.equal(await execution, "test-daemon");
    else await assert.rejects(execution, { code: "ERR_RECOVERY_CI_HOST" });
    if (mode === "wrong-platform") assert.equal(calls.length, 0);
    if (mode === "command-failed") assert.equal(calls.length, 1);
  });
}

test("recovery harness rejects any pre-existing named volume or custom network", () => {
  for (const change of [
    (value) => {
      value.volumes = ["unrelated-data"];
    },
    (value) => {
      value.networks.push("unrelated-network");
    },
    (value) => {
      value.networks = ["bridge", "host"];
    },
  ]) {
    const value = input();
    change(value);
    assert.throws(() => preflight.validateRecoveryCiHost(value), { code: "ERR_RECOVERY_CI_HOST" });
  }
});
