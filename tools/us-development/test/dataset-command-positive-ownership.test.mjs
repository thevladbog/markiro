import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
import {
  withoutDatasetCommandPositiveOwner,
  withoutDatasetCommandPositiveOwnerBytes,
} from "./support/dataset-command-positive-owner.mjs";
import {
  assertDatasetPositiveRunner,
  assertDatasetPositiveDatabase,
  assertDatasetPositiveContainer,
} from "./support/dataset-command-positive-fixture.mjs";

const id = "dataset_command_positive";
const text = () => readFileSync(".github/workflows/us-development.yml", "utf8");
const digest = (value) => createHash("sha256").update(value).digest("hex");
// Independent literal expectations, deliberately not imported from the normalizer.
const expected = {
  "runs-on": "ubuntu-latest",
  needs: "isolation",
  "timeout-minutes": 45,
  services: {
    "us-postgres": {
      image: "postgres:17-alpine",
      env: {
        POSTGRES_USER: "markiro_us",
        POSTGRES_PASSWORD: "markiro-us-development-only",
        POSTGRES_DB: "markiro_us_dev",
      },
      ports: ["127.0.0.1:55432:5432"],
      options:
        '--health-cmd "pg_isready -U markiro_us -d markiro_us_dev" --health-interval 5s --health-timeout 5s --health-retries 10',
    },
  },
  steps: [
    {
      uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      with: { "persist-credentials": false },
    },
    { uses: "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1" },
    {
      uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      with: { "node-version": 24, cache: "pnpm" },
    },
    { run: "pnpm install --frozen-lockfile" },
    {
      name: "Build shared contracts for Node tooling checks",
      run: "pnpm turbo build --filter '@markiro/platform-contracts...'",
    },
    {
      name: "Reject release capabilities and merges into main",
      run: "node tools/us-development/check-isolation.mjs",
    },
    { run: "node --test tools/us-development/test/*.test.mjs" },
    {
      name: "Build isolated API dependencies and entry points",
      run: "pnpm turbo build --filter '@markiro/api...'",
    },
    {
      name: "Build checked dataset executable descriptor",
      run: "pnpm --filter @markiro/api build:us-request-worker",
    },
    {
      name: "Verify actual compiled dataset against owned database and private provider",
      env: {
        US_TEST_DATABASE_URL:
          "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
      },
      run: "node --test tools/us-development/test/dataset-command-positive.smoke.mjs",
    },
  ],
};
function owner(workflow, others = []) {
  assert.deepEqual(workflow.jobs[id], expected);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const jobs = [workflow, ...others].flatMap((w) => Object.entries(w.jobs ?? {}));
  assert.equal(jobs.filter(([key]) => key === id).length, 1);
  const selector = /(?<![\w.-])dataset-command-positive\.smoke\.mjs(?![\w/.-])/g;
  assert.equal(
    jobs.flatMap(([, job]) =>
      (job.steps ?? []).flatMap((step) => [...(step.run ?? "").matchAll(selector)]),
    ).length,
    1,
  );
}
test(
  "positive command has exact additive check-only owner and frozen predecessor bytes",
  { timeout: 5000 },
  () => {
    const source = text(),
      workflow = load(source),
      original = structuredClone(workflow);
    owner(workflow);
    const normalized = withoutDatasetCommandPositiveOwner(workflow);
    assert.deepEqual(workflow, original);
    assert.equal(normalized.jobs[id], undefined);
    assert.equal(
      digest(JSON.stringify(normalized)),
      "447410207b2b0e03e421f6b05770d2d71742919f4440ef515ec3a6d15d8656b6",
    );
    const bytes = withoutDatasetCommandPositiveOwnerBytes(source);
    assert.equal(digest(bytes), "d4b61ad79a7e24c168fc85ec8cdf7ab949a17903a7e8c9928b21ec2521b196d5");
    assert.deepEqual(load(bytes), normalized);
    const fixture = readFileSync(
      "tools/us-development/test/support/dataset-command-positive-fixture.mjs",
      "utf8",
    );
    for (const value of [
      "verifyDatasetObjectStoreCapabilities",
      "datasetObjectStoreContainer",
      "port: 19000, upstreamPort: 19002",
      'DROP DATABASE "markiro_us_dev"',
      '"/usr/bin/time"',
      "cap: 900_000",
      "60_000",
    ])
      assert.ok(fixture.includes(value), value);
    assert.ok(!fixture.includes("DROP DATABASE FORCE"));
    assert.ok(fixture.includes('readFile("apps/api/test/support/us-dataset-snapshot.ts"'));
  },
);
test(
  "positive ownership retains malformed jobs, changed selectors/resources/build order/caps",
  { timeout: 5000 },
  () => {
    const mutants = [
      (w) => {
        delete w.jobs[id];
      },
      (w) => {
        w.jobs[id]["timeout-minutes"] = 46;
      },
      (w) => {
        w.jobs[id].needs = [];
      },
      (w) => {
        w.jobs[id].if = "false";
      },
      (w) => {
        w.jobs[id]["continue-on-error"] = true;
      },
      (w) => {
        w.jobs[id].permissions = { contents: "write" };
      },
      (w) => {
        w.jobs[id].services["us-postgres"].image = "postgres:latest";
      },
      (w) => {
        w.jobs[id].services["us-postgres"].ports = ["5432:5432"];
      },
      (w) => {
        w.jobs[id].services.minio = { image: "minio/minio:latest" };
      },
      (w) => {
        w.jobs[id].steps[0].with["persist-credentials"] = true;
      },
      (w) => {
        w.jobs[id].steps[3].run += " --ignore-scripts";
      },
      (w) => {
        w.jobs[id].steps[8].run = "echo fake descriptor";
      },
      (w) => {
        w.jobs[id].steps[9].run += " --test-name-pattern=only";
      },
      (w) => {
        w.jobs[id].steps[9].run += " || true";
      },
      (w) => {
        w.jobs[id].steps[9].if = "false";
      },
      (w) => {
        w.jobs[id].steps[9].env.NODE_OPTIONS = "unsafe";
      },
      (w) => {
        w.jobs[id].steps.reverse();
      },
      (w) => {
        w.jobs.extra = structuredClone(w.jobs[id]);
      },
    ];
    for (const mutate of mutants) {
      const workflow = load(text());
      mutate(workflow);
      assert.throws(() => owner(workflow));
      if (workflow.jobs[id] && !workflow.jobs.extra)
        assert.deepEqual(withoutDatasetCommandPositiveOwner(workflow), workflow);
    }
    const changed = text().replace(
      "  dataset_command_positive:\n",
      "  dataset_command_positive: # mutant\n",
    );
    assert.equal(withoutDatasetCommandPositiveOwnerBytes(changed), changed);
    const identity = [
      { name: "markiro_us_dev", owner: "markiro_us", database_owner: "markiro_us" },
    ];
    assert.doesNotThrow(() => assertDatasetPositiveDatabase(identity, []));
    for (const key of ["name", "owner", "database_owner"])
      assert.throws(() =>
        assertDatasetPositiveDatabase([{ ...identity[0], [key]: "unknown" }], []),
      );
    assert.throws(() =>
      assertDatasetPositiveDatabase(identity, [{ tablename: "existing_business_data" }]),
    );
    const target = {
      id: "a".repeat(64),
      owner: "11111111-2222-4333-8444-555555555555",
      image:
        "chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d",
      uid: 1001,
      gid: 1001,
      configPath: "/tmp/owned-positive/s3.json",
    };
    const container = {
      Id: target.id,
      Image: "sha256:7b5ca1f11aa4c91593612d2d4a9e253ec9152a4bd13a19e551290a042a4c52f5",
      Config: {
        Image: target.image,
        Labels: { "markiro.us-dataset-positive": target.owner },
        Entrypoint: ["/usr/bin/weed"],
        User: "1001:1001",
        WorkingDir: "/data",
        Cmd: [
          "mini",
          "-dir=/data",
          "-s3.port=8333",
          "-s3.config=/run/us-s3.json",
          "-admin.ui=false",
          "-webdav=false",
          "-s3.port.iceberg=0",
          "-s3.port.lance=0",
          "-master.telemetry=false",
          "-s3.autoCreateBucket=false",
        ],
      },
      HostConfig: {
        Binds: [],
        LogConfig: { Type: "none" },
        Mounts: [
          { Type: "bind", Source: target.configPath, Target: "/run/us-s3.json", ReadOnly: true },
        ],
        Tmpfs: { "/data": "rw,uid=1001,gid=1001,mode=0700" },
        PortBindings: { "8333/tcp": [{ HostIp: "127.0.0.1", HostPort: "19002" }] },
        Privileged: false,
        PublishAllPorts: false,
        NetworkMode: "default",
      },
      Mounts: [
        { Type: "bind", Source: target.configPath, Destination: "/run/us-s3.json", RW: false },
      ],
    };
    assert.doesNotThrow(() => assertDatasetPositiveContainer(container, target));
    for (const mutate of [
      (c) => {
        c.Id = "c".repeat(64);
      },
      (c) => {
        c.Config.Image = "chrislusf/seaweedfs:latest";
      },
      (c) => {
        c.Config.Labels["markiro.us-dataset-positive"] = "unknown";
      },
      (c) => {
        c.Config.Cmd = ["mini", "-dir=/external"];
      },
      (c) => {
        c.HostConfig.Binds = ["production:/data"];
      },
      (c) => {
        c.HostConfig.PortBindings["8333/tcp"][0].HostIp = "0.0.0.0";
      },
      (c) => {
        c.HostConfig.LogConfig.Type = "json-file";
      },
    ]) {
      const candidate = structuredClone(container);
      mutate(candidate);
      assert.throws(() => assertDatasetPositiveContainer(candidate, target));
    }
    for (const mutate of [
      (c) => {
        c.HostConfig.Mounts[0].Source = "/unknown/config.json";
      },
      (c) => {
        c.Mounts[0].RW = true;
      },
      (c) => {
        c.Config.User = "0:0";
      },
      (c) => {
        c.Config.Cmd[3] = "-s3.config=/personal/config.json";
      },
    ]) {
      const candidate = structuredClone(container);
      mutate(candidate);
      assert.throws(() => assertDatasetPositiveContainer(candidate, target));
    }
  },
);
test(
  "whole positive smoke selector is globally unique, with all predecessor ownership intact",
  { timeout: 5000 },
  () => {
    const workflow = load(text());
    const others = readdirSync(".github/workflows")
      .filter((f) => /\.ya?ml$/.test(f) && f !== "us-development.yml")
      .map((f) => load(readFileSync(`.github/workflows/${f}`, "utf8")));
    owner(workflow, others);
    assert.throws(() =>
      owner(workflow, [{ jobs: { extra: { steps: [{ run: expected.steps.at(-1).run }] } } }]),
    );
    assert.throws(() => owner(workflow, [{ jobs: { [id]: expected } }]));
    owner(workflow, [
      {
        jobs: {
          extra: { steps: [{ run: "node --test prefix-dataset-command-positive.smoke.mjs" }] },
        },
      },
    ]);
  },
);
test(
  "positive fixture and whole smoke refuse locally before child, socket or database I/O",
  { timeout: 5000 },
  async () => {
    assert.throws(() => assertDatasetPositiveRunner({}), /us_dataset_positive_ci_only/);
    const trusted = {
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_JOB: id,
      RUNNER_ENVIRONMENT: "github-hosted",
      US_TEST_DATABASE_URL: expected.steps.at(-1).env.US_TEST_DATABASE_URL,
    };
    assert.doesNotThrow(() => assertDatasetPositiveRunner(trusted, "linux"));
    assert.throws(() => assertDatasetPositiveRunner(trusted, "darwin"));
    for (const key of Object.keys(trusted))
      assert.throws(() => assertDatasetPositiveRunner({ ...trusted, [key]: "wrong" }, "linux"));
    for (const injection of [{ NODE_OPTIONS: "--require=unsafe" }, { NODE_PATH: "unsafe" }])
      assert.throws(() => assertDatasetPositiveRunner({ ...trusted, ...injection }, "linux"));
    const probe = `import net from 'node:net'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {createDatasetPositiveFixture} from './tools/us-development/test/support/dataset-command-positive-fixture.mjs'; const fail=()=>{throw Error('forbidden_io_opened')}; net.Socket.prototype.connect=fail; net.Server.prototype.listen=fail; cp.spawn=fail; syncBuiltinESMExports(); try {await createDatasetPositiveFixture({}); process.exitCode=2} catch(e){if(e.message!=='us_dataset_positive_ci_only')throw e; console.log(e.message)}`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      timeout: 4000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "us_dataset_positive_ci_only\n");
    // Even forged CI metadata cannot reach acquisition as root. This negative
    // child installs I/O tripwires only; it cannot produce a successful fixture.
    const rootProbe = `import net from 'node:net'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {createDatasetPositiveFixture} from './tools/us-development/test/support/dataset-command-positive-fixture.mjs'; const fail=()=>{throw Error('forbidden_io_opened')}; net.Socket.prototype.connect=fail; net.Server.prototype.listen=fail; cp.spawn=fail; syncBuiltinESMExports(); Object.defineProperty(process,'platform',{value:'linux'}); process.getuid=()=>0; process.getgid=()=>1001; try {await createDatasetPositiveFixture(${JSON.stringify(trusted)}); process.exitCode=2} catch(e){if(e.message!=='us_dataset_object_store_config_failed')throw e; console.log(e.message)}`;
    const rootResult = spawnSync(process.execPath, ["--input-type=module", "-e", rootProbe], {
      encoding: "utf8",
      timeout: 4000,
    });
    assert.equal(rootResult.status, 0, rootResult.stderr);
    assert.equal(rootResult.stdout, "us_dataset_object_store_config_failed\n");
    const smoke = spawnSync(
      process.execPath,
      ["--test", "tools/us-development/test/dataset-command-positive.smoke.mjs"],
      { encoding: "utf8", timeout: 4000, env: { PATH: process.env.PATH } },
    );
    assert.equal(smoke.status, 1);
    assert.equal(smoke.signal, null);
    assert.match(smoke.stdout, /us_dataset_positive_ci_only/);
    assert.doesNotMatch(
      smoke.stdout + smoke.stderr,
      /six_month_seed_stages_verified|forbidden_io_opened/,
    );
  },
);
