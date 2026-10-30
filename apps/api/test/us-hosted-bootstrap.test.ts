import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileFunction } from "node:vm";
import ts from "typescript";
import { UsHostedApiShutdownError } from "../src/deployment/us-hosted-bootstrap";
import { expect, it, vi } from "vitest";
import * as material from "../src/deployment/us-hosted-material-owner";
import {
  createUsHostedApplication,
  UsHostedApiStartupError,
} from "../src/deployment/us-hosted-bootstrap";

it("requires the fixed installed package before acquiring material or constructing Nest", async () => {
  const collect = vi.spyOn(material, "collectUsHostedMaterial");
  try {
    expect(createUsHostedApplication.length).toBe(0);
    await expect(createUsHostedApplication()).rejects.toBeInstanceOf(UsHostedApiStartupError);
    expect(collect).not.toHaveBeenCalled();
  } finally {
    collect.mockRestore();
  }
});

function closeCallback(): string {
  const source = readFileSync(
    resolve(__dirname, "../src/deployment/us-hosted-bootstrap.ts"),
    "utf8",
  );
  const parsed = ts.createSourceFile("bootstrap.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function walk(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(parsed) === "ownedClose" &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    )
      found.push(node.initializer.getText(parsed));
    ts.forEachChild(node, walk);
  }
  walk(parsed);
  expect(found).toHaveLength(1);
  const callback = found[0];
  if (!callback) throw new Error("owned close missing");
  return ts.transpileModule(`const ownedClose=${callback};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
it("waits for native settlement before Nest or runtime teardown and closes once", async () => {
  let finishNative = () => {};
  const native = new Promise<void>((resolve) => {
    finishNative = resolve;
  });
  const adapter = { close: vi.fn(() => native) };
  const nestClose = vi.fn(async () => {});
  const runtime = { onApplicationShutdown: vi.fn(async () => {}) };
  const factory = compileFunction(`let closing;${closeCallback()}return ownedClose;`, [
    "adapter",
    "nestClose",
    "runtime",
    "connection",
    "material",
    "release",
    "disposeUsHostedMaterial",
    "disposeUsHostedRelease",
    "UsHostedApiShutdownError",
  ]);
  const callback: unknown = Reflect.apply(factory, undefined, [
    adapter,
    nestClose,
    runtime,
    undefined,
    undefined,
    undefined,
    vi.fn(),
    vi.fn(),
    UsHostedApiShutdownError,
  ]);
  if (typeof callback !== "function") throw new Error("compiled close missing");
  const pending: unknown = Reflect.apply(callback, undefined, []);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nestClose).not.toHaveBeenCalled();
    expect(runtime.onApplicationShutdown).not.toHaveBeenCalled();
  } finally {
    finishNative();
  }
  await pending;
  await Reflect.apply(callback, undefined, []);
  expect(adapter.close).toHaveBeenCalledTimes(1);
  expect(nestClose).toHaveBeenCalledTimes(1);
  expect(runtime.onApplicationShutdown).toHaveBeenCalledTimes(1);
});
it("never tears down a runtime when native settlement failed", async () => {
  const adapter = {
    close: vi.fn(async () => {
      throw new Error("synthetic native failure");
    }),
  };
  const nestClose = vi.fn();
  const runtime = { onApplicationShutdown: vi.fn() };
  const factory = compileFunction(`let closing;${closeCallback()}return ownedClose;`, [
    "adapter",
    "nestClose",
    "runtime",
    "connection",
    "material",
    "release",
    "disposeUsHostedMaterial",
    "disposeUsHostedRelease",
    "UsHostedApiShutdownError",
  ]);
  const callback: unknown = Reflect.apply(factory, undefined, [
    adapter,
    nestClose,
    runtime,
    undefined,
    undefined,
    undefined,
    vi.fn(),
    vi.fn(),
    UsHostedApiShutdownError,
  ]);
  if (typeof callback !== "function") throw new Error("compiled close missing");
  const pending: unknown = Reflect.apply(callback, undefined, []);
  await expect(pending).rejects.toBeInstanceOf(UsHostedApiShutdownError);
  expect(nestClose).not.toHaveBeenCalled();
  expect(runtime.onApplicationShutdown).not.toHaveBeenCalled();
});

it("preserves the complete worker executable signal, diagnostic and force-exit contract", () => {
  const folder = resolve(__dirname, "../src");
  const original = readFileSync(resolve(folder, "main.us-request-worker.ts"), "utf8");
  const hosted = readFileSync(resolve(folder, "main.us-hosted-worker.ts"), "utf8");
  const restored = hosted
    .replaceAll("createUsHostedWorkerRuntime", "createUsRequestWorkerRuntime")
    .replaceAll("UsHostedWorkerStartupError", "UsRequestWorkerStartupError")
    .replace("./deployment/us-hosted-worker-runtime", "./deployment/us-request-worker-runtime")
    .replace("createUsRequestWorkerRuntime()", "createUsRequestWorkerRuntime(process.env)");
  expect(restored).toBe(original);
});

function hostedMainUnit(factory: () => Promise<unknown>) {
  const source = readFileSync(resolve(__dirname, "../src/main.us-hosted.ts"), "utf8");
  const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = parsed.statements
    .filter(ts.isFunctionDeclaration)
    .map((node) => node.getText(parsed))
    .join("\n");
  const javascript = ts.transpileModule(declarations, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const listeners = new Map<string, () => void>();
  const diagnostic = vi.fn();
  const processUnit = {
    argv: ["node", "main"],
    exitCode: 0,
    stderr: { write: diagnostic },
    on: (name: string, listener: () => void) => listeners.set(name, listener),
    removeListener: (name: string) => listeners.delete(name),
    exit: (code: number) => {
      processUnit.exitCode = code;
    },
  };
  const run = compileFunction(javascript + "return main();", [
    "process",
    "createUsHostedApplication",
  ]);
  const finished: unknown = Reflect.apply(run, undefined, [processUnit, factory]);
  return {
    finished,
    listeners,
    diagnostic,
    processUnit,
    signal() {
      const listener = listeners.get("SIGTERM");
      if (!listener) throw Error("unit signal missing");
      listener();
    },
  };
}
it("does not listen after an observed stop during bootstrap and awaits one close", async () => {
  let resolveFactory: (app: unknown) => void = () => {};
  const factory = new Promise<unknown>((resolve) => {
    resolveFactory = resolve;
  });
  let closeSettled = () => {};
  const closing = new Promise<void>((resolve) => {
    closeSettled = resolve;
  });
  const app = { listen: vi.fn(async () => {}), close: vi.fn(() => closing) };
  const unit = hostedMainUnit(() => factory);
  unit.signal();
  unit.signal();
  resolveFactory(app);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(app.listen).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledTimes(1);
  } finally {
    closeSettled();
    await unit.finished;
  }
  expect(unit.listeners.size).toBe(0);
});
it("retains normal listen parameters and waits for a started listen before closing", async () => {
  let settleListen = () => {};
  const listening = new Promise<void>((resolve) => {
    settleListen = resolve;
  });
  const events: string[] = [];
  const app = {
    listen: vi.fn(() => {
      events.push("listen");
      return listening.then(() => {
        events.push("listen settled");
      });
    }),
    close: vi.fn(async () => {
      events.push("close");
    }),
  };
  const unit = hostedMainUnit(async () => app);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(app.listen).toHaveBeenCalledWith(8443, "0.0.0.0");
  unit.signal();
  expect(app.close).not.toHaveBeenCalled();
  settleListen();
  await unit.finished;
  expect(events).toEqual(["listen", "listen settled", "close"]);
  expect(unit.listeners.size).toBe(0);
});
it("keeps fixed shutdown diagnostics and removes listeners after close rejection", async () => {
  const app = {
    listen: vi.fn(async () => {}),
    close: vi.fn(async () => {
      throw Error("unit private rejected text");
    }),
  };
  const unit = hostedMainUnit(async () => app);
  await new Promise<void>((resolve) => setImmediate(resolve));
  unit.signal();
  await unit.finished;
  expect(app.close).toHaveBeenCalledTimes(1);
  expect(unit.processUnit.exitCode).toBe(1);
  expect(unit.diagnostic).toHaveBeenCalledWith("us_hosted_api_shutdown_failed\n");
  expect(unit.listeners.size).toBe(0);
});
