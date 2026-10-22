import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import test from "node:test";
import ts from "typescript";

const root = new URL("../../../", import.meta.url);
const nativePath = new URL("apps/api/test/us-dataset-complete-seed.e2e.test.ts", root);
const native = readFileSync(nativePath, "utf8");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const originalRaw = "c63752c0652dc5819ee4b0b97df7ee149163c288206d3c5423bfcd8272a5d373";
const originalPrinted = "7ead32806e203434938228186d7935eb823795bbd5cf63297cf63184d53cd1e6";
const printer = ts.createPrinter({ removeComments: false });
function parsed(source) {
  const file = ts.createSourceFile("native.ts", source, ts.ScriptTarget.Latest, true);
  assert.equal(file.parseDiagnostics.length, 0);
  return file;
}
function tokens(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const result = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
    result.push([kind, scanner.getTokenText()]);
  // Prettier may add a trailing comma at a multiline call. It is layout, not
  // another argument; all non-trailing tokens still match the fixed whole node.
  return JSON.stringify(
    result.filter(
      ([kind], i) =>
        !(
          kind === ts.SyntaxKind.CommaToken &&
          [
            ts.SyntaxKind.CloseParenToken,
            ts.SyntaxKind.CloseBracketToken,
            ts.SyntaxKind.CloseBraceToken,
          ].includes(result[i + 1]?.[0])
        ),
    ),
  );
}
// Independent exact additions: match whole AST nodes before erasure, never broad blocks.
const inverseRules = [
  [
    "",
    'import { createUsDatasetCompleteMeasurements } from "./support/us-dataset-complete-measurements";',
  ],
  ["", "let measurements: ReturnType<typeof createUsDatasetCompleteMeasurements>;"],
  ["", "measurements.assertCanContinue();", 4],
  ["", "let hasCleanupFailure = false;"],
  ["", "let cleanupFailure: unknown;"],
  [
    "",
    "try { measurements?.restoreOwned(); } catch (error) { hasCleanupFailure = true; cleanupFailure = error; }",
  ],
  ["", "if (hasCleanupFailure) throw cleanupFailure;"],
  ["", 'if (fault === "corrupt") measurements.assertComplete();'],
  [
    "",
    `measurements = createUsDatasetCompleteMeasurements({
    pool: f.pool, tracePrototype: UsDatasetTraceReadinessSeedStore.prototype,
    artifactPrototype: UsDatasetArtifactSeedStore.prototype,
    emit: (line) => { process.stdout.write(line); },
  });`,
  ],
  ['snapshot("refusal-before")', 'snapshot(phase, "refusal-before")'],
  ['snapshot("refusal-after")', 'snapshot(phase, "refusal-after")'],
  ['snapshot("fresh-before")', 'snapshot("fresh", "fresh-before")'],
  ['snapshot("fresh-after")', 'snapshot("fresh", "fresh-after")'],
  ['snapshot("pending-before")', 'snapshot("pending", "pending-before")'],
  ['snapshot("pending-after")', 'snapshot("pending", "pending-after")'],
  ['snapshot("completed-before")', 'snapshot("queued_baseline", "completed-before")'],
  [
    'snapshot("completed-initialize-after")',
    'snapshot("replay_initialize", "completed-initialize-after")',
  ],
  ['snapshot("completed-verify-after")', 'snapshot("replay_verify", "completed-verify-after")'],
  ['snapshot("drift-before")', 'snapshot("native_drift", "drift-before")'],
  ['snapshot("drift-after")', 'snapshot("native_drift", "drift-after")'],
  ["snapshot(`${fault}-before`)", "snapshot(fault, `${fault}-before`)"],
  ["snapshot(`${fault}-after`)", "snapshot(fault, `${fault}-after`)"],
  [
    "refuseBoth({ ...f.context, tenantId: randomUUID() })",
    'refuseBoth("wrong_tenant", { ...f.context, tenantId: randomUUID() })',
  ],
  ["refuseBoth()", 'refuseBoth("owner_revoked")'],
  ["refuseBoth()", 'refuseBoth("profile_changed")'],
  [
    "store()\n          .initialize(f.context)",
    'measurements.withComplete("generation", "initialize", () => store().initialize(f.context))',
  ],
  [
    "store().initialize(f.context)",
    'measurements.withComplete("resume", "initialize", () => store().initialize(f.context))',
  ],
  [
    "new UsDatasetCompleteSeedStore(observed.db, f.services).verify(f.context)",
    'measurements.withComplete("pending", "verify", () => new UsDatasetCompleteSeedStore(observed.db, f.services).verify(f.context))',
  ],
  [
    "new UsDatasetCompleteSeedStore(observed.db, f.services).initialize(\n f.context,\n)",
    'measurements.withComplete("replay_initialize", "initialize", () => new UsDatasetCompleteSeedStore(observed.db, f.services).initialize(f.context))',
  ],
  [
    "new UsDatasetCompleteSeedStore(observed.db, f.services).verify(\n f.context,\n)",
    'measurements.withComplete("replay_verify", "verify", () => new UsDatasetCompleteSeedStore(observed.db, f.services).verify(f.context))',
  ],
  [
    "new UsDatasetCompleteSeedStore(observed.db, f.services).verify(f.context)",
    'measurements.withComplete(fault, "verify", () => new UsDatasetCompleteSeedStore(observed.db, f.services).verify(f.context))',
  ],
];
function preserve(source) {
  if (digest(source) === originalRaw) {
    assert.equal(digest(printer.printFile(parsed(source))), originalPrinted);
    return;
  }
  const file = parsed(source);
  const teardown = nativeTeardownCallback(file).body.statements;
  assert.equal(teardown.length, 8, "exact teardown control-flow statement count");
  for (const [index, expected] of [
    [0, "await acquisition?.catch(() => undefined);"],
    [1, "while (work.size) await Promise.allSettled([...work]);"],
    [2, "if (!f) return;"],
    [3, "let hasCleanupFailure = false;"],
    [4, "let cleanupFailure: unknown;"],
    [
      5,
      "try { measurements?.restoreOwned(); } catch (error) { hasCleanupFailure = true; cleanupFailure = error; }",
    ],
    [7, "if (hasCleanupFailure) throw cleanupFailure;"],
  ])
    assert.equal(
      tokens(teardown[index].getText(file)),
      tokens(expected),
      `exact teardown order ${index}`,
    );
  assert.ok(ts.isTryStatement(teardown[6]), "existing teardown inside one capture shell");
  // Parameter lists are not nodes. Replace only their one exact containing signature;
  // helper body remains intact and is checked by the reconstructed original digest.
  const signatures = [
    [
      "async function snapshot(label: string)",
      "async function snapshot(phase: Parameters<typeof measurements.snapshot>[0], label: string)",
    ],
    [
      "async function refuseBoth(context = f.context)",
      "async function refuseBoth(phase: Parameters<typeof measurements.snapshot>[0], context = f.context)",
    ],
  ].map(([before, after]) => ({ before, after: tokens(after), found: 0 }));
  const rules = inverseRules.map(([before, after, count = 1]) => ({
    before,
    after: tokens(after),
    count,
    found: 0,
  }));
  rules.push({
    before: "f.snapshot()",
    after: tokens("measurements.snapshot(phase, label, () => f.snapshot())"),
    count: 1,
    found: 0,
  });
  const edits = [];
  let cleanupShells = 0;
  function visit(node) {
    if (
      ts.isTryStatement(node) &&
      node.catchClause &&
      !node.finallyBlock &&
      tokens(node.catchClause.getText(file)) ===
        tokens(
          "catch (error) { if (!hasCleanupFailure) { hasCleanupFailure = true; cleanupFailure = error; } }",
        )
    ) {
      assert.equal(node, teardown[6], "capture shell at prescribed teardown position");
      assert.equal(
        node.tryBlock.statements.length,
        1,
        "one original teardown statement inside capture shell",
      );
      const original = node.tryBlock.statements[0];
      assert.ok(ts.isTryStatement(original) && original.finallyBlock && !original.catchClause);
      cleanupShells++;
      edits.push([node.getStart(file), original.getStart(file), ""], [original.end, node.end, ""]);
      visit(original);
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.body) {
      const header = tokens(source.slice(node.getStart(file), node.body.getStart(file)));
      const signature = signatures.find((candidate) => candidate.after === header);
      if (signature) {
        signature.found++;
        edits.push([node.getStart(file), node.body.getStart(file), signature.before + " "]);
      }
    }
    const text = tokens(node.getText(file));
    const rule = rules.find((candidate) => candidate.after === text);
    if (rule) {
      rule.found++;
      edits.push([node.getStart(file), node.end, rule.before]);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(cleanupShells, 1, "exact teardown failure capture shell");
  for (const [i, rule] of rules.entries())
    assert.equal(rule.found, rule.count, `exact inverse node cardinality ${i}`);
  for (const signature of signatures)
    assert.equal(signature.found, 1, "exact signature cardinality");
  // All additions were independently matched before any candidate text is removed.
  let restored = source;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0]))
    restored = restored.slice(0, start) + replacement + restored.slice(end);
  assert.equal(
    digest(printer.printFile(parsed(restored))),
    originalPrinted,
    "fixed original native AST print",
  );
}
let baselinePassed = false;
let modules;
function actualModules() {
  assert.equal(baselinePassed, true, "baseline must precede helper behavior");
  if (modules) return modules;
  assert.equal(ts.version, "6.0.3");
  function compile(relative, require) {
    const path = new URL(relative, root);
    const source = readFileSync(path, "utf8");
    parsed(source);
    const output = ts.transpileModule(source, {
      fileName: fileURLToPath(path),
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    assert.deepEqual(output.diagnostics, []);
    const module = { exports: {} };
    compileFunction(output.outputText, ["exports", "require", "module"], {
      filename: fileURLToPath(path),
    })(module.exports, require, module);
    return Object.freeze(module.exports);
  }
  let counterLoads = 0;
  const counterSource = readFileSync(
    new URL("apps/api/test/support/us-dataset-query-counter.ts", root),
    "utf8",
  );
  assert.equal(
    digest(counterSource),
    "59a2803ecf7f4746db177486ab4b66069fe4d7fe9b6b554284accd7c12a219b6",
  );
  const counter = compile("apps/api/test/support/us-dataset-query-counter.ts", () => {
    counterLoads++;
    throw new Error("forbidden_counter_dependency");
  });
  let helperLoads = 0;
  modules = compile("apps/api/test/support/us-dataset-complete-measurements.ts", (request) => {
    helperLoads++;
    assert.equal(request, "./us-dataset-query-counter.js");
    return counter;
  });
  assert.equal(counterLoads, 0);
  assert.equal(helperLoads, 1);
  assert.deepEqual(Object.keys(modules).sort(), [
    "createUsDatasetCompleteMeasurements",
    "parseUsDatasetCompleteBoundary",
  ]);
  return modules;
}

async function settled(action) {
  try {
    return { returned: true, value: await action() };
  } catch (value) {
    return { returned: false, value };
  }
}
function nativeTeardownCallback(file) {
  const descriptions = file.statements.filter(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isCallExpression(node.expression.expression) &&
      node.expression.expression.expression.getText(file) === "describe.skipIf",
  );
  assert.equal(descriptions.length, 1);
  const describe = descriptions[0].expression;
  assert.equal(describe.arguments.length, 2);
  assert.equal(describe.arguments[0].text, "actual complete six-month seed owner");
  const body = describe.arguments[1];
  assert.ok(ts.isArrowFunction(body) && ts.isBlock(body.body));
  assert.equal(body.parameters.length, 0);
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "afterAll") calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(
    body.body.statements.some(
      (statement) => ts.isExpressionStatement(statement) && statement.expression === call,
    ),
  );
  assert.equal(call.arguments.length, 2);
  assert.ok(ts.isNumericLiteral(call.arguments[1]));
  assert.equal(call.arguments[1].text, "60000");
  const callback = call.arguments[0];
  assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  assert.equal(callback.parameters.length, 0);
  assert.deepEqual(
    callback.modifiers.map((modifier) => modifier.kind),
    [ts.SyntaxKind.AsyncKeyword],
  );
  return callback;
}
function actualTeardownFactory() {
  assert.equal(baselinePassed, true);
  preserve(native);
  const file = parsed(native);
  const callback = nativeTeardownCallback(file);
  // Root-approved I1 exception: WHOLE actual callback, never a copied teardown.
  // The rest of the native module, its imports and fixture are not evaluated.
  const source = `const cleanup = ${callback.getText(file)};`;
  parsed(source);
  const output = ts.transpileModule(source, {
    fileName: "actual-complete-teardown.ts",
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(output.diagnostics, []);
  return compileFunction(output.outputText + "\nreturn cleanup;", [
    "acquisition",
    "work",
    "f",
    "measurements",
    "expect",
    "evidence",
    "elapsed",
    "started",
  ]);
}
function fixture(options = {}) {
  const listeners = new Set();
  const records = [];
  const calls = [];
  const queryCalls = [];
  const state = { on: 0, off: 0, actions: 0, query: 0, offFails: false, onFails: false };
  const result = Object.freeze({ synthetic: true });
  const client = {
    query(...args) {
      assert.equal(this, client);
      queryCalls.push(args);
      state.query++;
      const callback = args.at(-1);
      if (typeof callback === "function") {
        callback(null, result);
        return result;
      }
      return Promise.resolve(result);
    },
  };
  const originalQuery = client.query;
  const pool = {
    on(event, listener) {
      assert.equal(event, "acquire");
      state.on++;
      if (state.onFails) throw new Error("synthetic_registration_fault");
      listeners.add(listener);
      return this;
    },
    off(event, listener) {
      assert.equal(event, "acquire");
      state.off++;
      if (state.offFails) throw new Error("synthetic_cleanup_fault");
      listeners.delete(listener);
      return this;
    },
    acquire() {
      for (const listener of listeners) listener(client);
    },
  };
  const context = Object.freeze({ synthetic: "argument" });
  const queryArguments = ["synthetic dispatch", Object.freeze(["not logged"])];
  const targets = {};
  for (const component of ["trace", "artifacts"]) {
    const prototype = {};
    for (const mode of ["initialize", "verify"]) {
      Object.defineProperty(prototype, mode, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: async function (...args) {
          state.actions++;
          calls.push({ component, mode, receiver: this, args });
          pool.acquire();
          pool.acquire();
          await client.query(...queryArguments);
          if (options.action) await options.action({ component, mode, pool, client });
          return result;
        },
      });
    }
    targets[component] = { prototype, instance: Object.create(prototype) };
  }
  const controller = actualModules().createUsDatasetCompleteMeasurements({
    pool,
    tracePrototype: targets.trace.prototype,
    artifactPrototype: targets.artifacts.prototype,
    emit(line) {
      if (options.emit) options.emit(line);
      assert.equal(line.startsWith("Complete seed boundary: "), true);
      assert.equal(line.endsWith("\n"), true);
      const json = line.slice("Complete seed boundary: ".length, -1);
      assert.ok(Buffer.byteLength(json) <= 512);
      records.push(JSON.parse(json));
    },
  });
  async function complete(phase = "resume", mode = "initialize") {
    return controller.withComplete(phase, mode, async () => {
      await targets.trace.instance[mode](context);
      await targets.artifacts.instance[mode](context);
      return result;
    });
  }
  async function snapshot(phase = "fresh", label = "fresh-before") {
    return controller.snapshot(phase, label, async () => {
      state.actions++;
      pool.acquire();
      await client.query(...queryArguments);
      return result;
    });
  }
  return {
    controller,
    complete,
    snapshot,
    pool,
    client,
    state,
    records,
    calls,
    targets,
    result,
    context,
    queryArguments,
    originalQuery,
    listeners,
    queryCalls,
  };
}
function measured(record, want) {
  assert.deepEqual(Object.keys(record).sort(), [
    "component",
    "driverDispatches",
    "elapsedMs",
    "mode",
    "observation",
    "outcome",
    "phase",
    "snapshot",
  ]);
  assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
  assert.equal(record.driverDispatches, 1);
  assert.deepEqual(
    { ...record, elapsedMs: 0 },
    { ...want, elapsedMs: 0, driverDispatches: 1, observation: "measured" },
  );
}
const options = { timeout: 5000, concurrency: false };

test(
  "fixed inverse/load then both sequential inner windows preserve receiver/result",
  options,
  async () => {
    preserve(native);
    for (const [from, to] of [
      ["length: 260", "length: 259"],
      ["toBe(true)", "toBe(false)"],
      ["900_000", "900_001"],
      ["60_000", "60_001"],
      ["US_TEST_DATABASE_URL", "DATABASE_URL"],
      ["observed.mutationStatements", "[]"],
    ]) {
      assert.ok(native.includes(from));
      assert.throws(() => preserve(native.replace(from, to)));
    }
    if (digest(native) !== originalRaw) {
      for (const [from, to] of [
        ['"generation", "initialize", () =>', '"generation", "verify", () =>'],
        ["store().initialize(f.context)", "store().verify(f.context)"],
        [
          "store().initialize(f.context)",
          "store().initialize({ ...f.context, tenantId: randomUUID() })",
        ],
        ["measurements.assertCanContinue();", ""],
        [
          "new UsDatasetCompleteSeedStore(observed.db, f.services)",
          "new UsDatasetCompleteSeedStore(f.db, f.services)",
        ],
        ["expect(f.writes()).toEqual(writes);", "expect(f.writes()).not.toEqual(writes);"],
        ["expect(Object.getOwnPropertyDescriptors(originalFailure)).toEqual(descriptors);", ""],
        ['snapshot("fresh", "fresh-after")', 'snapshot("fresh", "fresh-before")'],
        ['expect(await snapshot("fresh", "fresh-after")).toEqual(before);', ""],
        ['["missing", "corrupt"] as const', '["missing"] as const'],
        ["let hasCleanupFailure = false;", "let hasCleanupFailure = true;"],
        ["if (!hasCleanupFailure)", "if (!cleanupFailure)"],
        [
          "if (hasCleanupFailure) throw cleanupFailure;",
          "if (hasCleanupFailure) throw new Error();",
        ],
        ["await f.close();", "await Promise.resolve();"],
        ['"replay_verify", "verify"', '"replay_verify", "initialize"'],
        [
          "measurements?.restoreOwned();",
          "measurements?.restoreOwned(); store().initialize(f.context);",
        ],
        [
          "await track(acquisition);",
          'await track(acquisition); measurements.withComplete("resume", "initialize", () => store().initialize(f.context));',
        ],
      ]) {
        assert.ok(native.includes(from));
        assert.throws(() => preserve(native.replace(from, to)));
      }
      const file = parsed(native);
      const callback = nativeTeardownCallback(file);
      const capture = callback.body.statements[5];
      const checks = callback.body.statements[6];
      assert.ok(ts.isTryStatement(capture) && ts.isTryStatement(checks));
      const moved =
        native.slice(0, capture.getStart(file)) +
        checks.getText(file) +
        "\n" +
        capture.getText(file) +
        native.slice(checks.end);
      assert.throws(() => preserve(moved), "restore capture must precede existing teardown checks");
    }
    baselinePassed = true;
    const f = fixture();
    assert.equal(await f.complete(), f.result);
    assert.equal(f.state.on, 2);
    assert.equal(f.state.off, 2);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.client.query, f.originalQuery);
    assert.equal(f.calls.length, 2);
    for (const args of f.queryCalls) {
      assert.equal(args[0], f.queryArguments[0]);
      assert.equal(args[1], f.queryArguments[1]);
    }
    for (const [i, component] of ["trace", "artifacts"].entries()) {
      assert.equal(f.calls[i].receiver, f.targets[component].instance);
      assert.deepEqual(f.calls[i].args, [f.context]);
      measured(f.records[i], {
        phase: "resume",
        component,
        mode: "initialize",
        snapshot: null,
        outcome: "returned",
      });
    }
  },
);
test("expected original Error is counted without raw metadata", options, async () => {
  const original = new Error("synthetic_not_output");
  const f = fixture({
    action({ component }) {
      if (component === "artifacts") throw original;
    },
  });
  const outcome = await settled(() => f.complete());
  assert.equal(outcome.returned, false);
  assert.equal(outcome.value, original);
  assert.equal(f.records[1].outcome, "threw");
  assert.equal(f.records[1].driverDispatches, 1);
  assert.equal(JSON.stringify(f.records).includes("synthetic_not_output"), false);
  f.controller.assertCanContinue();
});
test("frozen Error identity and descriptors are untouched", options, async () => {
  const original = Object.freeze(new Error("synthetic_frozen"));
  const descriptors = Object.getOwnPropertyDescriptors(original);
  const f = fixture({
    action() {
      throw original;
    },
  });
  assert.equal((await settled(() => f.complete())).value, original);
  assert.deepEqual(Object.getOwnPropertyDescriptors(original), descriptors);
});
test(
  "falsy and primitive original throws survive ordinary and invalid barriers",
  options,
  async () => {
    for (const original of [undefined, null, 0, "synthetic_primitive"]) {
      for (const fail of [false, true]) {
        const f = fixture({
          action({ pool }) {
            if (fail) f.state.offFails = true;
            void pool;
            throw original;
          },
        });
        const outcome = await settled(() => f.complete());
        assert.equal(outcome.returned, false);
        assert.equal(outcome.value, original);
        if (fail) {
          const barrier = await settled(async () => f.controller.assertCanContinue());
          assert.equal(barrier.returned, false);
          assert.equal(barrier.value, original);
        } else f.controller.assertCanContinue();
      }
    }
  },
);
test(
  "counter cleanup fault preserves original and bars next entry without claiming cleanup",
  options,
  async () => {
    for (const fault of ["off", "query_restore"]) {
      const original = Object.freeze(new Error("synthetic_original"));
      const f = fixture({
        action() {
          if (fault === "off") f.state.offFails = true;
          throw original;
        },
      });
      if (fault === "query_restore") {
        let current = f.client.query;
        Object.defineProperty(f.client, "query", {
          configurable: true,
          get() {
            return current;
          },
          set(value) {
            if (value === f.originalQuery) throw new Error("synthetic_assignment_fault");
            current = value;
          },
        });
      }
      assert.equal((await settled(() => f.complete())).value, original);
      assert.equal(f.records[0].observation, "unavailable");
      const before = { ...f.state };
      assert.equal((await settled(() => f.complete())).value, original);
      assert.deepEqual(f.state, before);
      assert.equal(f.listeners.size, fault === "off" ? 1 : 0);
      assert.notEqual(f.client.query, f.originalQuery);
    }
  },
);
test(
  "cleanup faults preserve owned descriptors and actual teardown checks/error priority",
  options,
  async () => {
    const f = fixture({
      action() {
        f.state.offFails = true;
      },
    });
    const before = [
      Object.getOwnPropertyDescriptor(f.targets.trace.prototype, "initialize"),
      Object.getOwnPropertyDescriptor(f.targets.artifacts.prototype, "initialize"),
    ];
    const outcome = await settled(() => f.complete());
    assert.equal(outcome.returned, false);
    assert.match(outcome.value.message, /measurement/);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(f.targets.trace.prototype, "initialize"),
      before[0],
    );
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(f.targets.artifacts.prototype, "initialize"),
      before[1],
    );
    const calls = f.state.on;
    await settled(() => f.snapshot());
    assert.equal(f.state.on, calls);
    const makeTeardown = actualTeardownFactory();
    const activeSQL =
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND state<>'idle'";
    const sizeSQL = "SELECT pg_database_size(current_database())::text AS bytes";
    for (const original of [
      Object.freeze(new Error("synthetic_cleanup_original")),
      undefined,
      null,
      0,
    ]) {
      for (const fault of [
        "none",
        "active_query",
        "active_assertion",
        "size_query",
        "final_evidence",
        "close",
        "assertion_and_close",
      ]) {
        const observed = fixture({
          action() {
            throw original;
          },
          emit() {
            throw new Error("synthetic_metric_fault");
          },
        });
        const rejected = await settled(() => observed.complete());
        assert.equal(rejected.returned, false);
        assert.equal(rejected.value, original);
        const events = [];
        const later = Object.freeze(new Error("synthetic_later_cleanup_fault"));
        let query = 0;
        const protocol = {
          pool: {
            async query(...args) {
              assert.equal(args.length, 1);
              if (query++ === 0) {
                assert.ok(args[0] === activeSQL, "prescribed active query");
                events.push("active-query");
                if (fault === "active_query") throw later;
                return {
                  rows: [
                    { n: fault === "active_assertion" || fault === "assertion_and_close" ? 1 : 0 },
                  ],
                };
              }
              assert.equal(query, 2);
              assert.ok(args[0] === sizeSQL, "prescribed size query");
              events.push("size-query");
              if (fault === "size_query") throw later;
              return { rows: [{ bytes: "0" }] };
            },
          },
          databaseName: "synthetic_protocol_only",
          plan: { objects: new Map() },
          packages: { objects: new Map() },
          writes: () => [],
          async close() {
            events.push("close");
            if (fault === "close" || fault === "assertion_and_close") throw later;
          },
        };
        const cleanup = makeTeardown(
          undefined,
          new Set(),
          protocol,
          observed.controller,
          (value) => ({
            toEqual(expected) {
              events.push("active-assertion");
              assert.deepEqual(expected, [{ n: 0 }]);
              assert.deepEqual(value, expected);
            },
          }),
          (label) => {
            if (label === "Complete seed final measurements") {
              events.push("final-evidence");
              if (fault === "final_evidence") throw later;
            } else {
              assert.equal(label, "Disposed complete dataset database verified absent");
              events.push("disposed-evidence");
            }
          },
          {},
          performance.now(),
        );
        const outcome = await settled(cleanup);
        assert.equal(outcome.returned, false);
        assert.equal(outcome.value, original);
        const expected = ["active-query"];
        if (fault !== "active_query") expected.push("active-assertion");
        if (!["active_query", "active_assertion", "assertion_and_close"].includes(fault))
          expected.push("size-query");
        if (
          !["active_query", "active_assertion", "assertion_and_close", "size_query"].includes(fault)
        )
          expected.push("final-evidence");
        expected.push("close");
        if (fault !== "close" && fault !== "assertion_and_close")
          expected.push("disposed-evidence");
        assert.deepEqual(events, expected);
      }
    }
    // With no observer failure, real teardown errors must still propagate;
    // the original finally makes a close failure win over a check failure.
    for (const fault of [
      "none",
      "active_query",
      "active_assertion",
      "final_evidence",
      "close",
      "both",
    ]) {
      const healthy = fixture();
      const checkError = new Error("synthetic_check");
      const closeError = new Error("synthetic_close");
      let closed = 0;
      let queries = 0;
      const protocol = {
        pool: {
          async query(sql) {
            assert.ok(sql === (queries++ === 0 ? activeSQL : sizeSQL), "prescribed query order");
            if (fault === "active_query" || fault === "both") throw checkError;
            return {
              rows:
                queries === 1 ? [{ n: fault === "active_assertion" ? 1 : 0 }] : [{ bytes: "0" }],
            };
          },
        },
        databaseName: "synthetic_protocol_only",
        plan: { objects: new Map() },
        packages: { objects: new Map() },
        writes: () => [],
        async close() {
          closed++;
          if (fault === "close" || fault === "both") throw closeError;
        },
      };
      let assertionError;
      const cleanup = makeTeardown(
        undefined,
        new Set(),
        protocol,
        healthy.controller,
        (value) => ({
          toEqual(expected) {
            assert.deepEqual(expected, [{ n: 0 }]);
            try {
              assert.deepEqual(value, expected);
            } catch (error) {
              assertionError = error;
              throw error;
            }
          },
        }),
        (label) => {
          if (fault === "final_evidence" && label === "Complete seed final measurements")
            throw checkError;
        },
        {},
        performance.now(),
      );
      const outcome = await settled(cleanup);
      assert.equal(outcome.returned, fault === "none");
      const selected =
        fault === "none"
          ? undefined
          : fault === "active_query" || fault === "final_evidence"
            ? checkError
            : fault === "active_assertion"
              ? assertionError
              : closeError;
      assert.ok(outcome.value === selected, "selected teardown failure identity");
      assert.equal(closed, 1);
    }
  },
);
test("real registration failure never invokes or retries action", options, async () => {
  const f = fixture();
  f.state.onFails = true;
  assert.equal((await settled(() => f.snapshot())).returned, false);
  assert.equal(f.state.actions, 0);
  assert.equal(f.state.on, 1);
  assert.equal(f.records[0].outcome, "not_called");
  await settled(() => f.snapshot());
  assert.equal(f.state.on, 1);
  assert.equal(f.state.actions, 0);
});
test(
  "real counter instruments reused client once and forwards callback/promise query protocol",
  options,
  async () => {
    const f = fixture();
    let callbackCalls = 0;
    const value = await f.controller.snapshot("fresh", "fresh-before", async () => {
      f.pool.acquire();
      const proxy = f.client.query;
      f.pool.acquire();
      assert.equal(f.client.query, proxy);
      const callback = (error, result) => {
        assert.equal(error, null);
        assert.equal(result, f.result);
        callbackCalls++;
      };
      assert.equal(f.client.query("synthetic callback", callback), f.result);
      assert.equal(await f.client.query("synthetic promise"), f.result);
      return f.result;
    });
    assert.equal(value, f.result);
    assert.equal(callbackCalls, 1);
    assert.equal(f.records[0].driverDispatches, 2);
    assert.equal(f.client.query, f.originalQuery);
    assert.equal(f.listeners.size, 0);
    const original = new Error("synthetic_expected");
    assert.equal(
      (
        await settled(() =>
          f.controller.snapshot("fresh", "fresh-after", async () => {
            f.pool.acquire();
            await f.client.query("synthetic");
            throw original;
          }),
        )
      ).value,
      original,
    );
    assert.equal(f.records[1].driverDispatches, 1);
    assert.equal(f.client.query, f.originalQuery);
  },
);
test(
  "existing observer and corrupted descriptor retain exact ownership independently",
  options,
  async () => {
    const original = Object.freeze(new Error("synthetic_observed_original"));
    const originalDescriptors = Object.getOwnPropertyDescriptors(original);
    const f = fixture({
      action({ component }) {
        if (component === "artifacts") throw original;
      },
    });
    const proto = f.targets.artifacts.prototype;
    const actual = proto.initialize;
    let forwarded = 0;
    let observed;
    const spy = async function (...args) {
      forwarded++;
      try {
        return await Reflect.apply(actual, this, args);
      } catch (error) {
        observed = error;
        throw error;
      }
    };
    Object.defineProperty(proto, "initialize", {
      value: spy,
      configurable: true,
      writable: true,
      enumerable: true,
    });
    const exact = Object.getOwnPropertyDescriptor(proto, "initialize");
    assert.equal((await settled(() => f.complete())).value, original);
    assert.equal(forwarded, 1);
    assert.equal(observed, original);
    assert.deepEqual(Object.getOwnPropertyDescriptors(original), originalDescriptors);
    assert.deepEqual(Object.getOwnPropertyDescriptor(proto, "initialize"), exact);
    const g = fixture();
    const artifactBefore = Object.getOwnPropertyDescriptor(
      g.targets.artifacts.prototype,
      "initialize",
    );
    const unknown = () => "unknown";
    const outcome = await settled(() =>
      g.controller.withComplete("resume", "initialize", async () => {
        Object.defineProperty(g.targets.trace.prototype, "initialize", { value: unknown });
        return g.result;
      }),
    );
    assert.equal(outcome.returned, false);
    assert.equal(g.targets.trace.prototype.initialize, unknown);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(g.targets.artifacts.prototype, "initialize"),
      artifactBefore,
    );
    assert.equal((await settled(() => g.snapshot())).returned, false);
    assert.equal(g.state.actions, 0);
    for (const thrown of [
      Object.freeze(new Error("synthetic_outer_original")),
      undefined,
      null,
      0,
    ]) {
      const h = fixture();
      const before = Object.getOwnPropertyDescriptor(h.targets.artifacts.prototype, "initialize");
      const outcome = await settled(() =>
        h.controller.withComplete("resume", "initialize", async () => {
          await h.targets.trace.instance.initialize(h.context);
          await h.targets.artifacts.instance.initialize(h.context);
          Object.defineProperty(h.targets.trace.prototype, "initialize", { value: unknown });
          throw thrown;
        }),
      );
      assert.equal(outcome.returned, false);
      assert.equal(outcome.value, thrown);
      const barrier = await settled(async () => h.controller.assertCanContinue());
      assert.equal(barrier.returned, false);
      assert.equal(barrier.value, thrown);
      assert.equal(h.targets.trace.prototype.initialize, unknown);
      assert.deepEqual(
        Object.getOwnPropertyDescriptor(h.targets.artifacts.prototype, "initialize"),
        before,
      );
    }
  },
);
test(
  "actual closed validator rejects malformed combinations and never touches hostile errors",
  options,
  async () => {
    const parse = actualModules().parseUsDatasetCompleteBoundary;
    const good = {
      phase: "fresh",
      component: "snapshot",
      mode: "snapshot",
      snapshot: "fresh-before",
      observation: "measured",
      outcome: "returned",
      elapsedMs: 0,
      driverDispatches: 0,
    };
    assert.deepEqual(parse(good), good);
    for (const patch of [
      { extra: true },
      { phase: "unknown" },
      { component: "unknown" },
      { mode: "verify" },
      { snapshot: null },
      { elapsedMs: Infinity },
      { elapsedMs: -1 },
      { driverDispatches: NaN },
      { driverDispatches: -1 },
      { driverDispatches: 0.5 },
      { observation: "unavailable" },
      { outcome: "not_called" },
    ])
      assert.throws(() => parse({ ...good, ...patch }));
    let touched = 0;
    const hostile = Object.create(null, {
      cause: {
        get() {
          touched++;
          throw 0;
        },
      },
    });
    const f = fixture({
      action() {
        throw hostile;
      },
    });
    assert.equal((await settled(() => f.complete())).value, hostile);
    assert.equal(touched, 0);
  },
);
const sequence = [
  ["fresh", "fresh-before"],
  ["fresh", "fresh-after"],
  ["generation", "initialize", "threw"],
  ["pending", "pending-before"],
  ["pending", "verify", "threw"],
  ["pending", "pending-after"],
  ["resume", "initialize"],
  ["queued_baseline", "completed-before"],
  ["replay_initialize", "initialize"],
  ["replay_initialize", "completed-initialize-after"],
  ["replay_verify", "verify"],
  ["replay_verify", "completed-verify-after"],
  ["wrong_tenant", "refusal-before"],
  ["wrong_tenant", "refusal-after"],
  ["owner_revoked", "refusal-before"],
  ["owner_revoked", "refusal-after"],
  ["profile_changed", "refusal-before"],
  ["profile_changed", "refusal-after"],
  ["native_drift", "drift-before"],
  ["native_drift", "drift-after"],
  ["missing", "missing-before"],
  ["missing", "verify", "threw"],
  ["missing", "missing-after"],
  ["corrupt", "corrupt-before"],
  ["corrupt", "verify", "threw"],
  ["corrupt", "corrupt-after"],
];
test(
  "independent complete sequence and bounded ledger reject omissions/order/outcome/overflow",
  options,
  async () => {
    async function run(steps) {
      let shouldThrow = false;
      const f = fixture({
        action({ component }) {
          if (shouldThrow && component === "artifacts") throw 0;
        },
      });
      for (const [phase, operation, outcome] of steps) {
        if (["initialize", "verify"].includes(operation)) {
          shouldThrow = outcome === "threw";
          await settled(() => f.complete(phase, operation));
        } else await f.snapshot(phase, operation);
      }
      return f;
    }
    const f = await run(sequence);
    f.controller.assertComplete();
    assert.equal(f.records.length, 33);
    const expected = sequence.flatMap(([phase, operation, outcome]) =>
      ["initialize", "verify"].includes(operation)
        ? [
            [phase, "trace", operation, null, "returned"],
            [phase, "artifacts", operation, null, outcome ?? "returned"],
          ]
        : [[phase, "snapshot", "snapshot", operation, "returned"]],
    );
    assert.deepEqual(
      f.records.map((r) => [r.phase, r.component, r.mode, r.snapshot, r.outcome]),
      expected,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(f.records)) <= 20 * 1024);
    for (const steps of [
      sequence.slice(1),
      [sequence[0], ...sequence],
      [sequence[1], sequence[0], ...sequence.slice(2)],
      sequence.map((step, i) => (i === 2 ? step.slice(0, 2) : step)),
    ]) {
      const bad = await run(steps);
      assert.throws(() => bad.controller.assertComplete());
    }
    const overflow = fixture();
    for (let i = 0; i < 40; i++) await overflow.snapshot();
    const before = { ...overflow.state };
    assert.equal((await settled(() => overflow.snapshot())).returned, false);
    assert.equal(overflow.records.length, 40);
    assert.deepEqual(overflow.state, before);
  },
);
test(
  "emission failure preserves original and bars next observation with no output fallback",
  options,
  async () => {
    const original = new Error("synthetic_original");
    let writes = 0;
    const f = fixture({
      action() {
        throw original;
      },
      emit() {
        writes++;
        throw new Error("synthetic_output_fault");
      },
    });
    const descriptor = Object.getOwnPropertyDescriptor(f.targets.artifacts.prototype, "initialize");
    assert.equal((await settled(() => f.complete())).value, original);
    assert.equal((await settled(() => f.snapshot())).value, original);
    assert.equal(writes, 1);
    assert.equal(f.records.length, 0);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(f.targets.artifacts.prototype, "initialize"),
      descriptor,
    );
  },
);
