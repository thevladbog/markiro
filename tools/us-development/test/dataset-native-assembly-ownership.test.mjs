import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
import { checkWorkflows } from "../check-isolation.mjs";
import {
  withoutNativeAssemblyOwner,
  withoutNativeAssemblyOwnerBytes,
} from "./support/native-assembly-owner.mjs";

const name = "Verify pure native dataset assembly input";
const file = "test/us-dataset-native-assembly-contract.test.ts";
const command = `corepack pnpm --filter @markiro/api exec vitest run ${file} --maxWorkers=1`;
const block = `      - name: ${name}\n        run: ${command}\n`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hash = (value) => digest(JSON.stringify(value));
const readWorkflows = () =>
  Object.fromEntries(
    readdirSync(".github/workflows")
      .filter((entry) => /\.ya?ml$/.test(entry))
      .map((entry) => [entry, load(readFileSync(`.github/workflows/${entry}`, "utf8"))]),
  );
const builds = [
  [
    "Verify shared domain foundation",
    "pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain build && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint",
  ],
  [
    "Build isolated API dependencies and entry points",
    "pnpm turbo build --filter '@markiro/api...'",
  ],
];

function assertOwnership(all) {
  const workflow = all["us-development.yml"];
  const job = workflow.jobs.isolation;
  const owners = job.steps.filter((step) => step.name === name);
  assert.equal(owners.length, 1, "native assembly has exactly one owner");
  const owner = owners[0];
  const steps = Object.values(all).flatMap((entry) =>
    Object.values(entry.jobs ?? {}).flatMap((entryJob) => entryJob.steps ?? []),
  );
  assert.equal(steps.filter((step) => step.name === name).length, 1, "globally unique named owner");
  const selections = steps.flatMap((step) =>
    Array.from(
      (step.run ?? "").matchAll(
        /(?<![\w.-])us-dataset-native-assembly-contract\.test\.ts(?![\w/.-])/g,
      ),
    ),
  );
  assert.equal(selections.length, 1, "globally unique explicit selector");
  assert.equal(owner.run, command, "exact executable pure serial command");
  for (const [scope, entry] of [
    ["workflow", workflow],
    ["job", job],
    ["owner", owner],
  ]) {
    for (const key of ["if", "continue-on-error", "env", "shell", "defaults"]) {
      assert.equal(entry[key], undefined, `native assembly ${scope} rejects ${key}`);
    }
  }
  assert.deepEqual(Object.keys(owner).sort(), ["name", "run"], "owner is check-only");
  let previous = -1;
  for (const [buildName, run] of builds) {
    const found = job.steps.filter((step) => step.name === buildName);
    assert.equal(found.length, 1, "exactly one build predecessor");
    const build = found[0];
    assert.equal(build.run, run, "build propagates failures");
    for (const key of ["if", "continue-on-error", "shell", "defaults"]) {
      assert.equal(build[key], undefined, `build rejects ${key}`);
    }
    const index = job.steps.indexOf(build);
    assert.ok(index > previous && index < job.steps.indexOf(owner), "ordered successful builds");
    previous = index;
  }
  assert.equal(job.steps.indexOf(owner), previous + 1, "owner immediately follows API build");
  assert.equal(job["timeout-minutes"], 30, "30-minute budget");
  assert.deepEqual(workflow.permissions, { contents: "read" }, "read-only workflow permissions");
  assert.equal(job.permissions, undefined, "no job permission override");
  const predecessor = structuredClone(workflow);
  predecessor.jobs.isolation.steps.splice(job.steps.indexOf(owner), 1);
  assert.equal(
    hash(predecessor.jobs.isolation.steps),
    "0e5b57e9bf40ad3c3272e0002bbe1af88e185f4456e06ed3d9b9c1a30fee09cb",
    "predecessor steps unchanged",
  );
  assert.equal(
    hash(predecessor),
    "2746b4eef637c9ae547c82858a8c9babe5ffd1a98dcec1906ee7e4d887228c6f",
    "complete predecessor unchanged",
  );
  assert.deepEqual(checkWorkflows(all, "codex/us-mvp"), [], "release locks preserved");
}

