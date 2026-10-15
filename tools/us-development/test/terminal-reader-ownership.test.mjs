import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const owner = new URL(
  "../../../apps/api/src/modules/traceability/demo/us-dataset-native-final-verify.ts",
  import.meta.url,
);
const source = readFileSync(owner, "utf8");
const slots = [
  "parties",
  "lots",
  "documents",
  "events",
  "receivingRoots",
  "transformationRoots",
  "shippingRoots",
  "protectedParties",
  "protectedLots",
  "protectedDocuments",
  "protectedEvents",
  "protectedReceivingRoots",
  "protectedTransformationRoots",
  "protectedShippingRoots",
];

function inspect(text) {
  const file = ts.createSourceFile("owner.ts", text, ts.ScriptTarget.Latest, true);
  let method;
  const visit = (node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(file) === "#verifyTerminalProjection")
      method = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(method?.body, "runtime-private terminal owner is required");
  assert.equal(
    method.parameters.length,
    5,
    "the owner cannot accept caller reader/proof arguments",
  );
  const body = method.body.getText(file);
  assert.match(body, /finally\s*\{/, "slot lifetime must end on every exit");
  assert.match(body, /active = false/, "readers must be revoked");
  assert.match(body, /!active/, "every boundary must reject inactive ownership");
  assert.match(body, /profile = undefined/, "profile must be cleared");
  for (const slot of slots) assert.ok(body.includes(`${slot}.clear()`), `${slot} must be cleared`);
  assert.match(
    body,
    /readShippingRevisionsCore\(/,
    "revision reads must retain native-core routing",
  );
  assert.doesNotMatch(
    body,
    /new WeakMap|\.transaction\(|\.insert\(|\.update\(|\.delete\(|setTimeout\(|queueMicrotask\(|Promise\.all|\.query\s*=/,
    "closed verifier cannot write or escape into concurrent work",
  );
  assert.doesNotMatch(
    body,
    /return\s+(?:dependencies|points|readers|locks)\s*;/,
    "reader objects cannot escape",
  );
  assert.match(body, /candidate !== tx/, "transaction identity must be exact");
  assert.match(body, /tenantId !== checked.tenantId/, "tenant identity must be bound");
  assert.match(body, /actorUserId !== checked.actorUserId/, "actor identity must be bound");
  assert.match(
    body,
    /context.expectedDatabaseName !== checked.expectedDatabaseName/,
    "database must be bound",
  );
  assert.match(
    body,
    /context.expectedDatabaseUser !== checked.expectedDatabaseUser/,
    "database role must be bound",
  );
  return body;
}

test("closed reader confinement rejects authority, lifetime, mutation and escape mutants", () => {
  inspect(source);
  const mutations = [
    ["runtime visibility", source.replace("#verifyTerminalProjection(", "verifyLeakedProjection(")],
    ["revocation", source.replace("active = false", "active = true")],
    ["active guard", source.replace("!active ||", "false ||")],
    ["transaction identity", source.replace("candidate !== tx", "false")],
    ["tenant identity", source.replace("tenantId !== checked.tenantId", "false")],
    ["actor identity", source.replace("actorUserId !== checked.actorUserId", "false")],
    [
      "database identity",
      source.replace("context.expectedDatabaseName !== checked.expectedDatabaseName", "false"),
    ],
    [
      "database role",
      source.replace("context.expectedDatabaseUser !== checked.expectedDatabaseUser", "false"),
    ],
    ["profile lifetime", source.replace("profile = undefined", "void profile")],
    ["revision routing", source.replace("readShippingRevisionsCore(", "readShippingRevisions(")],
    ["hidden write", source.replace("active = false", "tx.insert(table); active = false")],
    ["escape", source.replace("active = false", "return dependencies; active = false")],
    ...slots.map((slot) => [slot + " lifetime", source.replace(`${slot}.clear()`, `void ${slot}`)]),
  ];
  for (const [name, mutated] of mutations) {
    assert.notEqual(mutated, source, `Mutation must apply: ${name}`);
    assert.throws(() => inspect(mutated), undefined, name);
  }
});

test("shared owner allocation is confined to named final-verifier functions", () => {
  const allowed = new Set([
    "verifyUsDatasetReceivingFinal",
    "verifyUsDatasetTransformationFinal",
    "verifyUsDatasetCasesFinal",
    "verifyUsDatasetCorrectedTransformationFinal",
    "verifyUsDatasetCorrectedCasesFinal",
    "verifyUsDatasetShippingFinal",
  ]);
  function inspectAllocations(text) {
    const file = ts.createSourceFile("owner.ts", text, ts.ScriptTarget.Latest, true);
    const seen = new Set();
    function visit(node, scope) {
      if (ts.isClassDeclaration(node)) {
        assert.ok(
          !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
          "owner class cannot be exported",
        );
      }
      if (
        ts.isFunctionDeclaration(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        scope = node.name?.text;
        assert.ok(allowed.has(scope), "only fixed named final verifiers may be exported");
        assert.ok(
          node.parameters.every(
            (p) => !/reader|proof|callback|core|dependencies/i.test(p.name.getText(file)),
          ),
          "named verifiers cannot accept caller reader/proof arguments",
        );
      }
      if (ts.isNewExpression(node) && node.expression.getText(file) === "NativeFinalVerifier") {
        assert.ok(allowed.has(scope), "owner allocation must be inside a named final verifier");
        seen.add(scope);
      }
      ts.forEachChild(node, (child) => visit(child, scope));
    }
    visit(file, undefined);
    assert.deepEqual(seen, allowed, "every named final verifier owns a fresh private lifetime");
  }
  inspectAllocations(source);
  for (const mutated of [
    source.replace("class NativeFinalVerifier", "export class NativeFinalVerifier"),
    source.replace(
      "export async function verifyUsDatasetReceivingFinal",
      "export async function leakedAllocator",
    ),
    source.replace(
      /export async function verifyUsDatasetReceivingFinal\(\s*tx:/,
      "export async function verifyUsDatasetReceivingFinal(proof: unknown, tx:",
    ),
    source + "\nconst escaped = new NativeFinalVerifier();\n",
  ]) {
    assert.notEqual(mutated, source, "confinement mutation must apply");
    assert.throws(() => inspectAllocations(mutated));
  }
});
