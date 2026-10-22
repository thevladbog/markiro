import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import {
  activateUsRequestVerificationFrame as activate,
  closeUsRequestVerificationFrame as close,
  createUsRequestVerificationFrame as create,
  enterUsRequestVerificationOperation as enter,
  finalizeUsRequestVerificationFailure as finalize,
  projectUsRequestVerificationFailure as project,
  takeUsRequestVerificationFailure as take,
} from "../src/modules/traceability/requests/us-request-verification-failure";
import { usDatasetCommandDiagnostic } from "../src/deployment/us-dataset-command-runtime";
import {
  takeUsRequestPackageStorageReadFailure as takeStorage,
  takeUsRequestPackageTransportWitness as takeWitness,
} from "../src/modules/traceability/requests/us-request-package-artifacts";
import { createUsRequestWorkerStorageFixture } from "./support/us-request-worker-storage-fixture";

const diagnostic = {
  code: "us_dataset_command_failed",
  unitKey: "request_september",
  stage: "package",
};
// Independent closed fixtures, not imported production lists.
const scalarOperations = [
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
];
const artifacts = [
  "manifest.json",
  "package.zip",
  "plan.pdf",
  "records.xlsx",
  "request-report.pdf",
  "validation.json",
];
function ready(operation: unknown = "read_plan", artifact?: unknown) {
  const frame = create("request_september");
  expect(frame).toBeDefined();
  activate(frame);
  enter(frame, operation, artifact);
  return frame;
}

