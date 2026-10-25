import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  commandIntegrationFixture,
  integrationOptions,
} from "./host-command-integration-fixture.mjs";
import { dockerFixture } from "./host-observe-fixture.mjs";
import { forwardObservationFixture } from "./forward-observation-fixture.mjs";
import { provisionForwardRuntimes } from "./forward-backup-fixture.mjs";
import { UPGRADE_BUNDLE_FILES } from "../host/upgrade-command.mjs";
import { digest } from "../backup/schemas.mjs";
import { productFiles } from "./forward-product-fixture.mjs";
function tar() {
  const chunks = [];
  for (const file of productFiles()) {
    const h = Buffer.alloc(512);
    h.write(`migrations/${file.path}`, 0, 100);
    h.write("0000600\0", 100, 8);
    h.write(`${file.bytes.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    h.fill(32, 148, 156);
    h.write("0", 156, 1);
    h.write("ustar\0", 257, 6);
    h.write(
      `${h
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, "0")}\0 `,
      148,
      8,
    );
    chunks.push(h, file.bytes, Buffer.alloc((512 - (file.bytes.length % 512)) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
export async function forwardCommandFixture(t) {
  const base = await commandIntegrationFixture(t, null, { nested: true });
  const external = await integrationOptions(base.root);
  const f = await forwardObservationFixture(t, {
    suppliedDaemon: await dockerFixture(t, { fixture: base }),
  });
  f.input.expiresAt = new Date(Date.now() + 1800000).toISOString();
  f.candidateOperation.configuration.runtimeSnapshot.interpolation = {
    ...base.expected.configuration.runtimeSnapshot.interpolation,
    MARKIRO_PLATFORM_ENV_FILE: f.candidateOperation.configuration.runtimeSnapshot.path,
  };
  await provisionForwardRuntimes(f);
  const installed = join(dirname(f.root), "upgrade-bootstrap", f.input.identity.executorSha);
  const directory = join(
    dirname(f.root),
    "upgrade-operations",
    f.input.identity.operationId,
    "post-migration-prepare",
  );
  const put = async (path, bytes, mode = 0o600) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode });
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const historicalSources = {};
  for (const [kind, id, key] of [
    ["recovery", f.input.originalPredecessor.identity, "recoveryReceiptSha256"],
    ["upgrade", f.input.failed.identity, "failedReceiptSha256"],
  ]) {
    const bytes = Buffer.from(`historical-${id.executorSha}`);
    const path = join(
      dirname(f.root),
      `${kind}-bootstrap`,
      id.executorSha,
      "deploy/platform/old.mjs",
    );
    await put(path, bytes);
    const receipt = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: `platform-${kind}-installed-executor`,
        operationId: id.operationId,
        executorSha: id.executorSha,
        ci:
          kind === "recovery"
            ? f.u.records.acceptedRecovery.activation.admission.executorCi
            : f.u.input.executorCi,
        installationDispatch:
          kind === "upgrade"
            ? f.u.input.dispatch
            : { toolingSha: id.executorSha, runId: "1", runAttempt: "1" },
        files: { "deploy/platform/old.mjs": digest(bytes) },
      }),
    );
    await put(join(f.root, `${kind}-installed-executor-${id.operationId}.json`), receipt);
    historicalSources[key] = digest(receipt);
  }
  const record = {
    version: 1,
    kind: "platform-forward-recovery-host-operation",
    phase: "post-migration-prepare",
    installedRoot: installed,
    dispatch: f.input.dispatch,
    authorization: {
      actorId: "11",
      actorLogin: "publisher",
      reviewerId: "12",
      reviewerLogin: "reviewer",
      environmentId: "44",
    },
    historicalSources,
    observationPolicy: f.policy,
    operation: {
      root: f.root,
      dockerConfig: join(f.root, "docker"),
      admission: f.input,
      configuration: f.candidateOperation.configuration,
      predecessorContainers: f.input.baseline.containers,
      connectionFile: join(f.root, "connection.json"),
      roleMapping: { version: 1, roles: [], allowedDeltas: [] },
    },
  };
  await put(record.operation.connectionFile, Buffer.from("{}"));
  await put(join(directory, "github-token"), Buffer.from("synthetic-job-token"));
  const receipt = {
    version: 1,
    kind: "platform-upgrade-installed-executor",
    operationId: f.input.identity.operationId,
    executorSha: f.input.identity.executorSha,
    ci: f.input.executorCi,
    installationDispatch: f.input.dispatch,
    files: {},
  };
  for (const path of UPGRADE_BUNDLE_FILES) {
    const bytes = await readFile(new URL(`../../../${path}`, import.meta.url));
    await put(join(installed, path), bytes, path.endsWith("pg_hba.conf") ? 0o644 : 0o600);
    receipt.files[path] = digest(bytes);
  }
  const publish = async () => {
    await put(join(directory, "operation.json"), Buffer.from(JSON.stringify(record)));
    await put(
      join(f.root, `upgrade-installed-executor-${f.input.identity.operationId}.json`),
      Buffer.from(JSON.stringify(receipt)),
    );
  };
  await publish();
  const commands = [];
  let container,
    removed = false;
  const options = {
    hostRoot: dirname(f.root),
    ambient: {},
    request: async (url, opts) => {
      if (url.includes(`/runs/${f.input.dispatch.runId}`)) {
        const actor = { id: 11, login: "publisher", type: "User" };
        const value = url.endsWith("/approvals")
          ? [
              {
                state: "approved",
                user: { id: 12, login: "reviewer", type: "User" },
                environments: [{ id: 44, name: "production-deploy" }],
              },
            ]
          : {
              id: Number(f.input.dispatch.runId),
              run_attempt: 1,
              head_sha: f.input.identity.executorSha,
              head_branch: "main",
              event: "workflow_dispatch",
              path: ".github/workflows/upgrade-platform.yml",
              repository: { full_name: "thevladbog/markiro" },
              head_repository: { full_name: "thevladbog/markiro" },
              status: "in_progress",
              conclusion: null,
              actor,
              triggering_actor: actor,
            };
        return new Response(JSON.stringify(value));
      }
      const executor = url.includes(`/runs/${f.input.executorCi.runId}`);
      const response = await external.request(
        executor ? url.replace(`/runs/${f.input.executorCi.runId}`, "/runs/124") : url,
        opts,
      );
      if (!executor) return response;
      const value = await response.json();
      if (Array.isArray(value.jobs))
        for (const job of value.jobs) {
          job.run_id = Number(f.input.executorCi.runId);
          job.head_sha = f.input.identity.executorSha;
        }
      if (value.id === 124) {
        value.id = Number(f.input.executorCi.runId);
        value.head_sha = f.input.identity.executorSha;
      }
      return new Response(JSON.stringify(value));
    },
    runProcess: async (request) => {
      commands.push(request);
      if (request.executable === "/usr/bin/python3") return external.runProcess(request);
      const args = request.args.slice(2),
        id = "c".repeat(64),
        selected = f.input.identity.admission.registry.api;
      let stdout;
      if (args[0] === "image")
        stdout = JSON.stringify([
          {
            Id: selected.imageId,
            Os: "linux",
            Architecture: "amd64",
            RepoDigests: [selected.reference],
            Config: { Volumes: null },
          },
        ]);
      else if (args[0] === "create") {
        const name = args[args.indexOf("--name") + 1];
        container = {
          Id: id,
          Name: `/${name}`,
          Image: selected.imageId,
          Config: {
            Image: selected.reference,
            Labels: {
              "io.markiro.operation": f.input.identity.operationId,
              "io.markiro.purpose": "product-migrations",
              "io.markiro.extraction": name,
            },
            Entrypoint: ["/bin/false"],
            Cmd: null,
          },
          HostConfig: {
            NetworkMode: "none",
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            LogConfig: { Type: "none" },
            Privileged: false,
          },
          Mounts: [],
          State: {
            Status: "created",
            Running: false,
            Paused: false,
            Restarting: false,
            StartedAt: "0001-01-01T00:00:00Z",
          },
        };
        stdout = id;
      } else if (args[0] === "cp") stdout = tar();
      else if (args[0] === "container" && args[1] === "inspect")
        stdout = JSON.stringify([container]);
      else if (args[0] === "container" && args[1] === "rm") {
        removed = true;
        stdout = id;
      } else if (args[0] === "container" && args[1] === "ls") stdout = removed ? "" : id;
      else throw new Error("Unexpected fixture process");
      return {
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
        stderr: Buffer.alloc(0),
      };
    },
  };
  return { ...f, base, installed, directory, record, receipt, publish, options, commands };
}