test("pure native assembly has one unconditional executable CI owner", () => {
  assertOwnership(readWorkflows());
});

test("existing aggregate API execution coexists with the dedicated pure selection", () => {
  const all = readWorkflows();
  const aggregate =
    "pnpm turbo test --filter=@markiro/db --filter=@markiro/api --concurrency=1 --force";
  assert.equal(
    Object.values(all["ci.yml"].jobs).filter((job) =>
      (job.steps ?? []).some((step) => step.run === aggregate),
    ).length,
    1,
    "existing aggregate API owner remains allowed",
  );
  assert.equal(
    JSON.parse(readFileSync("apps/api/package.json", "utf8")).scripts.test,
    "vitest run",
  );
  assertOwnership(all);
  const additionalAggregate = structuredClone(all);
  const job = Object.values(additionalAggregate["ci.yml"].jobs).find((entry) =>
    (entry.steps ?? []).some((step) => step.run === aggregate),
  );
  job.steps.push({ run: aggregate });
  assertOwnership(additionalAggregate);
});

test("explicit filename detection ignores different names with false prefixes or suffixes", () => {
  const parsed = readWorkflows();
  for (const selector of [
    "prefix-us-dataset-native-assembly-contract.test.ts",
    "prefix_us-dataset-native-assembly-contract.test.ts",
    "us-dataset-native-assembly-contract.test.tsx",
    "us-dataset-native-assembly-contract.test.ts.bak",
    "us-dataset-native-assembly-contract.test.ts-suffix",
    "us-dataset-native-assembly-contract.test.ts/child",
  ]) {
    const all = structuredClone(parsed);
    Object.values(all["ci.yml"].jobs)
      .find((job) => job.steps)
      ?.steps.push({ run: `corepack pnpm exec vitest run ${selector}` });
    assertOwnership(all);
  }
});

test("historical normalization preserves malformed native owners and existing owner drift", () => {
  const workflow = readWorkflows()["us-development.yml"];
  const original = structuredClone(workflow);
  const index = workflow.jobs.isolation.steps.findIndex((step) => step.name === name);
  const expected = structuredClone(workflow);
  expected.jobs.isolation.steps.splice(index, 1);
  assert.deepEqual(withoutNativeAssemblyOwner(workflow), expected);
  assert.deepEqual(workflow, original, "normalization does not mutate its input");
  for (const change of [
    { run: `${command} || true` },
    { name: `${name} changed` },
    { env: {} },
    { if: "true" },
    { "continue-on-error": false },
    { defaults: { run: { shell: "bash {0}" } } },
    { permissions: { contents: "write" } },
  ]) {
    const changed = structuredClone(workflow);
    Object.assign(changed.jobs.isolation.steps[index], change);
    assert.deepEqual(
      withoutNativeAssemblyOwner(changed),
      changed,
      "malformed new owner remains visible",
    );
  }
  const changed = structuredClone(workflow);
  const earlier = changed.jobs.isolation.steps.find(
    (step) => step.name === "Verify corrected dataset Cases on disposable databases",
  );
  earlier.run += " || true";
  const normalized = withoutNativeAssemblyOwner(changed);
  assert.equal(
    normalized.jobs.isolation.steps.find((step) => step.name === earlier.name).run,
    earlier.run,
    "existing owner drift survives normalization",
  );
  const source = readFileSync(".github/workflows/us-development.yml", "utf8");
  assert.equal(withoutNativeAssemblyOwnerBytes(source), source.replace(block, ""));
  for (const changedSource of [
    source.replace(command, `${command} || true`),
    source.replace(block, `${block}        env: {}\n`),
    source.replace(block, `${block}        # extra property follows comment\n        if: true\n`),
    source.replace(`      - name: ${name}\n`, `      - name: ${name}\n        if: true\n`),
  ]) {
    assert.equal(
      withoutNativeAssemblyOwnerBytes(changedSource),
      changedSource,
      "malformed raw owner remains visible",
    );
  }
});