it("emits storage evidence only for the same authentic error and consumed canonical private-read frame", async () => {
  const path = "apps/api/src/main.us-dataset.ts";
  const ast = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
  let callback: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch"
    ) {
      const first = node.arguments[0];
      if (first && ts.isArrowFunction(first)) callback = first;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!callback) throw new Error("actual main catch missing");
  const js = ts.transpileModule(`const callback = ${callback.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const invoke = (error: unknown) => {
    let output = "";
    const capture = {
      stderr: {
        write(value: string) {
          output += value;
        },
      },
      exitCode: 0,
    };
    const call = compileFunction(`${js};return callback;`, [
      "process",
      "usDatasetCommandDiagnostic",
      "takeUsRequestVerificationFailure",
      "takeUsRequestPackageStorageReadFailure",
      "takeUsRequestPackageTransportWitness",
    ])(capture, usDatasetCommandDiagnostic, take, takeStorage, takeWitness);
    call(error);
    expect(capture.exitCode).toBe(1);
    expect(output).not.toMatch(/private sentinel/);
    return JSON.parse(output) as Record<string, unknown>;
  };
  const authentic = async (unitKey = "request_september", transport = false) => {
    const s = createUsRequestWorkerStorageFixture(() => ({
      async send() {
        if (transport) throw { code: "ECONNRESET", message: "private sentinel" };
        throw new Error("private sentinel");
      },
    }));
    const scope = {
      tenantId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
    };
    const attemptId = "33333333-3333-4333-8333-333333333333";
    try {
      await s.store.readVerified(scope, {
        ...scope,
        attemptId,
        id: "44444444-4444-4444-8444-444444444444",
        name: "manifest.json",
        kind: "manifest",
        objectKey: `us/requests/${scope.tenantId}/${scope.runId}/${attemptId}/manifest.json`,
        mediaType: "application/json",
        byteSize: 1,
        sha256: "a".repeat(64),
      });
      throw new Error("actual read did not fail");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !==
          (transport
            ? "us_request_package_storage_transport_failed"
            : "us_request_package_storage_read_failed")
      )
        throw error;
      return Object.assign(error, { unitKey, stage: "package" });
    } finally {
      s.destroy();
    }
  };
  const transportError = await authentic("request_september", true);
  finalize(ready("read_private_object", "manifest.json"), transportError);
  Object.freeze(transportError);
  const transportDescriptors = Object.getOwnPropertyDescriptors(transportError);
  expect(invoke(transportError)).toEqual({
    ...diagnostic,
    verificationFailure: { operation: "read_private_object", artifact: "manifest.json" },
    verificationStorageCode: "us_request_package_storage_transport_failed",
    verificationTransportWitness: "await_send:code:ECONNRESET",
  });
  expect(takeWitness(transportError)).toBeUndefined();
  expect(Object.getOwnPropertyDescriptors(transportError)).toEqual(transportDescriptors);
  for (const variant of [
    "no-frame",
    "consumed",
    "ambiguous",
    "wrong-operation",
    "wrong-stage",
    "wrong-unit",
    "specific",
    "wrong-storage-code",
  ]) {
    const error = await authentic(
      variant === "wrong-unit" ? "chain_0259" : "request_september",
      true,
    );
    if (variant === "wrong-stage") Object.assign(error, { stage: "request" });
    if (variant === "specific")
      Object.defineProperty(error, "message", { value: "us_dataset_request_conflict" });
    if (variant !== "no-frame")
      finalize(
        ready(
          variant === "wrong-operation" ? "run_worker" : "read_private_object",
          variant === "wrong-operation" ? undefined : "manifest.json",
        ),
        error,
      );
    if (variant === "consumed") take(error, diagnostic);
    if (variant === "ambiguous") finalize(ready("read_private_object", "manifest.json"), error);
    if (variant === "wrong-storage-code") takeStorage(error);
    expect(invoke(error)).not.toHaveProperty("verificationTransportWitness");
    expect(takeWitness(error)).toBeUndefined();
  }
  for (const unit of ["request_scenario_a", "request_april", "request_september"])
    for (const artifact of artifacts) {
      const error = await authentic(unit);
      const frame = create(unit);
      activate(frame);
      enter(frame, "read_private_object", artifact);
      finalize(frame, error);
      const descriptors = Object.getOwnPropertyDescriptors(error);
      expect(invoke(error)).toEqual({
        code: "us_dataset_command_failed",
        unitKey: unit,
        stage: "package",
        verificationFailure: { operation: "read_private_object", artifact },
        verificationStorageCode: "us_request_package_storage_read_failed",
      });
      expect(Object.getOwnPropertyDescriptors(error)).toEqual(descriptors);
      expect(takeStorage(error)).toBeUndefined();
      expect(take(error, { ...diagnostic, unitKey: unit })).toBeUndefined();
      finalize(ready("read_private_object", artifact), error);
      expect(invoke(error)).not.toHaveProperty("verificationStorageCode");
    }
  for (const variant of [
    "no-frame",
    "consumed",
    "wrong-operation",
    "invalid-artifact",
    "other-error",
    "ambiguous",
    "wrong-unit",
    "wrong-stage",
    "specific",
    "forged",
  ]) {
    const original = await authentic(variant === "wrong-unit" ? "chain_0259" : "request_september");
    const error =
      variant === "forged"
        ? Object.assign(new Error(original.message), {
            unitKey: "request_september",
            stage: "package",
          })
        : original;
    if (variant === "specific")
      Object.defineProperty(error, "message", { value: "us_dataset_request_conflict" });
    if (variant === "wrong-stage") Object.assign(error, { stage: "request" });
    if (variant !== "no-frame") {
      finalize(
        ready(
          variant === "wrong-operation" ? "compare_private_object" : "read_private_object",
          variant === "invalid-artifact" ? "private/key" : "manifest.json",
        ),
        variant === "other-error" ? {} : error,
      );
      if (variant === "consumed") take(error, diagnostic);
      if (variant === "ambiguous") finalize(ready("read_private_object", "manifest.json"), error);
    }
    expect(invoke(error)).not.toHaveProperty("verificationStorageCode");
    expect(takeStorage(error)).toBe(
      variant === "forged" ? undefined : "us_request_package_storage_read_failed",
    );
  }
  const imports = ast.statements
    .filter(ts.isImportDeclaration)
    .filter((node) => node.moduleSpecifier.getText(ast).includes("us-request-package-artifacts"));
  expect(imports).toHaveLength(1);
  expect(imports[0]?.importClause?.namedBindings?.getText(ast)).toBe(
    "{\n  takeUsRequestPackageStorageReadFailure,\n  takeUsRequestPackageTransportWitness,\n}",
  );
});
function hostile() {
  let accesses = 0;
  const hit = () => {
    accesses++;
    throw new Error("private sentinel");
  };
  return {
    proxy: new Proxy(
      {},
      { get: hit, getPrototypeOf: hit, ownKeys: hit, getOwnPropertyDescriptor: hit, has: hit },
    ),
    accessor: Object.defineProperty({}, "operation", { get: hit, enumerable: true }),
    count: () => accesses,
  };
}

it("projects all nineteen operations with only their valid artifacts into fresh owned tuples", () => {
  for (const operation of scalarOperations) {
    const value = Object.freeze({ operation });
    expect(project(value)).toEqual({ operation });
    expect(project(value)).not.toBe(value);
  }
  for (const operation of ["read_private_object", "compare_private_object"])
    for (const artifact of artifacts) {
      const value = Object.freeze({ operation, artifact });
      expect(project(value)).toEqual({ operation, artifact });
      expect(project(value)).not.toBe(value);
    }
  expect(project({ operation: "verify_private_archive", artifact: "package.zip" })).toEqual({
    operation: "verify_private_archive",
    artifact: "package.zip",
  });
});

it("rejects malformed or hostile tuples without getters, proxy traps or inherited fields", () => {
  const trap = hostile();
  for (const value of [
    null,
    1,
    "read_plan",
    [],
    trap.proxy,
    trap.accessor,
    Object.create({ operation: "read_plan" }),
    Object.assign(Object.create({ extra: true }), { operation: "read_plan" }),
    { operation: "read_plan", extra: "private" },
    { operation: "read_plan", [Symbol("private")]: true },
    { operation: "read_plan", artifact: undefined },
    { operation: "unknown" },
    { operation: "read_private_object" },
    { operation: "compare_private_object", artifact: "private/key" },
    { operation: "verify_private_archive", artifact: "plan.pdf" },
    ...scalarOperations.map((operation) => ({ operation, artifact: "package.zip" })),
  ])
    expect(project(value)).toBeUndefined();
  expect(trap.count()).toBe(0);
});

it("looks up private frame identity before touching forged, accessor or proxy handles", () => {
  const trap = hostile();
  for (const frame of [null, 1, {}, trap.proxy, trap.accessor]) {
    activate(frame);
    enter(frame, "read_plan");
    close(frame);
    finalize(frame, trap.proxy);
  }
  expect(take(trap.proxy, diagnostic)).toBeUndefined();
  expect(trap.count()).toBe(0);
});

it("refuses invalid units and inactive frames without retaining a usable boundary", () => {
  const trap = hostile();
  for (const unit of [undefined, trap.proxy, "chain_0259", "request_october"])
    expect(create(unit)).toBeUndefined();
  const frame = create("request_september");
  enter(frame, "read_plan");
  const error = {};
  finalize(frame, error);
  expect(take(error, diagnostic)).toBeUndefined();
  expect(trap.count()).toBe(0);
});

it("retains only the last entered boundary for each activated canonical Request frame", () => {
  for (const unitKey of ["request_scenario_a", "request_april", "request_september"]) {
    const frame = create(unitKey);
    activate(frame);
    enter(frame, "package_stage");
    enter(frame, "read_plan");
    const error = new Error("unchanged");
    finalize(frame, error);
    expect(take(error, { ...diagnostic, unitKey })).toEqual({ operation: "read_plan" });
    expect(take(error, { ...diagnostic, unitKey })).toBeUndefined();
  }
});

it("clears prior artifact on every transition, including invalid combinations", () => {
  for (const operation of ["final_publication_probe", "commit_package_receipt"]) {
    const frame = ready("read_private_object", "records.xlsx");
    enter(frame, operation);
    const error = {};
    finalize(frame, error);
    expect(take(error, diagnostic)).toEqual({ operation });
  }
  for (const [operation, artifact] of [
    [undefined, undefined],
    ["unknown", undefined],
    ["read_plan", "package.zip"],
    ["read_private_object", undefined],
  ]) {
    const frame = ready("read_private_object", "records.xlsx");
    enter(frame, operation, artifact);
    const error = {};
    finalize(frame, error);
    expect(take(error, diagnostic)).toBeUndefined();
  }
});

it("closes successful invocations so later transitions or finalization cannot attach detail", () => {
  const frame = ready();
  close(frame);
  activate(frame);
  enter(frame, "assemble_package");
  const error = {};
  finalize(frame, error);
  expect(take(error, diagnostic)).toBeUndefined();
});

it("finalizes once by exact error identity without reading or changing any error metadata", () => {
  const trap = hostile();
  const cause = { private: true };
  class PrivateError extends Error {}
  const ordinary = new PrivateError("private message", { cause });
  const accessor = Object.defineProperty(new Error("accessor"), "cause", {
    get() {
      throw new Error("must not read");
    },
  });
  for (const error of [
    ordinary,
    Object.freeze(new Error("frozen")),
    accessor,
    trap.proxy,
    Object.create(trap.proxy),
    () => undefined,
  ]) {
    const descriptors = error === trap.proxy ? undefined : Object.getOwnPropertyDescriptors(error);
    const frame = ready();
    finalize(frame, error);
    finalize(frame, error);
    expect(take(Object.create(error), diagnostic)).toBeUndefined();
    expect(take(error, diagnostic)).toEqual({ operation: "read_plan" });
    if (descriptors) expect(Object.getOwnPropertyDescriptors(error)).toEqual(descriptors);
  }
  expect(ordinary).toBeInstanceOf(PrivateError);
  expect(ordinary.cause).toBe(cause);
  expect(ordinary.message).toBe("private message");
  expect(trap.count()).toBe(0);
  for (const primitive of [null, undefined, "private", 1, Symbol("private")]) {
    finalize(ready(), primitive);
    expect(take(primitive, diagnostic)).toBeUndefined();
  }
});

it("keeps concurrent frames independent and suppresses distinct unconsumed frame ambiguity", () => {
  const a = ready("render_payloads"),
    b = ready("read_plan");
  const first = {},
    second = {};
  finalize(b, second);
  finalize(a, first);
  expect(take(first, diagnostic)).toEqual({ operation: "render_payloads" });
  expect(take(second, diagnostic)).toEqual({ operation: "read_plan" });
  for (const invalid of ["active", "inactive", "invalid"]) {
    for (const reverse of [false, true]) {
      const error = {},
        valid = ready(),
        other = create("request_september");
      if (invalid !== "inactive") activate(other);
      enter(other, invalid === "invalid" ? "unknown" : "assemble_package");
      const order = reverse ? [other, valid] : [valid, other];
      for (const frame of order) finalize(frame, error);
      finalize(ready("bind_inputs"), error);
      expect(take(error, diagnostic)).toBeUndefined();
      expect(take(error, diagnostic)).toBeUndefined();
      finalize(ready("assemble_package"), error);
      expect(take(error, diagnostic)).toEqual({ operation: "assemble_package" });
    }
  }
});

it("consumes every take including denied and malformed matches, allowing only fresh-frame reuse", () => {
  const trap = hostile();
  for (const value of [
    null,
    trap.proxy,
    trap.accessor,
    { ...diagnostic, extra: true },
    { ...diagnostic, code: "us_dataset_request_conflict" },
    { ...diagnostic, unitKey: "request_april" },
    { ...diagnostic, stage: "request" },
    Object.create(diagnostic),
  ]) {
    const error = {};
    finalize(ready(), error);
    expect(take(error, value)).toBeUndefined();
    expect(take(error, diagnostic)).toBeUndefined();
    finalize(ready("bind_inputs"), error);
    expect(take(error, diagnostic)).toEqual({ operation: "bind_inputs" });
  }
  expect(trap.count()).toBe(0);
});

it("ignores forged public metadata and preserves old sanitizer category and canonical location priority", () => {
  const error = Object.assign(new Error("us_dataset_request_conflict"), {
    unitKey: "request_september",
    stage: "package",
    verificationFailure: { operation: "read_plan" },
  });
  const safe = usDatasetCommandDiagnostic(error);
  expect(safe).toEqual({
    code: "us_dataset_request_conflict",
    unitKey: "request_september",
    stage: "package",
  });
  expect(take(error, diagnostic)).toBeUndefined();
  finalize(ready(), error);
  expect(take(error, safe)).toBeUndefined();
  expect(take(error, diagnostic)).toBeUndefined();
});

const demo = "apps/api/src/modules/traceability/demo/";
function source(path: string) {
  return readFileSync(`../../${path}`, "utf8");
}
function restored(path: string) {
  const ast = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
  const edits: [number, number, string][] = [];
  const calls: string[] = [];
  function walk(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier.getText(ast).includes("us-request-verification-failure")
    ) {
      edits.push([node.getFullStart(), node.end, ""]);
      return;
    }
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((d) => d.name.getText(ast) === "frame")
    ) {
      edits.push([node.getFullStart(), node.end, ""]);
      return;
    }
    if (ts.isExpressionStatement(node)) {
      const expression = node.expression;
      const call = ts.isCallExpression(expression)
        ? expression
        : ts.isBinaryExpression(expression) && ts.isCallExpression(expression.right)
          ? expression.right
          : undefined;
      if (
        call &&
        /^(createUsRequestVerificationFrame|activateUsRequestVerificationFrame|enterUsRequestVerificationOperation|closeUsRequestVerificationFrame|finalizeUsRequestVerificationFailure)$/.test(
          call.expression.getText(ast),
        )
      ) {
        calls.push(
          call.expression.getText(ast) + ":" + call.arguments.map((a) => a.getText(ast)).join(","),
        );
        edits.push([node.getFullStart(), node.end, ""]);
        return;
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "verifyRequestBytes") {
      const third = node.arguments[2],
        fourth = node.arguments[3];
      if (third && fourth) {
        expect(fourth.getText(ast)).toBe("frame");
        edits.push([third.end, fourth.end, ""]);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "verifyRequestBytes") {
      const third = node.parameters[2],
        fourth = node.parameters[3];
      if (third && fourth) {
        expect(fourth.getText(ast)).toBe("frame: UsRequestVerificationFrame | undefined");
        edits.push([third.end, fourth.end, ""]);
      }
    }
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(ast) === 'descriptor.name === "package.zip"' &&
      ts.isBlock(node.thenStatement)
    ) {
      edits.push([node.thenStatement.getStart(ast), node.thenStatement.getStart(ast) + 1, ""]);
      edits.push([node.thenStatement.end - 1, node.thenStatement.end, ""]);
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  let text = source(path);
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0]))
    text = text.slice(0, start) + replacement + text.slice(end);
  return {
    calls,
    ast: ts
      .createPrinter({ removeComments: true })
      .printFile(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)),
  };
}
it("restores every original seed/verification statement and preserves successful main output while adding the exact boundaries", () => {
  const seed = restored(demo + "us-dataset-request-seed.ts");
  const verify = restored(demo + "us-dataset-request-verify.ts");
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  // Independently derived from complete pre-Task7 modules at338729dd8. No Git
  // history is needed on CI's shallow checkout, and committing cannot move the baseline.
  expect(digest(seed.ast)).toBe("af989059034a6299cc614dde7cb338eaca0d69f21dd3a7a2ea54c17d8ba29089");
  expect(digest(verify.ast)).toBe(
    "94494cd9660caf3b347fd2e9c0761aeff3d31fdb522f7850bc0d05d4db2bfb31",
  );
  const entered = [...seed.calls, ...verify.calls].filter((c) =>
    c.startsWith("enterUsRequestVerificationOperation:"),
  );
  expect(entered).toHaveLength(19);
  for (const operation of [
    ...scalarOperations,
    "read_private_object",
    "compare_private_object",
    "verify_private_archive",
  ])
    expect(entered.filter((c) => c.includes(`"${operation}"`))).toHaveLength(1);
  expect(seed.calls.filter((c) => c.startsWith("closeUsRequestVerificationFrame:"))).toHaveLength(
    2,
  );
  expect(
    seed.calls.filter((c) => c.startsWith("finalizeUsRequestVerificationFailure:")),
  ).toHaveLength(1);
  const nextOperations: Record<string, string> = {
    package_stage: "let packageStage = await this.journal.readStage",
    validate_request: "const validation = await new UsRequestValidationStore",
    prepare_package: "packageStage = await this.journal.prepareStageIntent",
    probe_before_worker: "let live = await probe()",
    run_worker: "const lifecycle = new UsRequestWorkerLifecycle",
    probe_after_worker: "live = await probe()",
    render_payloads: "const payloads = await renderUsRequestPayloads",
    read_plan: "const plan = await new UsRequestPlanReader",
    bind_inputs: "const inputs = bindUsRequestPackageInputs",
    check_checkpoint: "new UsRequestWorkerCheckpoints",
    assemble_package: "const reproduced = await assembleUsRequestPackage",
    compare_manifest: "equalRequest(reproduced.manifest",
    compare_entries: "equalRequest(",
    compare_archive: "const { bytes: zipBytes, ...zip }",
    read_private_object: "const expected =",
    compare_private_object: "if (!bytes.equals(expected))",
    verify_private_archive: "verifyUsRequestPackageArchive(bytes",
    final_publication_probe: "const final = await probe()",
    commit_package_receipt: "const receipt = resultReceipt",
  };
  for (const path of [demo + "us-dataset-request-seed.ts", demo + "us-dataset-request-verify.ts"]) {
    const ast = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
    function placement(node: ts.Node) {
      if (ts.isBlock(node))
        for (const [index, statement] of node.statements.entries()) {
          if (
            !ts.isExpressionStatement(statement) ||
            !ts.isCallExpression(statement.expression) ||
            statement.expression.expression.getText(ast) !== "enterUsRequestVerificationOperation"
          )
            continue;
          const operation = statement.expression.arguments[1];
          if (!operation || !ts.isStringLiteral(operation)) throw new Error("nonliteral operation");
          const next = node.statements[index + 1];
          expect(next?.getText(ast).startsWith(nextOperations[operation.text] ?? "NO MATCH")).toBe(
            true,
          );
        }
      ts.forEachChild(node, placement);
    }
    placement(ast);
  }
  function main(text: string) {
    const ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
    return ast.statements
      .find((n) => ts.isFunctionDeclaration(n) && n.name?.text === "main")
      ?.getText(ast);
  }
  const success = main(source("apps/api/src/main.us-dataset.ts"));
  if (!success) throw new Error("actual success main missing");
  expect(digest(success)).toBe("4731388938655ceb5569ca6ffa30ae09b86da4de0f1e63f52c5679e6706a10f2");
  const mainAst = ts.createSourceFile(
    "main.ts",
    source("apps/api/src/main.us-dataset.ts"),
    ts.ScriptTarget.Latest,
    true,
  );
  let callback: ts.ArrowFunction | undefined;
  function findCatch(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch"
    ) {
      const first = node.arguments[0];
      if (first && ts.isArrowFunction(first)) callback = first;
    }
    ts.forEachChild(node, findCatch);
  }
  findCatch(mainAst);
  if (!callback) throw new Error("actual main catch missing");
  const js = ts.transpileModule(`const callback = ${callback.getText(mainAst)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const code of ["private unknown", "us_dataset_request_conflict"]) {
    let output = "";
    const processCapture = {
      stderr: {
        write: (value: string) => {
          output += value;
        },
      },
      exitCode: 0,
    };
    const invoke = compileFunction(`${js}; return callback;`, [
      "process",
      "usDatasetCommandDiagnostic",
      "takeUsRequestVerificationFailure",
      "takeUsRequestPackageStorageReadFailure",
      "takeUsRequestPackageTransportWitness",
    ])(processCapture, usDatasetCommandDiagnostic, take, takeStorage, takeWitness);
    const error = Object.assign(new Error(code), {
      unitKey: "request_september",
      stage: "package",
    });
    finalize(ready(), error);
    invoke(error);
    expect(JSON.parse(output)).toEqual(
      code === "private unknown"
        ? { ...diagnostic, verificationFailure: { operation: "read_plan" } }
        : { ...diagnostic, code },
    );
    expect(processCapture.exitCode).toBe(1);
    expect(take(error, diagnostic)).toBeUndefined();
  }
});
