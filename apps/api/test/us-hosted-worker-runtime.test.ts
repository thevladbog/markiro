import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileFunction } from "node:vm";
import ts from "typescript";
import {
  assertUsRequestWorkerExecutionIdentity,
  createSyntheticUsRequestExecutionIdentity,
} from "../src/modules/traceability/requests/us-request-worker-execution";
import { expect, it, vi } from "vitest";
import * as material from "../src/deployment/us-hosted-material-owner";
import {
  createUsHostedWorkerRuntime,
  UsHostedWorkerStartupError,
} from "../src/deployment/us-hosted-worker-runtime";

it("uses a fixed no-argument startup and refuses this source checkout before material acquisition", async () => {
  const collect = vi.spyOn(material, "collectUsHostedMaterial");
  try {
    expect(createUsHostedWorkerRuntime.length).toBe(0);
    await expect(createUsHostedWorkerRuntime()).rejects.toBeInstanceOf(UsHostedWorkerStartupError);
    expect(collect).not.toHaveBeenCalled();
  } finally {
    collect.mockRestore();
  }
});

function arrow(name: string, binding: string): string {
  const source = readFileSync(
    resolve(__dirname, "../src/deployment/us-hosted-worker-runtime.ts"),
    "utf8",
  );
  const parsed = ts.createSourceFile("runtime.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function walk(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(parsed) === name &&
      ts.isArrowFunction(node.initializer)
    )
      found.push(node.initializer.getText(parsed));
    ts.forEachChild(node, walk);
  }
  walk(parsed);
  expect(found).toHaveLength(1);
  const expression = found[0];
  if (!expression) throw new Error("fixed callback missing");
  return ts.transpileModule(`const ${binding} = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

it.each([false, true])(
  "preserves original invocation result/error after owner refusal (reject=%s) without self-await",
  async (reject) => {
    const original = new Error("synthetic invocation error");
    const result = { kind: "idle" };
    const identity = createSyntheticUsRequestExecutionIdentity(
      { apiVersion: "unit", gitSha: "a".repeat(40), dirty: false },
      { NODE_ENV: "test", MARKIRO_DEPLOYMENT_EDITION: "US" },
    );
    let releaseDrain = () => {};
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const loop = { stop: vi.fn(() => drain) };
    const factory = compileFunction(
      `let terminalRefusal=false;${arrow("runOne", "runOne")}return {runOne, refused:()=>terminalRefusal};`,
      ["worker", "invocationExecution", "loop", "assertUsRequestWorkerExecutionIdentity"],
    );
    const wrapped: unknown = Reflect.apply(factory, undefined, [
      {
        runOne: async () => {
          if (reject) throw original;
          return result;
        },
      },
      { ...identity },
      loop,
      assertUsRequestWorkerExecutionIdentity,
    ]);
    if (
      !wrapped ||
      typeof wrapped !== "object" ||
      !("runOne" in wrapped) ||
      typeof wrapped.runOne !== "function" ||
      !("refused" in wrapped) ||
      typeof wrapped.refused !== "function"
    )
      throw new Error("invalid compiled callback");
    const pending: unknown = Reflect.apply(wrapped.runOne, undefined, []);
    let settled = false;
    let value: unknown;
    let failure: unknown;
    const observed = Promise.resolve(pending).then(
      (output) => {
        settled = true;
        value = output;
      },
      (error: unknown) => {
        settled = true;
        failure = error;
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
      expect(Reflect.apply(wrapped.refused, undefined, [])).toBe(true);
      expect(loop.stop).toHaveBeenCalledTimes(1);
      if (reject) expect(failure).toBe(original);
      else expect(value).toBe(result);
    } finally {
      releaseDrain();
      await observed;
    }
  },
);

it.each(["graceful", "force_exit"])(
  "tears down only after actual graceful settlement (%s)",
  async (kind) => {
    const loop = { stop: vi.fn(async () => ({ kind })), run: vi.fn(async () => {}) };
    const dispose = vi.fn(async () => {});
    const factory = compileFunction(`let drain;${arrow("stop", "stop")}return stop;`, [
      "loop",
      "dispose",
    ]);
    const stop: unknown = Reflect.apply(factory, undefined, [loop, dispose]);
    if (typeof stop !== "function") throw new Error("invalid compiled stop");
    const result: unknown = await Reflect.apply(stop, undefined, []);
    expect(result).toEqual({ kind });
    expect(dispose).toHaveBeenCalledTimes(kind === "graceful" ? 1 : 0);
    expect(loop.run).toHaveBeenCalledTimes(kind === "graceful" ? 1 : 0);
    await Reflect.apply(stop, undefined, []);
    expect(loop.stop).toHaveBeenCalledTimes(1);
  },
);

it("preserves the original read-only preflight, typed event emitter and scheduler source", () => {
  const folder = resolve(__dirname, "../src/deployment");
  const original = readFileSync(resolve(folder, "us-request-worker-runtime.ts"), "utf8");
  const hosted = readFileSync(resolve(folder, "us-hosted-worker-runtime.ts"), "utf8");
  const helpers = (source: string, end: string) => {
    const a = source.indexOf("function emitProcessEvent(");
    const b = source.indexOf(end, a);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return source.slice(a, b);
  };
  expect(helpers(hosted, "/** Fixed B2")).toBe(helpers(original, "/** Trusted in-process"));
  expect(createHash("sha256").update(original).digest("hex")).toBe(
    "b16ff674ad01aada801f9191845ab7147678b6699d5309c01ac22251b2b5a131",
  );
  expect(
    createHash("sha256")
      .update(readFileSync(resolve(folder, "us-request-worker-loop.ts")))
      .digest("hex"),
  ).toBe("008522fa95ab00debce7c08eb52218055fed26ea0390c492aa0981a1020a7211");
});

it.each([false, true])(
  "preserves the original invocation even if stop itself throws (reject=%s)",
  async (reject) => {
    const original = new Error("synthetic original error");
    const result = { kind: "idle" };
    const identity = createSyntheticUsRequestExecutionIdentity(
      { apiVersion: "unit", gitSha: "a".repeat(40), dirty: false },
      { NODE_ENV: "test", MARKIRO_DEPLOYMENT_EDITION: "US" },
    );
    const loop = {
      stop: vi.fn(() => {
        throw new Error("synthetic stop failure");
      }),
    };
    const factory = compileFunction(
      `let terminalRefusal=false;${arrow("runOne", "runOne")}return runOne;`,
      ["worker", "invocationExecution", "loop", "assertUsRequestWorkerExecutionIdentity"],
    );
    const run: unknown = Reflect.apply(factory, undefined, [
      {
        runOne: async () => {
          if (reject) throw original;
          return result;
        },
      },
      { ...identity },
      loop,
      assertUsRequestWorkerExecutionIdentity,
    ]);
    if (typeof run !== "function") throw new Error("compiled run missing");
    const pending: unknown = Reflect.apply(run, undefined, []);
    if (reject) await expect(pending).rejects.toBe(original);
    else await expect(pending).resolves.toBe(result);
    expect(loop.stop).toHaveBeenCalledTimes(1);
  },
);