test("native assembly rejects fresh parsed workflow mutations at intended assertions", (t) => {
  const mutations = [
    [
      "missing owner",
      ({ j, o }) => j.steps.splice(j.steps.indexOf(o), 1),
      "native assembly has exactly one owner",
    ],
    [
      "duplicate owner",
      ({ j, o }) => j.steps.push(structuredClone(o)),
      "native assembly has exactly one owner",
    ],
    [
      "other workflow owner",
      ({ all, o }) => {
        all.other = { jobs: { check: { steps: [structuredClone(o)] } } };
      },
      "globally unique named owner",
    ],
    [
      "extra selector",
      ({ j }) => j.steps.push({ run: `pnpm exec vitest run ./${file}` }),
      "globally unique explicit selector",
    ],
    [
      "selector in other workflow",
      ({ all }) => {
        all.other = { jobs: { check: { steps: [{ run: `vitest run ${file}` }] } } };
      },
      "globally unique explicit selector",
    ],
    [
      "wrong build order",
      ({ j }) => {
        const a = j.steps.findIndex((s) => s.name === builds[0][0]);
        const b = j.steps.findIndex((s) => s.name === builds[1][0]);
        [j.steps[a], j.steps[b]] = [j.steps[b], j.steps[a]];
      },
      "ordered successful builds",
    ],
    [
      "owner before builds",
      ({ j, o }) => {
        j.steps.splice(j.steps.indexOf(o), 1);
        j.steps.unshift(o);
      },
      "ordered successful builds",
    ],
    [
      "owner not adjacent",
      ({ j, o }) => {
        j.steps.splice(j.steps.indexOf(o), 1);
        j.steps.push(o);
      },
      "owner immediately follows API build",
    ],
    [
      "wrong budget",
      ({ j }) => {
        j["timeout-minutes"] = 31;
      },
      "30-minute budget",
    ],
    [
      "workflow write permission",
      ({ w }) => {
        w.permissions = { contents: "write" };
      },
      "read-only workflow permissions",
    ],
    [
      "job permission override",
      ({ j }) => {
        j.permissions = { contents: "write" };
      },
      "no job permission override",
    ],
    [
      "owner extra setting",
      ({ o }) => {
        o["working-directory"] = "apps/api";
      },
      "owner is check-only",
    ],
    [
      "owner permission override",
      ({ o }) => {
        o.permissions = { contents: "write" };
      },
      "owner is check-only",
    ],
    [
      "owner timeout override",
      ({ o }) => {
        o["timeout-minutes"] = 1;
      },
      "owner is check-only",
    ],
    [
      "workflow timeout drift",
      ({ w }) => {
        w["timeout-minutes"] = 1;
      },
      "complete predecessor unchanged",
    ],
    [
      "changed trigger",
      ({ w }) => {
        w.on.push.branches = ["main"];
      },
      "complete predecessor unchanged",
    ],
    [
      "changed predecessor command",
      ({ j }) => {
        j.steps[0].run = "echo changed";
      },
      "predecessor steps unchanged",
    ],
  ];
  for (const scope of ["foreign", "local"]) {
    for (const selector of [
      "us-dataset-native-assembly-contract.test.ts",
      '"us-dataset-native-assembly-contract.test.ts"',
      "'us-dataset-native-assembly-contract.test.ts'",
      `apps/api/${file}`,
      `./apps/api/${file}`,
      `"apps/api/${file}"`,
      `'./apps/api/${file}'`,
    ]) {
      mutations.push([
        `${scope} explicit filename selector ${selector}`,
        ({ all, j }) => {
          const step = { run: `corepack pnpm exec vitest run ${selector} --maxWorkers=1` };
          if (scope === "local") j.steps.push(step);
          else
            Object.values(all["ci.yml"].jobs)
              .find((job) => job.steps)
              ?.steps.push(step);
        },
        "globally unique explicit selector",
      ]);
    }
  }
  for (const [label, run] of [
    ["echo command", `echo '${command}'`],
    ["conditional command", `if false; then ${command}; fi`],
    ["guarded command", `false && ${command}`],
    ["ignored exit", `${command} || true`],
    ["suppressed output", `${command} >/dev/null 2>&1`],
    ["extra suite", `${command} test/us-dataset-contract.test.ts`],
    ["wrong workers", command.replace("--maxWorkers=1", "--maxWorkers=2")],
    ["database command", `DATABASE_URL=synthetic ${command}`],
  ])
    mutations.push([
      label,
      ({ o }) => {
        o.run = run;
      },
      "exact executable pure serial command",
    ]);
  for (const scope of ["workflow", "job", "owner"]) {
    const get = ({ w, j, o }) => ({ workflow: w, job: j, owner: o })[scope];
    for (const [key, value] of [
      ["if", "false"],
      ["continue-on-error", true],
      ["shell", "bash {0}"],
      ["defaults", { run: { shell: "bash {0}" } }],
    ]) {
      mutations.push([
        `${scope} ${key}`,
        (context) => {
          get(context)[key] = value;
        },
        `native assembly ${scope} rejects ${key}`,
      ]);
    }
    for (const key of ["DATABASE_URL", "US_TEST_DATABASE_URL", "UNRELATED_ENV"]) {
      mutations.push([
        `${scope} ${key}`,
        (context) => {
          get(context).env = { [key]: "synthetic" };
        },
        `native assembly ${scope} rejects env`,
      ]);
    }
  }
  for (const [buildName] of builds) {
    const get = ({ j }) => j.steps.find((step) => step.name === buildName);
    mutations.push([
      `${buildName} missing`,
      ({ j }) => {
        j.steps = j.steps.filter((s) => s.name !== buildName);
      },
      "exactly one build predecessor",
    ]);
    mutations.push([
      `${buildName} duplicate`,
      (context) => context.j.steps.push(structuredClone(get(context))),
      "exactly one build predecessor",
    ]);
    mutations.push([
      `${buildName} command guard`,
      (context) => {
        get(context).run += " || true";
      },
      "build propagates failures",
    ]);
    for (const [key, value] of [
      ["if", "false"],
      ["continue-on-error", true],
      ["shell", "bash {0}"],
      ["defaults", { run: { shell: "bash {0}" } }],
    ]) {
      mutations.push([
        `${buildName} ${key}`,
        (context) => {
          get(context)[key] = value;
        },
        `build rejects ${key}`,
      ]);
    }
  }
  const parsed = readWorkflows();
  assertOwnership(parsed);
  for (const [label, mutate, message] of mutations) {
    const all = structuredClone(parsed);
    const w = all["us-development.yml"];
    const j = w.jobs.isolation;
    const o = j.steps.find((step) => step.name === name);
    mutate({ all, w, j, o });
    assert.throws(
      () => assertOwnership(all),
      (error) => error instanceof assert.AssertionError && error.message.includes(message),
      `${label}: ${message}`,
    );
  }
  t.diagnostic(
    `${mutations.length} fresh parsed mutations rejected with intended AssertionError diagnostics`,
  );
});

