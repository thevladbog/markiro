import assert from "node:assert/strict";
import { Script } from "node:vm";
import ts from "typescript";

function descendants(node, predicate) {
  const found = [];
  const visit = (child) => {
    if (predicate(child)) found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
    return name.elements.flatMap((element) =>
      ts.isBindingElement(element) ? bindingNames(element.name) : [],
    );
  return [];
}

function bindings(source, name) {
  return descendants(source, (node) => {
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isImportClause(node) ||
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportEqualsDeclaration(node)
    )
      return node.name && bindingNames(node.name).includes(name);
    return false;
  });
}

function isFixtureExpression(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "US_TEST_DATABASE_URL" &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "env" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process"
  );
}

// Resolve only an immutable, unique top-level fixture binding. Counting all
// declaration bindings also rejects nested, parameter and destructured shadows.
export function assertNativeFixtureGate(text, file, fixture) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  assert.equal(source.parseDiagnostics.length, 0, `${file} parses as TypeScript`);
  const gates = descendants(
    source,
    (node) => ts.isCallExpression(node) && node.expression.getText(source) === "describe.skipIf",
  );
  assert.equal(gates.length, 1, `${file} has one native fixture gate`);
  const gate = gates[0];
  assert.ok(
    ts.isCallExpression(gate.parent) &&
      gate.parent.expression === gate &&
      ts.isExpressionStatement(gate.parent.parent) &&
      gate.parent.parent.parent === source,
    `${file} fixture gate owns a top-level suite`,
  );
  assert.equal(gate.arguments.length, 1, `${file} has one fixture predicate`);
  const predicate = gate.arguments[0];
  assert.ok(
    ts.isPrefixUnaryExpression(predicate) && predicate.operator === ts.SyntaxKind.ExclamationToken,
    `${file} negates the native fixture`,
  );
  const operand = predicate.operand;
  let alias;
  if (ts.isIdentifier(operand)) {
    alias = operand.text;
    const declarations = bindings(source, alias);
    assert.equal(declarations.length, 1, `${file} fixture binding is unique without shadows`);
    const declaration = declarations[0];
    assert.ok(
      ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
        ts.isVariableStatement(declaration.parent.parent) &&
        declaration.parent.parent.parent === source,
      `${file} fixture binding is a top-level const`,
    );
    assert.ok(
      declaration.initializer && isFixtureExpression(declaration.initializer),
      `${file} fixture is exactly US_TEST_DATABASE_URL`,
    );
  } else assert.ok(isFixtureExpression(operand), `${file} fixture is exactly US_TEST_DATABASE_URL`);
  assert.equal(bindings(source, "process").length, 0, `${file} process is not shadowed`);
  const shouldSkip = new Script(
    `((${alias ? `${alias}, ` : ""}process) => (${predicate.getText(source)}))`,
  ).runInNewContext();
  const evaluate = (value, env) => (alias ? shouldSkip(value, { env }) : shouldSkip({ env }));
  assert.equal(evaluate(undefined, {}), true, `${file} skips aggregate fixture-free collection`);
  assert.equal(
    evaluate(fixture, { US_TEST_DATABASE_URL: fixture }),
    false,
    `${file} executes with the dedicated fixture`,
  );
}
