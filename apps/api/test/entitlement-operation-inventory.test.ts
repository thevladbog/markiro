import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ENTITLEMENT_OPERATIONS } from "@markiro/platform-contracts";

// Source AST checks real calls, ignoring comments and merely named helpers.
const inventory = [
  ["nk.lookup.v1", "national-catalog/national-catalog-products.service.ts", "lookup"],
  ["nk.lookup.v1", "national-catalog/national-catalog-products.service.ts", "selectCardRead"],
  ["nk.proposal.v1", "national-catalog/national-catalog-proposal.service.ts", "preview"],
  ["nk.lookup.v1", "national-catalog/national-catalog-import.service.ts", "start"],
  ["nk.worker.v1", "national-catalog/national-catalog-import.service.ts", "resume"],
  ["nk.proposal.v1", "national-catalog/national-catalog-import-preview.service.ts", "prepare"],
  [
    "nk.worker.v1",
    "national-catalog/national-catalog-import-preview.service.ts",
    "resumePreparation",
  ],
  ["nk.apply.v1", "national-catalog/national-catalog-import-apply.service.ts", "start"],
  ["nk.worker.v1", "national-catalog/national-catalog-import-apply.service.ts", "resume"],
  ["nk.refresh.v1", "national-catalog/national-catalog-link-refresh.service.ts", "enqueue"],
  ["nk.worker.v1", "national-catalog/national-catalog-link-refresh.service.ts", "admit"],
  ["nk.worker.v1", "national-catalog/national-catalog-image.service.ts", "resume"],
  ["nk.apply.v1", "product-regulatory/product-regulatory-writer.ts", "applyInTransaction"],
  ["nk.worker.v1", "national-catalog/national-catalog-image-apply.ts", "applyAcceptedImage"],
  ["chz.export.create.v1", "chz-exports/chz-export-runner.service.ts", "claim"],
  ["inventory.task.create.v1", "inventories/inventories.service.ts", "create"],
  ["inventory.file.create.v1", "inventories/inventories.service.ts", "importEvidence"],
  ["inventory.task.start.v1", "inventories/inventory-lifecycle.service.ts", "start"],
  ["commerceMl.exchange.v1", "exchange/exchange-session.service.ts", "ensureOutstandingOrderQuery"],
  ["commerceMl.exchange.v1", "exchange/exchange-session.service.ts", "observeImport"],
  [
    "labelEditor.template.write.v1",
    "label-templates/label-templates.service.ts",
    "createLabelTemplate",
  ],
  [
    "labelEditor.template.write.v1",
    "label-templates/label-templates.service.ts",
    "updateLabelTemplate",
  ],
  [
    "labelEditor.template.write.v1",
    "label-templates/label-templates.service.ts",
    "deleteLabelTemplate",
  ],
  ["pallets.shift.configure.v1", "shifts/shifts.service.ts", "createShift"],
  ["pallets.shift.configure.station.v1", "shifts/shifts.service.ts", "createShift"],
  ["pallets.shift.configure.v1", "shifts/shifts.service.ts", "updateShift"],
  ["pallets.shift.start.v1", "shifts/shifts.service.ts", "openShift"],
  ["pallets.shift.start.v1", "shifts/shifts.service.ts", "enterShift"],
] as const;
function calls(node: ts.Node, operation: string): number {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ["observe", "withAdmission"].includes(node.expression.name.text)
  ) {
    const input = node.arguments[0];
    if (
      input &&
      ts.isObjectLiteralExpression(input) &&
      input.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText() === "operationId" &&
          ((ts.isStringLiteral(property.initializer) && property.initializer.text === operation) ||
            (ts.isConditionalExpression(property.initializer) &&
              [property.initializer.whenTrue, property.initializer.whenFalse].some(
                (branch) => ts.isStringLiteral(branch) && branch.text === operation,
              ))),
      )
    )
      return 1;
  }
  return node.getChildren().reduce((count, child) => count + calls(child, operation), 0);
}
describe("actual entitlement operation adapters", () => {
  it("recognizes explicit actor-selected operation IDs only inside a real admission call", () => {
    const source = ts.createSourceFile(
      "actor.ts",
      `
      admission.observe({operationId: actor.domain === "cabinet" ? "pallets.shift.configure.v1" : "pallets.shift.configure.station.v1"});
      const unused = "pallets.shift.start.v1";
    `,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(calls(source, "pallets.shift.configure.v1")).toBe(1);
    expect(calls(source, "pallets.shift.configure.station.v1")).toBe(1);
    expect(calls(source, "pallets.shift.start.v1")).toBe(0);
  });
  it.each(inventory)(
    "%s at %s.%s is a callable owner with a real admission call",
    (operation, file, method) => {
      const source = ts.createSourceFile(
        file,
        readFileSync(resolve(__dirname, "../src/modules", file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const members = source.statements
        .filter(ts.isClassDeclaration)
        .flatMap((declaration) => [...declaration.members])
        .filter(ts.isMethodDeclaration);
      const owner =
        members.find((member) => member.name.getText(source) === method) ??
        source.statements
          .filter(ts.isFunctionDeclaration)
          .find((fn) => fn.name?.getText(source) === method);
      expect(owner?.body).toBeDefined();
      expect(owner && calls(owner, operation)).toBe(
        method === "resumePreparation" || file.endsWith("national-catalog-image.service.ts")
          ? 2
          : 1,
      );
      expect(["p1a_adapter", "p1b_adapter"]).toContain(ENTITLEMENT_OPERATIONS[operation].coverage);
    },
  );
  it("covers every registry P1A adapter, while keeping classified recovery and P1B/C deferred", () => {
    expect([...new Set(inventory.map(([operation]) => operation))].sort()).toEqual(
      Object.entries(ENTITLEMENT_OPERATIONS)
        .filter(([, entry]) => ["p1a_adapter", "p1b_adapter"].includes(entry.coverage))
        .map(([id]) => id)
        .sort(),
    );
    expect(ENTITLEMENT_OPERATIONS["chz.export.poll.v1"].class).toBe("continuation");
    expect(ENTITLEMENT_OPERATIONS["chz.export.receipt.v1"].class).toBe("stored_read");
    for (const id of ["handheld.work.start.v1", "publicApi.request.v1"] as const)
      expect(ENTITLEMENT_OPERATIONS[id].coverage).toBe("deferred");
  });
});
