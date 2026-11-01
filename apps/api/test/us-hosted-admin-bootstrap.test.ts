import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileFunction } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { parseUsHostedAdminOperation } from "../src/deployment/us-hosted-admin-config";

// Unit shell only: stub release below never passes a real authority accessor.
async function exercise(args: string[], rejects = false, disposeRejects = false) {
  const source = readFileSync(resolve(__dirname, "../src/main.us-hosted-admin.ts"), "utf8");
  const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = parsed.statements
    .filter(ts.isFunctionDeclaration)
    .map((node) => node.getText(parsed))
    .join("\n");
  const javascript = ts.transpileModule(declarations, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const events: string[] = [];
  const shellUnitRelease = Object.freeze({ unitShellOnly: true });
  const verify = vi.fn(async () => {
    events.push("admit");
    if (rejects) throw Error("synthetic-private-canary");
    return shellUnitRelease;
  });
  const dispose = vi.fn(() => {
    events.push("dispose");
    if (disposeRejects) throw Error("synthetic-private-disposal-canary");
  });
  const processUnit = {
    argv: ["node", "main", ...args],
    exitCode: 0,
    stderr: {
      write: vi.fn((message: string) => {
        events.push(message.trim());
      }),
    },
  };
  const run = compileFunction(javascript + "return main();", [
    "process",
    "parseUsHostedAdminOperation",
    "verifyUsHostedAdminRelease",
    "disposeUsHostedAdminRelease",
  ]);
  await Reflect.apply(run, undefined, [processUnit, parseUsHostedAdminOperation, verify, dispose]);
  return { events, verify, dispose, processUnit, shellUnitRelease };
}
it.each(["migrate", "seed", "provision"])(
  "keeps %s locked after actual admission call and disposes once",
  async (operation) => {
    const unit = await exercise([operation]);
    expect(unit.verify).toHaveBeenCalledExactlyOnceWith(operation);
    expect(unit.dispose).toHaveBeenCalledExactlyOnceWith(unit.shellUnitRelease);
    expect(unit.events).toEqual(["admit", "dispose", "us_hosted_provisioning_required"]);
    expect(unit.processUnit.exitCode).toBe(1);
  },
);
it("rejects extra argv without acquiring any release", async () => {
  const unit = await exercise(["migrate", "extra"]);
  expect(unit.verify).not.toHaveBeenCalled();
  expect(unit.dispose).not.toHaveBeenCalled();
  expect(unit.events).toEqual(["us_hosted_admin_startup_refused"]);
  expect(unit.processUnit.exitCode).toBe(1);
});
it("redacts admission and disposal failures without pretending success", async () => {
  const denied = await exercise(["seed"], true);
  expect(denied.dispose).not.toHaveBeenCalled();
  expect(denied.events).toEqual(["admit", "us_hosted_admin_startup_refused"]);
  const disposal = await exercise(["seed"], false, true);
  expect(disposal.events).toEqual(["admit", "dispose", "us_hosted_admin_startup_refused"]);
  expect(disposal.processUnit.exitCode).toBe(1);
});
it("imports only pure operation admission and the private release issuer", () => {
  const source = readFileSync(resolve(__dirname, "../src/main.us-hosted-admin.ts"), "utf8");
  const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const imports = parsed.statements
    .filter(ts.isImportDeclaration)
    .map((node) =>
      ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "invalid",
    );
  expect(imports).toEqual([
    "./deployment/us-hosted-admin-config",
    "./deployment/us-hosted-admin-release",
  ]);
});
