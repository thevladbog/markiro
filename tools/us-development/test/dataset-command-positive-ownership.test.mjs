import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
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
import * as fixtureSupport from "./support/dataset-command-positive-fixture.mjs";

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
  async () => {
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
    assert.match(
      fixture,
      /readFile\(\s*resolve\(root, "apps\/api\/test\/support\/us-dataset-snapshot\.ts"\)/,
    );
    assert.match(fixture, /const root = datasetFixtureRoot;/);
    assert.match(
      fixture,
      /fileURLToPath\(new URL\("\.\.\/\.\.\/\.\.\/\.\.\/", import\.meta\.url\)\)/,
    );
    assert.equal(fixture.split('docker(["image", "inspect", storeContract.image])').length - 1, 1);
    assert.ok(fixture.includes("{ ...storeContract, id, uid, gid, imageInspection }"));
    // Exercise the actual sanitizer implementation, with independent recipe
    // locations, without booting its DB/runtime imports or requiring API dist.
    const ts = createRequire(resolve("apps/api/package.json"))("typescript");
    const diagnosticSource = readFileSync(
      "apps/api/src/deployment/us-dataset-command-runtime.ts",
      "utf8",
    );
    const diagnosticAst = ts.createSourceFile(
      "diagnostic.ts",
      diagnosticSource,
      ts.ScriptTarget.Latest,
      true,
    );
    const selected = diagnosticAst.statements.filter(
      (node) =>
        (ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((decl) => decl.name.getText() === "categories")) ||
        (ts.isFunctionDeclaration(node) &&
          ["ownValue", "usDatasetCommandDiagnostic"].includes(node.name?.text)),
    );
    assert.equal(selected.length, 3);
    const js = ts.transpileModule(selected.map((node) => node.getText()).join("\n"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const diagnose = compileFunction(`${js}; return exports.usDatasetCommandDiagnostic`, [
      "exports",
      "usSixMonthDefinition",
    ])(
      {},
      {
        units: [
          { key: "chain_0259", stages: ["shipping"] },
          { key: "request_scenario_a", stages: ["request", "package"] },
          { key: "request_april", stages: ["request", "package"] },
          { key: "request_september", stages: ["request", "package"] },
        ],
      },
    );
    const verificationSource = readFileSync(
      "apps/api/src/modules/traceability/requests/us-request-verification-failure.ts",
      "utf8",
    );
    const verificationJs = ts.transpileModule(verificationSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const projectVerificationFailure = compileFunction(
      `${verificationJs}; return exports.projectUsRequestVerificationFailure`,
      ["exports", "require"],
    )({}, createRequire(resolve("apps/api/package.json")));
    // Tooling precedes API build: compile the complete actual primitive function,
    // not a copied classifier/list, with an explicitly refusing dependency loader.
    const storageSource = readFileSync(
      "apps/api/src/modules/traceability/requests/us-request-package-artifacts.ts",
      "utf8",
    );
    const storageAst = ts.createSourceFile(
      "storage.ts",
      storageSource,
      ts.ScriptTarget.Latest,
      true,
    );
    assert.equal(storageAst.parseDiagnostics.length, 0);
    const storageDeclarations = storageAst.statements.filter(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "projectUsRequestPackageStorageReadFailureCode",
    );
    assert.equal(storageDeclarations.length, 1, "one actual complete primitive validator");
    const storageJs = ts.transpileModule(storageDeclarations[0].getText(storageAst), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let storageLoads = 0;
    const projectStorageReadFailureCode = compileFunction(
      `${storageJs}; return exports.projectUsRequestPackageStorageReadFailureCode`,
      ["exports", "require"],
    )({}, () => {
      storageLoads++;
      throw new Error("api_dist_read_forbidden");
    });
    assert.equal(typeof projectStorageReadFailureCode, "function");
    const witnessDeclarations = storageAst.statements.filter(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "projectUsRequestPackageTransportWitness",
    );
    assert.equal(witnessDeclarations.length, 1);
    const witnessJs = ts.transpileModule(witnessDeclarations[0].getText(storageAst), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let witnessLoads = 0;
    const projectTransportWitness = compileFunction(
      `${witnessJs};return exports.projectUsRequestPackageTransportWitness;`,
      ["exports", "require"],
    )({}, () => {
      witnessLoads++;
      throw Error("api_dist_read_forbidden");
    });
    const witnessLiterals = [
      "await_send:code:ECONNRESET",
      "consume_body:code:ECONNRESET",
      "await_send:code:ECONNREFUSED",
      "consume_body:code:ECONNREFUSED",
      "await_send:code:ETIMEDOUT",
      "consume_body:code:ETIMEDOUT",
      "await_send:code:EPIPE",
      "consume_body:code:EPIPE",
      "await_send:code:ENETUNREACH",
      "consume_body:code:ENETUNREACH",
      "await_send:code:EHOSTUNREACH",
      "consume_body:code:EHOSTUNREACH",
      "await_send:name:TimeoutError",
      "consume_body:name:TimeoutError",
      "await_send:name:RequestTimeout",
      "consume_body:name:RequestTimeout",
      "await_send:status:408",
      "consume_body:status:408",
      "await_send:status:429",
      "consume_body:status:429",
      "await_send:status:500",
      "consume_body:status:500",
      "await_send:status:502",
      "consume_body:status:502",
      "await_send:status:503",
      "consume_body:status:503",
      "await_send:status:504",
      "consume_body:status:504",
    ];
    const witnessInput = {
      code: "us_dataset_command_failed",
      unitKey: "request_september",
      stage: "package",
      verificationFailure: { operation: "read_private_object", artifact: "manifest.json" },
      verificationStorageCode: "us_request_package_storage_transport_failed",
      verificationTransportWitness: "await_send:code:ECONNRESET",
    };
    assert.deepEqual(
      fixtureSupport.datasetPositiveCommandDiagnostic(
        JSON.stringify(witnessInput) + "\n",
        diagnose,
        projectVerificationFailure,
        projectStorageReadFailureCode,
        projectTransportWitness,
      ),
      {
        status: "available",
        ...witnessInput,
        verificationOperation: "read_private_object",
        verificationArtifact: "manifest.json",
      },
    );
    let witnessCombinations = 0;
    assert.equal(witnessLiterals.length, 28);
    for (const verificationTransportWitness of witnessLiterals) {
      assert.equal(
        projectTransportWitness(verificationTransportWitness),
        verificationTransportWitness,
      );
      for (const unitKey of ["request_scenario_a", "request_april", "request_september"])
        for (const artifact of [
          "manifest.json",
          "package.zip",
          "plan.pdf",
          "records.xlsx",
          "request-report.pdf",
          "validation.json",
        ]) {
          const input = {
            ...witnessInput,
            unitKey,
            verificationFailure: { operation: "read_private_object", artifact },
            verificationTransportWitness,
          };
          assert.deepEqual(
            fixtureSupport.datasetPositiveCommandDiagnostic(
              JSON.stringify(input) + "\n",
              diagnose,
              projectVerificationFailure,
              projectStorageReadFailureCode,
              projectTransportWitness,
            ),
            {
              status: "available",
              ...input,
              verificationOperation: "read_private_object",
              verificationArtifact: artifact,
            },
          );
          witnessCombinations++;
        }
    }
    assert.equal(witnessCombinations, 504);
    for (const invalid of [
      null,
      undefined,
      1,
      {},
      [],
      Object(witnessLiterals[0]),
      "await_send:name:private",
      "consume_body:status:404",
      ...witnessLiterals.flatMap((value) => [` ${value}`, `${value}\n`, `${value}:private`]),
    ])
      assert.equal(projectTransportWitness(invalid), undefined);
    const invalidWitnessInputs = [
      { ...witnessInput, verificationTransportWitness: null },
      { ...witnessInput, verificationTransportWitness: { code: "private" } },
      { ...witnessInput, verificationTransportWitness: "await_send:name:private" },
      { ...witnessInput, transportWitness: witnessLiterals[0] },
      { ...witnessInput, verificationOperation: "read_private_object" },
      { ...witnessInput, verificationStorageCode: "us_request_package_storage_timeout" },
      { ...witnessInput, verificationStorageCode: undefined },
      { ...witnessInput, verificationFailure: undefined },
      { ...witnessInput, verificationFailure: { operation: "read_plan" } },
      { ...witnessInput, verificationFailure: { operation: "read_private_object" } },
      {
        ...witnessInput,
        verificationFailure: { operation: "compare_private_object", artifact: "manifest.json" },
      },
      { ...witnessInput, unitKey: "chain_0259" },
      { ...witnessInput, stage: "request" },
      { ...witnessInput, code: "us_dataset_request_conflict" },
    ];
    for (const input of invalidWitnessInputs)
      assert.deepEqual(
        fixtureSupport.datasetPositiveCommandDiagnostic(
          JSON.stringify(input) + "\n",
          diagnose,
          projectVerificationFailure,
          projectStorageReadFailureCode,
          projectTransportWitness,
        ),
        { status: "unavailable" },
      );
    for (const validator of [
      undefined,
      () => undefined,
      () => "consume_body:name:TimeoutError",
      () => {
        throw Error("private sentinel");
      },
    ])
      assert.deepEqual(
        fixtureSupport.datasetPositiveCommandDiagnostic(
          JSON.stringify(witnessInput) + "\n",
          diagnose,
          projectVerificationFailure,
          projectStorageReadFailureCode,
          validator,
        ),
        { status: "unavailable" },
      );
    assert.equal(
      witnessLoads,
      0,
      "actual witness source compilation never reads dist or dependencies",
    );
    const unavailable = { status: "unavailable" };
    const extension = {
      code: "us_dataset_command_failed",
      unitKey: "request_september",
      stage: "package",
      verificationFailure: { operation: "read_private_object", artifact: "records.xlsx" },
    };
    const storageCodes = [
      "us_request_package_storage_scope_invalid",
      "us_request_package_storage_evidence_invalid",
      "us_request_package_storage_timeout",
      "us_request_package_storage_checksum_mismatch",
      "us_request_package_storage_transport_failed",
      "us_request_package_storage_read_failed",
      "us_request_worker_unknown_failure",
    ];
    const diagnosticCases = [
      [
        '{"code":"us_dataset_command_connection_failed","unitKey":"chain_0259","stage":"shipping"}\n',
        {
          status: "available",
          code: "us_dataset_command_connection_failed",
          unitKey: "chain_0259",
          stage: "shipping",
        },
      ],
      [
        '{"code":"us_dataset_command_failed"}\n',
        { status: "available", code: "us_dataset_command_failed" },
      ],
      [
        '{"code":"postgres://hostile-secret","unitKey":"chain_0260","stage":"shipping"}\n',
        { status: "available", code: "us_dataset_command_failed" },
      ],
      [
        '{"code":"us_dataset_command_failed","unitKey":"chain_0259","stage":"package"}\n',
        { status: "available", code: "us_dataset_command_failed" },
      ],
      ['{"code":"us_dataset_command_failed","extra":"hostile-secret"}\n', unavailable],
      ['{"code":42}\n', unavailable],
      ['{"code":"us_dataset_command_failed","unitKey":"chain_0259"}\n', unavailable],
      [
        '{"code":"us_dataset_command_failed","__proto__":{"secret":"hostile-secret"}}\n',
        unavailable,
      ],
      ['{"code":"us_dataset_command_failed"}\n{"code":"hostile-secret"}\n', unavailable],
      ["hostile-secret SQL error", unavailable],
      ['{"code":"us_dataset_command_failed"', unavailable],
      ["x".repeat(4097), unavailable],
      [
        JSON.stringify(extension) + "\n",
        {
          status: "available",
          ...extension,
          verificationOperation: "read_private_object",
          verificationArtifact: "records.xlsx",
        },
      ],
      ...[
        { ...extension, code: "private-secret" },
        { ...extension, code: "us_dataset_request_conflict" },
        { ...extension, unitKey: "chain_0259" },
        { ...extension, unitKey: "request_october" },
        { ...extension, stage: "request" },
        { ...extension, verificationFailure: null },
        { ...extension, verificationFailure: { operation: "read_private_object" } },
        { ...extension, verificationFailure: { operation: "unknown" } },
        { ...extension, verificationFailure: { operation: "read_plan", artifact: "package.zip" } },
        {
          ...extension,
          verificationFailure: { operation: "verify_private_archive", artifact: "plan.pdf" },
        },
        { ...extension, verificationFailure: { operation: "read_plan", extra: "private-secret" } },
        {
          ...extension,
          verificationFailure: { operation: "read_private_object", artifact: "private/key" },
        },
        { ...extension, extra: "private-secret" },
        { ...extension, verificationOperation: "private-secret" },
        { ...extension, verificationArtifact: "private-secret" },
        { code: "us_dataset_command_failed", verificationOperation: "read_plan" },
        {
          ...extension,
          verificationFailure: { operation: "read_plan", verificationOperation: "private-secret" },
        },
      ].map((value) => [JSON.stringify(value) + "\n", unavailable]),
      ['{"code":"us_dataset_command_failed","code":"us_dataset_command_failed"}\n', unavailable],
      ['{ "code":"us_dataset_command_failed"}\n', unavailable],
    ];
    const failures = [];
    const check = async (action) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    await check(async () => {
      for (const verificationStorageCode of storageCodes)
        for (const unitKey of ["request_scenario_a", "request_april", "request_september"])
          for (const artifact of [
            "manifest.json",
            "package.zip",
            "plan.pdf",
            "records.xlsx",
            "request-report.pdf",
            "validation.json",
          ]) {
            const input = {
              ...extension,
              unitKey,
              verificationFailure: { operation: "read_private_object", artifact },
              verificationStorageCode,
            };
            const line = JSON.stringify(input) + "\n";
            assert.deepEqual(
              fixtureSupport.datasetPositiveCommandDiagnostic(
                line,
                diagnose,
                projectVerificationFailure,
                projectStorageReadFailureCode,
              ),
              {
                status: "available",
                ...input,
                verificationOperation: "read_private_object",
                verificationArtifact: artifact,
              },
            );
            assert.deepEqual(
              fixtureSupport.datasetPositiveCommandDiagnostic(
                line,
                diagnose,
                projectVerificationFailure,
              ),
              unavailable,
            );
          }
      for (const invalid of [
        { ...extension, verificationStorageCode: "private-secret" },
        { ...extension, verificationStorageCode: null },
        { ...extension, verificationStorageCode: { code: storageCodes[0] } },
        {
          ...extension,
          verificationStorageCode: storageCodes[0],
          code: "us_dataset_request_conflict",
        },
        { ...extension, verificationStorageCode: storageCodes[0], unitKey: "chain_0259" },
        { ...extension, verificationStorageCode: storageCodes[0], stage: "request" },
        { code: "us_dataset_command_failed", verificationStorageCode: storageCodes[0] },
        {
          ...extension,
          verificationFailure: { operation: "read_plan" },
          verificationStorageCode: storageCodes[0],
        },
        {
          ...extension,
          verificationFailure: { operation: "compare_private_object", artifact: "manifest.json" },
          verificationStorageCode: storageCodes[0],
        },
        {
          ...extension,
          verificationFailure: { operation: "read_private_object", artifact: "private/key" },
          verificationStorageCode: storageCodes[0],
        },
        { ...extension, verificationStorageCode: storageCodes[0], storageCode: storageCodes[0] },
      ])
        assert.deepEqual(
          fixtureSupport.datasetPositiveCommandDiagnostic(
            JSON.stringify(invalid) + "\n",
            diagnose,
            projectVerificationFailure,
            projectStorageReadFailureCode,
          ),
          unavailable,
        );
      const line =
        JSON.stringify({ ...extension, verificationStorageCode: storageCodes[0] }) + "\n";
      assert.deepEqual(
        fixtureSupport.datasetPositiveCommandDiagnostic(
          line,
          diagnose,
          projectVerificationFailure,
          () => {
            throw Error("private-secret");
          },
        ),
        unavailable,
      );
      assert.equal(
        projectStorageReadFailureCode("us_request_package_storage_collision"),
        undefined,
      );
      assert.equal(
        storageLoads,
        0,
        "primitive source compilation has no dependency or API dist reads",
      );
    });
    for (const [stderr, wanted] of diagnosticCases)
      await check(async () => {
        const diagnostic = fixtureSupport.datasetPositiveCommandDiagnostic(
          stderr,
          diagnose,
          projectVerificationFailure,
        );
        assert.deepEqual(diagnostic, wanted);
        assert.doesNotMatch(JSON.stringify(diagnostic), /hostile-secret|SQL error/);
      });
    await check(async () => {
      // Independent closed fixtures, never derived from the implementation lists.
      const tuples = [
        ...[
          "package_stage",
          "validate_request",
          "prepare_package",
          "probe_before_worker",
          "run_worker",
          "probe_after_worker",
          "render_payloads",
          "read_plan",
          "bind_inputs",
          "check_checkpoint",
          "assemble_package",
          "compare_manifest",
          "compare_entries",
          "compare_archive",
          "final_publication_probe",
          "commit_package_receipt",
        ].map((operation) => ({ operation })),
        ...["read_private_object", "compare_private_object"].flatMap((operation) =>
          [
            "manifest.json",
            "package.zip",
            "plan.pdf",
            "records.xlsx",
            "request-report.pdf",
            "validation.json",
          ].map((artifact) => ({ operation, artifact })),
        ),
        { operation: "verify_private_archive", artifact: "package.zip" },
      ];
      assert.equal(tuples.length, 29);
      for (const tuple of tuples) {
        const input = {
          code: "us_dataset_command_failed",
          unitKey: "request_september",
          stage: "package",
          verificationFailure: tuple,
        };
        const diagnostic = fixtureSupport.datasetPositiveCommandDiagnostic(
          JSON.stringify(input) + "\n",
          diagnose,
          projectVerificationFailure,
        );
        assert.deepEqual(diagnostic, {
          status: "available",
          ...input,
          verificationOperation: tuple.operation,
          ...(Object.hasOwn(tuple, "artifact") ? { verificationArtifact: tuple.artifact } : {}),
        });
        assert.equal(
          Object.hasOwn(diagnostic, "verificationArtifact"),
          Object.hasOwn(tuple, "artifact"),
        );
      }
    });
    await check(async () => {
      // Actual reporter + real parser/child boundary. Only the leaf program emits
      // synthetic canonical failure JSON; no dataset executable or proof is used.
      const reporter = String.raw`
        import assert from 'node:assert/strict';
        import test from 'node:test';
        import net from 'node:net';
        import {createRequire,syncBuiltinESMExports} from 'node:module';
        import {resolve} from 'node:path';
        import {compileFunction} from 'node:vm';
        const noSocket = () => { throw Error('forbidden_socket_io'); };
        net.Socket.prototype.connect = noSocket;
        net.Server.prototype.listen = noSocket;
        syncBuiltinESMExports();
        const {runDatasetPositiveChild} = await import('./tools/us-development/test/support/dataset-command-positive-fixture.mjs');
        const diagnose = compileFunction(${JSON.stringify(js)} + ';return exports.usDatasetCommandDiagnostic;', ['exports','usSixMonthDefinition'])({}, {units:[{key:'request_april',stages:['request','package']}]});
        const projectVerificationFailure = compileFunction(${JSON.stringify(verificationJs)} + ';return exports.projectUsRequestVerificationFailure;', ['exports','require'])({},createRequire(resolve('apps/api/package.json')));
        const projectStorageReadFailureCode = compileFunction(${JSON.stringify(storageJs)} + ';return exports.projectUsRequestPackageStorageReadFailureCode;', ['exports','require'])({},()=>{throw Error('api_dist_read_forbidden');});
        const projectTransportWitness = compileFunction(${JSON.stringify(witnessJs)} + ';return exports.projectUsRequestPackageTransportWitness;', ['exports','require'])({},()=>{throw Error('api_dist_read_forbidden');});
        for(const [tuple,transport] of [[{operation:'read_private_object',artifact:'records.xlsx'},false],[{operation:'read_plan'},false],[{operation:'read_private_object',artifact:'manifest.json'},true]]) {
          test('projected '+tuple.operation+' remains visible', {timeout:2000}, async()=>{
            const input = {code:'us_dataset_command_failed',unitKey:'request_april',stage:'package',verificationFailure:tuple,...(tuple.operation==='read_private_object'?{verificationStorageCode:transport?'us_request_package_storage_transport_failed':'us_request_package_storage_timeout'}:{}),...(transport?{verificationTransportWitness:'consume_body:code:ECONNRESET'}:{})};
            let original;
            try {
              await runDatasetPositiveChild(process.execPath,['-e','process.stdout.write("hostile-secret");process.stderr.write('+JSON.stringify(JSON.stringify(input)+'\n')+');process.exitCode=1'],{env:{PATH:process.env.PATH},cap:1000,limit:4096,diagnose,projectVerificationFailure,projectStorageReadFailureCode,projectTransportWitness});
            } catch(error) { original = error; }
            assert.equal(original?.message,'us_dataset_positive_child_failed');
            assert.equal(original.evidence.code,1);
            assert.equal(original.evidence.signal,null);
            assert.equal(original.evidence.timedOut,false);
            assert.equal(original.evidence.overflow,false);
            assert.ok(original.evidence.elapsedMs>=0 && original.evidence.elapsedMs<1000);
            assert.deepEqual(original.evidence.diagnostic.verificationFailure,tuple);
            if(tuple.operation==='read_private_object') assert.equal(original.evidence.diagnostic.verificationStorageCode,transport?'us_request_package_storage_transport_failed':'us_request_package_storage_timeout');
            else assert.equal(Object.hasOwn(original.evidence.diagnostic,'verificationStorageCode'),false);
            if(transport) assert.equal(original.evidence.diagnostic.verificationTransportWitness,'consume_body:code:ECONNRESET');
            else assert.equal(Object.hasOwn(original.evidence.diagnostic,'verificationTransportWitness'),false);
            throw original;
          });
        }
      `;
      const shown = spawnSync(
        process.execPath,
        ["--test-reporter=spec", "--input-type=module", "-e", reporter],
        {
          encoding: "utf8",
          timeout: 4000,
          maxBuffer: 256 * 1024,
          env: { PATH: process.env.PATH },
        },
      );
      assert.equal(shown.error, undefined);
      assert.equal(shown.status, 1, "all three real reporter cases must remain failures");
      assert.equal(shown.signal, null);
      assert.equal(shown.stderr, "");
      assert.match(shown.stdout, /fail 3/);
      assert.match(shown.stdout, /verificationFailure: \[Object\]/);
      assert.match(shown.stdout, /verificationStorageCode: 'us_request_package_storage_timeout'/);
      assert.match(shown.stdout, /verificationTransportWitness: 'consume_body:code:ECONNRESET'/);
      assert.match(
        shown.stdout,
        /verificationOperation: 'read_private_object'/,
        "closed operation hidden by reporter",
      );
      assert.match(
        shown.stdout,
        /verificationArtifact: 'records.xlsx'/,
        "closed artifact hidden by reporter",
      );
      const scalarLine = shown.stdout
        .split("\n")
        .find((line) => line.includes("verificationOperation: 'read_plan'"));
      assert.ok(scalarLine, "operation-only boundary hidden by reporter");
      assert.doesNotMatch(scalarLine, /verificationArtifact/);
      assert.doesNotMatch(shown.stdout + shown.stderr, /hostile-secret|forbidden_socket_io/);
    });
    await check(async () => {
      const [stderr, wanted] = diagnosticCases[0];
      await assert.rejects(
        fixtureSupport.runDatasetPositiveChild(
          process.execPath,
          [
            "-e",
            `process.stdout.write('stdout-hostile-secret');process.stderr.write(${JSON.stringify(stderr)});process.exitCode=1`,
          ],
          { diagnose, projectVerificationFailure },
        ),
        (error) => {
          assert.equal(error.message, "us_dataset_positive_child_failed");
          assert.equal(error.evidence.code, 1);
          assert.equal(error.evidence.timedOut, false);
          assert.equal(error.evidence.overflow, false);
          assert.equal(error.evidence.signal, null);
          assert.ok(error.evidence.elapsedMs >= 0 && error.evidence.elapsedMs < 5000);
          assert.deepEqual(error.evidence.diagnostic, wanted);
          assert.doesNotMatch(JSON.stringify(error) + error.stack, /hostile-secret|SQL error/);
          return true;
        },
      );
    });
    await check(async () => {
      const stderr = JSON.stringify(extension) + "\n";
      assert.deepEqual(
        fixtureSupport.datasetPositiveCommandDiagnostic(stderr, diagnose),
        unavailable,
      );
      assert.deepEqual(
        fixtureSupport.datasetPositiveCommandDiagnostic(
          '{"code":"us_dataset_command_failed"}\n',
          diagnose,
        ),
        unavailable,
      );
      assert.deepEqual(
        fixtureSupport.datasetPositiveCommandDiagnostic(
          stderr,
          undefined,
          projectVerificationFailure,
        ),
        unavailable,
      );
      assert.deepEqual(
        fixtureSupport.datasetPositiveCommandDiagnostic(stderr, diagnose, () => {
          throw new Error("hostile-secret");
        }),
        unavailable,
      );
      await assert.rejects(
        fixtureSupport.runDatasetPositiveChild(
          process.execPath,
          ["-e", `process.stderr.write(${JSON.stringify(stderr)});process.exitCode=1`],
          { diagnose, projectVerificationFailure },
        ),
        (error) => {
          assert.equal(error.message, "us_dataset_positive_child_failed");
          assert.equal(error.evidence.code, 1);
          assert.equal(error.evidence.timedOut, false);
          assert.equal(error.evidence.overflow, false);
          assert.deepEqual(error.evidence.diagnostic, {
            status: "available",
            ...extension,
            verificationOperation: "read_private_object",
            verificationArtifact: "records.xlsx",
          });
          return true;
        },
      );
    });
    await check(async () => {
      await assert.rejects(
        fixtureSupport.runDatasetPositiveChild(
          process.execPath,
          [
            "-e",
            'process.stderr.write(\'{"code":"us_dataset_command_failed"}\\n\');process.exitCode=1',
          ],
          {
            projectVerificationFailure,
            diagnose: () => {
              throw new Error("hostile-secret");
            },
          },
        ),
        (error) => {
          assert.equal(error.message, "us_dataset_positive_child_failed");
          assert.deepEqual(error.evidence.diagnostic, unavailable);
          assert.doesNotMatch(JSON.stringify(error) + error.stack, /hostile-secret/);
          return true;
        },
      );
    });
    await check(async () => {
      let parsed = 0,
        projected = 0,
        storageProjected = 0;
      await assert.rejects(
        fixtureSupport.runDatasetPositiveChild(
          process.execPath,
          [
            "-e",
            'process.stderr.write(\'{"code":"us_dataset_command_failed"}\\n\');setTimeout(()=>process.stderr.write("x".repeat(8192)),100)',
          ],
          {
            projectStorageReadFailureCode: (value) => {
              storageProjected++;
              return projectStorageReadFailureCode(value);
            },
            projectVerificationFailure: (value) => {
              projected++;
              return projectVerificationFailure(value);
            },
            limit: 4096,
            cap: 1000,
            diagnose: (error) => {
              parsed++;
              return diagnose(error);
            },
          },
        ),
        (error) => {
          assert.equal(error.message, "us_dataset_positive_child_failed");
          assert.equal(error.evidence.overflow, true);
          assert.equal(error.evidence.timedOut, false);
          assert.deepEqual(error.evidence.diagnostic, unavailable);
          assert.equal(parsed, 0, "incomplete retained stderr must not be parsed");
          assert.equal(projected, 0, "overflow must not invoke the new projector either");
          assert.equal(storageProjected, 0, "overflow must not invoke the storage validator");
          return true;
        },
      );
    });
    await check(async () => {
      for (const [script, options, field] of [
        ["setTimeout(()=>{},2000)", { cap: 80 }, "timedOut"],
        [
          "process.stderr.write('x'.repeat(4097));setTimeout(()=>{},2000)",
          { limit: 4096 },
          "overflow",
        ],
      ])
        await assert.rejects(
          fixtureSupport.runDatasetPositiveChild(process.execPath, ["-e", script], {
            diagnose,
            projectVerificationFailure,
            ...options,
          }),
          (error) => {
            assert.equal(error.message, "us_dataset_positive_child_failed");
            assert.equal(error.evidence[field], true);
            assert.deepEqual(error.evidence.diagnostic, unavailable);
            return true;
          },
        );
      await assert.rejects(
        fixtureSupport.runDatasetPositiveChild(process.execPath, [
          "-e",
          "process.stderr.write('hostile-secret');process.exitCode=1",
        ]),
        (error) => {
          assert.equal(error.message, "us_dataset_positive_child_failed");
          assert.equal(Object.hasOwn(error.evidence, "diagnostic"), false);
          assert.doesNotMatch(JSON.stringify(error) + error.stack, /hostile-secret/);
          return true;
        },
      );
      const success = await fixtureSupport.runDatasetPositiveChild(
        process.execPath,
        ["-e", "process.stdout.write('original-success')"],
        { diagnose, projectVerificationFailure },
      );
      assert.equal(success.stdout, "original-success");
      assert.equal(success.stderr, "");
    });
    await check(async () => {
      assert.equal(
        typeof fixtureSupport.retainDatasetPositiveCommandFailure,
        "function",
        "nonzero command must retain actual measurements without replacing failure",
      );
      const directory = await mkdtemp(join(tmpdir(), "dataset-command-diagnostic-"));
      const timeFile = join(directory, "time.txt");
      const time = "\tMaximum resident set size (kbytes): 123456\n\tExit status: 1\n";
      const counts = { reads: 12, mutations: 3, failures: 1, active: 0, raw: "hostile-secret" };
      const observer = { counts: () => counts };
      try {
        await writeFile(timeFile, time, { mode: 0o600 });
        const original = Object.assign(new Error("us_dataset_positive_child_failed"), {
          evidence: { code: 1, elapsedMs: 42 },
        });
        assert.equal(
          await fixtureSupport.retainDatasetPositiveCommandFailure(
            original,
            "initialize",
            timeFile,
            observer,
          ),
          original,
        );
        assert.deepEqual(original.command, {
          mode: "initialize",
          measurement: { status: "available", maximumRssKiB: 123456, exitStatus: 1 },
          provider: { status: "available", reads: 12, mutations: 3, failures: 1, active: 0 },
        });
        for (const invalid of [
          "",
          time.replace("123456", "0"),
          time.replace("123456", "-1"),
          time.replace("123456", "Infinity"),
          time.replace("123456", "9007199254740992"),
          time.replace("Exit status: 1", "Exit status: 256"),
          time + time,
          time + "\tMaximum resident set size (kbytes): hostile-secret\n",
          time + "\tExit status: -1\n",
          "hostile-secret".repeat(2000),
        ]) {
          await writeFile(timeFile, invalid);
          const failure = new Error("original");
          assert.equal(
            await fixtureSupport.retainDatasetPositiveCommandFailure(
              failure,
              "verify",
              timeFile,
              observer,
            ),
            failure,
          );
          assert.deepEqual(failure.command.measurement, unavailable);
          assert.doesNotMatch(JSON.stringify(failure), /hostile-secret/);
        }
        await rm(timeFile);
        const missing = new Error("original");
        assert.equal(
          await fixtureSupport.retainDatasetPositiveCommandFailure(
            missing,
            "initialize",
            timeFile,
            {
              counts: () => {
                throw new Error("hostile-secret");
              },
            },
          ),
          missing,
        );
        assert.deepEqual(missing.command.measurement, unavailable);
        assert.deepEqual(missing.command.provider, unavailable);
        const invalidCounts = new Error("original");
        await fixtureSupport.retainDatasetPositiveCommandFailure(
          invalidCounts,
          "initialize",
          timeFile,
          { counts: () => ({ ...counts, reads: -1 }) },
        );
        assert.deepEqual(invalidCounts.command.provider, unavailable);
        const frozen = Object.freeze(new Error("original"));
        assert.equal(
          await fixtureSupport.retainDatasetPositiveCommandFailure(
            frozen,
            "initialize",
            timeFile,
            observer,
          ),
          frozen,
        );
      } finally {
        await rm(directory, { recursive: true });
      }
    });
    if (failures.length)
      throw new AggregateError(failures, "nonzero command diagnostic evidence lost");
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
      imageInspection: {
        Id: "sha256:7b5ca1f11aa4c91593612d2d4a9e253ec9152a4bd13a19e551290a042a4c52f5",
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [
          "chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d",
        ],
      },
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