test("removing exactly the native owner restores pinned predecessor bytes and AST", () => {
  const source = readFileSync(".github/workflows/us-development.yml", "utf8");
  assert.equal(source.split(block).length, 2, "one exact raw native owner");
  const predecessor = source.replace(block, "");
  assert.equal(Buffer.byteLength(predecessor), 34614, "predecessor byte count");
  const assertBytes = (bytes) =>
    assert.equal(
      digest(bytes),
      "9d4f81c3948017aac8c75a0f0db6e2ccf5fe8f36563e6c417d6923789671dbfc",
      "pinned predecessor bytes",
    );
  assertBytes(predecessor);
  for (const changed of [
    predecessor + "\n",
    predecessor + "# changed\n",
    predecessor.replace("# v4", "# changed comment"),
  ]) {
    assert.deepEqual(load(changed), load(predecessor));
    assert.throws(
      () => assertBytes(changed),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.includes("pinned predecessor bytes"),
    );
  }
  const workflow = load(source);
  workflow.jobs.isolation.steps = workflow.jobs.isolation.steps.filter(
    (step) => step.name !== name,
  );
  assert.equal(workflow.jobs.isolation.steps.length, 80);
  assert.deepEqual(workflow, load(predecessor));
  assert.equal(hash(workflow), "2746b4eef637c9ae547c82858a8c9babe5ffd1a98dcec1906ee7e4d887228c6f");
});
