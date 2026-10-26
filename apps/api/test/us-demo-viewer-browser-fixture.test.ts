import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { Script } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as fixture from "./support/us-demo-viewer-browser-fixture";

const task10Helper =
  '/** Observation only: never used to decide whether the real entry may acquire resources. */\nexport function viewerGuardObservation(\n  env: Readonly<Record<string, string | undefined>>,\n  platform: string,\n): string {\n  const refused = [\n    env.CI !== "true",\n    env.GITHUB_ACTIONS !== "true",\n    env.GITHUB_JOB !== "demo_viewer_acceptance",\n    env.RUNNER_ENVIRONMENT !== "github-hosted",\n    platform !== "linux",\n    env.US_TEST_DATABASE_URL !==\n      "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",\n    Boolean(env.NODE_OPTIONS),\n    Boolean(env.NODE_PATH),\n    Boolean(env.DEBUG),\n    Boolean(env.PWDEBUG),\n  ];\n  const mask = refused.reduce((bits, failed, index) => bits | (failed ? 1 << index : 0), 0);\n  return `US_DEMO_VIEWER_GUARD_OBSERVATION ${mask}`;\n}\n\n';
const task10Branch =
  '  ) {\n    try {\n      console.error(\n        viewerGuardObservation(\n          {\n            CI: process.env.CI,\n            GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,\n            GITHUB_JOB: process.env.GITHUB_JOB,\n            RUNNER_ENVIRONMENT: process.env.RUNNER_ENVIRONMENT,\n            US_TEST_DATABASE_URL: process.env.US_TEST_DATABASE_URL,\n            NODE_OPTIONS: process.env.NODE_OPTIONS,\n            NODE_PATH: process.env.NODE_PATH,\n            DEBUG: process.env.DEBUG,\n            PWDEBUG: process.env.PWDEBUG,\n          },\n          process.platform,\n        ),\n      );\n    } catch {\n      // Observation failure must never replace the original refusal.\n    }\n    throw new Error("us_demo_viewer_ci_only");\n  }\n';
const task10OriginalBranch = '  )\n    throw new Error("us_demo_viewer_ci_only");\n';
const task10OriginalSha256 = "114ad0e525972a1d7429ba730a153edff1156e3ef6f4bddb71f99f5456121039";
const task10Source = () =>
  readFileSync(resolve(__dirname, "support/us-demo-viewer-browser-fixture.ts"), "utf8");

const task15FixturePairs: readonly (readonly [string, string])[] = [
  [
    "",
    '/** Failure-only finite recorder. Stderr bytes are compared, never retained or decoded. */\nexport function createViewerProvisionObservation() {\n  const refusal =\n    "US synthetic viewer command refused. Check exact arguments, isolated migrated database, trusted owner/profile and password input. Existing identities are never repaired or reset.";\n  const prefix = "US_VIEWER_PROVISION_OBSERVATION ";\n  let stage = 0,\n    mask = 0,\n    exit = 0,\n    native = 0,\n    cleanup = 0;\n  let line = 0,\n    offset = 0,\n    stderrBytes = 0;\n  let carriage = false,\n    invalid = false,\n    attempted = false;\n  return {\n    enter(value: unknown) {\n      stage =\n        value === 1 ||\n        value === 2 ||\n        value === 3 ||\n        value === 4 ||\n        value === 5 ||\n        value === 6 ||\n        value === 7\n          ? value\n          : 0;\n    },\n    mark(value: unknown) {\n      if (\n        value === 1 ||\n        value === 2 ||\n        value === 4 ||\n        value === 8 ||\n        value === 16 ||\n        value === 32 ||\n        value === 64 ||\n        value === 128\n      )\n        mask |= value;\n    },\n    closed(code: unknown) {\n      mask |= 128;\n      exit = code === 0 ? 1 : typeof code === "number" && Number.isSafeInteger(code) ? 2 : 3;\n    },\n    overflow() {\n      invalid = true;\n    },\n    stderr(bytes: Uint8Array) {\n      try {\n        if (invalid) return;\n        for (const byte of bytes) {\n          if (++stderrBytes > 4096 || line > 1) {\n            invalid = true;\n            return;\n          }\n          const length = line === 0 ? refusal.length : prefix.length + 3;\n          if (carriage) {\n            if (byte !== 10) {\n              invalid = true;\n              return;\n            }\n            carriage = false;\n            line++;\n            offset = 0;\n          } else if (offset === length) {\n            if (byte === 13) carriage = true;\n            else if (byte === 10) {\n              line++;\n              offset = 0;\n            } else {\n              invalid = true;\n              return;\n            }\n          } else if (line === 1 && offset === prefix.length) {\n            if (byte < 48 || byte > 55) {\n              invalid = true;\n              return;\n            }\n            native = byte - 48;\n            offset++;\n          } else if (line === 1 && offset === prefix.length + 2) {\n            if (byte !== 48 && byte !== 49) {\n              invalid = true;\n              return;\n            }\n            cleanup = byte - 48;\n            offset++;\n          } else {\n            const expected =\n              line === 0\n                ? refusal.charCodeAt(offset)\n                : offset === prefix.length + 1\n                  ? 32\n                  : prefix.charCodeAt(offset);\n            if (byte !== expected) {\n              invalid = true;\n              return;\n            }\n            offset++;\n          }\n        }\n      } catch {\n        invalid = true;\n      }\n    },\n    emitFailure(sink: (value: string) => void) {\n      if (attempted) return;\n      attempted = true;\n      try {\n        const recognized = !invalid && line === 2 && !carriage && (mask & 128) !== 0 && exit !== 0;\n        sink(\n          `US_DEMO_VIEWER_PROVISION_OBSERVATION ${stage} ${mask} ${exit} ${recognized ? native : 0} ${recognized ? cleanup : 0}`,\n        );\n      } catch {\n        // The original failure and cleanup result always win.\n      }\n    },\n  };\n}\n\n',
  ],
  ["", "  observation: ReturnType<typeof createViewerProvisionObservation>,\n"],
  ["", "  observation.enter(1);\n"],
  ["", "  observation.mark(1);\n"],
  ["", "  observation.enter(2);\n"],
  [
    "  const timer = setTimeout(stop, Math.max(1, cap - 1000));\n",
    "  const timer = setTimeout(\n    () => {\n      observation.mark(32);\n      stop();\n    },\n    Math.max(1, cap - 1000),\n  );\n",
  ],
  ["", "    observation.mark(64);\n"],
  ["", "    observation.mark(2);\n"],
  [
    '  child.stdin.on("error", stop);\n',
    '  child.stdin.on("error", () => {\n    observation.mark(4);\n    stop();\n  });\n',
  ],
  [
    "    if (count > 4096) stop();\n    else stdout = Buffer.concat([stdout, bytes]);\n",
    "    if (count > 4096) {\n      observation.mark(16);\n      observation.overflow();\n      stop();\n    } else stdout = Buffer.concat([stdout, bytes]);\n",
  ],
  [
    "    if (count > 4096) stop();\n",
    "    observation.mark(8);\n    if (count > 4096) {\n      observation.mark(16);\n      observation.overflow();\n      stop();\n    } else observation.stderr(bytes);\n",
  ],
  ["", "  observation.enter(3);\n"],
  [
    '  const code = await new Promise<number | null>((done) => child.once("close", done));\n',
    '  observation.enter(4);\n  const code = await new Promise<number | null>((done) =>\n    child.once("close", (code) => {\n      observation.closed(code);\n      done(code);\n    }),\n  );\n',
  ],
  [
    '  const result = viewerResult.parse(JSON.parse(stdout.toString("utf8")) as unknown);\n',
    '  observation.enter(5);\n  const parsed: unknown = JSON.parse(stdout.toString("utf8"));\n  observation.enter(6);\n  const result = viewerResult.parse(parsed);\n  observation.enter(7);\n',
  ],
  ["", "  const provisionObservation = createViewerProvisionObservation();\n"],
  ["", "        provisionObservation,\n"],
  [
    "",
    '    } finally {\n      if (phase === "provision") provisionObservation.emitFailure((line) => console.error(line));\n',
  ],
];
function task15ExactInverse(source: string, pairs: readonly (readonly [string, string])[]) {
  for (const [, after] of pairs) expect(source.split(after)).toHaveLength(2);
  for (const [before, after] of pairs) source = source.replace(after, before);
  return source;
}
function task15AssertFixturePlacement(source: string) {
  // Bind additions to original operations, guard, event owners and cleanup before erasure.
  for (const anchor of [
    "  .strict();\n/** Failure-only finite recorder. Stderr bytes are compared, never retained or decoded. */\nexport function createViewerProvisionObservation() {",
    "        // The original failure and cleanup result always win.\n      }\n    },\n  };\n}\n\n/** Actual compiled process; bounded private stdin and closed diagnostics, never a shell. */",
    "async function provision(\n  installation: Installation,\n  password: string,\n  cap: number,\n  register: (close: () => Promise<void>) => void,\n  deadline: () => number,\n  observation: ReturnType<typeof createViewerProvisionObservation>,\n) {\n  observation.enter(1);\n  const child = spawn(",
    "  );\n  observation.mark(1);\n  const drained = childDrain(child);\n  observation.enter(2);\n  register(\n    viewerOwnedShutdown(",
    '  const timer = setTimeout(\n    () => {\n      observation.mark(32);\n      stop();\n    },\n    Math.max(1, cap - 1000),\n  );\n  const kill = setTimeout(() => {\n    observation.mark(64);\n    failed = true;\n    child.kill("SIGKILL");\n  }, cap);',
    '  child.on("error", () => {\n    observation.mark(2);\n    failed = true;\n  });\n  child.stdin.on("error", () => {\n    observation.mark(4);\n    stop();\n  });',
    '  child.stdout.on("data", (bytes: Buffer) => {\n    count += bytes.length;\n    if (count > 4096) {\n      observation.mark(16);\n      observation.overflow();\n      stop();\n    } else stdout = Buffer.concat([stdout, bytes]);\n  });',
    '  child.stderr.on("data", (bytes: Buffer) => {\n    count += bytes.length;\n    failed = true;\n    observation.mark(8);\n    if (count > 4096) {\n      observation.mark(16);\n      observation.overflow();\n      stop();\n    } else observation.stderr(bytes);\n  });\n  observation.enter(3);\n  child.stdin.end(`${password}\\n`);\n  observation.enter(4);\n  const code = await new Promise<number | null>((done) =>\n    child.once("close", (code) => {\n      observation.closed(code);\n      done(code);\n    }),\n  );\n  clearTimeout(timer);',
    '  if (failed || code !== 0) throw viewerBrowserFailure("provision");\n  observation.enter(5);\n  const parsed: unknown = JSON.parse(stdout.toString("utf8"));\n  observation.enter(6);\n  const result = viewerResult.parse(parsed);\n  observation.enter(7);\n  if (\n    result.tenantId !== installation.identity.tenantId ||\n    result.viewerUserId === installation.identity.userId',
    '    throw new Error("us_demo_viewer_ci_only");\n  }\n  let installation: Installation | undefined, app: OwnedServer | undefined;\n  let vite: OwnedServer | undefined;\n  let browser: ViewerBrowser | undefined, context: ViewerContext | undefined;\n  let browserOwner: (() => Promise<void>) | undefined,\n    provisionOwner: (() => Promise<void>) | undefined;\n  let plans: UsPlanArtifactStore | undefined, packages: UsRequestPackageArtifactStore | undefined;\n  let closing: Promise<void> | undefined,\n    phase: Phase = "installation";\n  const provisionObservation = createViewerProvisionObservation();\n  let disposalDeadline: number | undefined;',
    '    const viewer = await setup.run("provision", () =>\n      provision(\n        owned,\n        password,\n        remaining(),\n        (close) => {\n          provisionOwner = close;\n        },\n        cleanupDeadline,\n        provisionObservation,\n      ),\n    );\n    phase = "descriptors";',
    '  } catch {\n    try {\n      await close();\n    } catch {\n      throw new Error(\n        `Viewer browser failed: ${phase}; disposal incomplete: pending-setup=${setup.pendingCount()}`,\n      );\n    } finally {\n      if (phase === "provision") provisionObservation.emitFailure((line) => console.error(line));\n    }\n    throw viewerBrowserFailure(phase);',
  ])
    expect(source.split(anchor)).toHaveLength(2);
}
function task15RestoreFixture(source: string) {
  task15AssertFixturePlacement(source);
  const restored = task15ExactInverse(source, task15FixturePairs);
  expect(createHash("sha256").update(restored).digest("hex")).toBe(
    "17be6ad8060e214aae23c255d279d420c44e086fd73c511da78aee67f7c4ce9f",
  );
  return restored;
}

function task15StderrCallback() {
  const source = ts.createSourceFile("fixture.ts", task10Source(), ts.ScriptTarget.Latest, true);
  const found: ts.ArrowFunction[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "child.stderr.on" &&
      node.arguments[0]?.getText(source) === '"data"'
    ) {
      const callback = node.arguments[1];
      if (callback && ts.isArrowFunction(callback)) found.push(callback);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(found).toHaveLength(1);
  const callback = found[0];
  if (!callback) throw new Error("Missing actual stderr callback");
  return callback.getText(source);
}

function task15RunStderr(
  bytes: Uint8Array,
  observation: unknown,
  stop: () => void,
  count = 0,
): unknown {
  const code = `let count = initialCount, failed = false;
    (${task15StderrCallback()})(bytes); ({count, failed});`;
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Script(compiled).runInNewContext(
    { bytes, observation, stop, initialCount: count },
    { timeout: 1000 },
  );
}

function task15PureCode(code: string, context: Record<string, unknown>): unknown {
  return new Script(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
    }).outputText,
  ).runInNewContext(context, { timeout: 1000 });
}

function task15ProvisionCallback(kind: "timer" | "kill" | "stdin" | "error" | "close" | "stdout") {
  const source = ts.createSourceFile("fixture.ts", task10Source(), ts.ScriptTarget.Latest, true);
  const provision = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "provision",
  );
  if (!provision) throw new Error("Missing actual provision function");
  const callbacks: ts.ArrowFunction[] = [];
  const visit = (node: ts.Node) => {
    if (
      (kind === "timer" || kind === "kill") &&
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === kind &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const callback = node.initializer.arguments[0];
      if (callback && ts.isArrowFunction(callback)) callbacks.push(callback);
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source);
      const event = node.arguments[0]?.getText(source);
      if (
        (kind === "stdin" && expression === "child.stdin.on" && event === '"error"') ||
        (kind === "error" && expression === "child.on" && event === '"error"') ||
        (kind === "close" && expression === "child.once" && event === '"close"') ||
        (kind === "stdout" && expression === "child.stdout.on" && event === '"data"')
      ) {
        const callback = node.arguments[1];
        if (callback && ts.isArrowFunction(callback)) callbacks.push(callback);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(provision);
  expect(callbacks).toHaveLength(1);
  const callback = callbacks[0];
  if (!callback) throw new Error("Missing actual provision callback");
  return callback.getText(source);
}

describe("Task15 provision observation", () => {
  it("checks every new fragment before restoring the complete Task10 predecessor and old proof", () => {
    const source = task10Source();
    assertTask10Preserved(source);
    const stdinStage = "  observation.enter(3);\n";
    const stdinWrite = "  child.stdin.end(`${password}\\n`);\n";
    expect(source.split(stdinStage)).toHaveLength(2);
    expect(source.split(stdinWrite)).toHaveLength(2);
    expect(() =>
      assertTask10Preserved(
        source.replace(stdinStage, "").replace(stdinWrite, stdinWrite + stdinStage),
      ),
    ).toThrow();
    for (const [, after] of task15FixturePairs) {
      expect(() => assertTask10Preserved(source.replace(after, ""))).toThrow();
      expect(() => assertTask10Preserved(source.replace(after, after + after))).toThrow();
    }
    for (const [before, after] of [
      ["observation.mark(32);", "observation.mark(64);"],
      ["observation.mark(1);", "observation.mark(2);"],
      [
        "    failed = true;\n    observation.mark(8);",
        "    failed = false;\n    observation.mark(8);",
      ],
      ["    Math.max(1, cap - 1000),", "    Math.max(1, cap + 1000),"],
      ["  }, cap);", "  }, cap + 1000);"],
      ["if (failed || code !== 0)", "if (false)"],
      ["result.viewerUserId === installation.identity.userId", "false"],
      ["        provisionObservation,", "        createViewerProvisionObservation(),"],
      ["    observation.closed(code);", "    observation.closed(0);"],
      [
        "    } else observation.stderr(bytes);",
        '    } else console.error(bytes.toString("utf8"));',
      ],
      ["if (++stderrBytes > 4096 || line > 1)", "if (++stderrBytes > 8192 || line > 2)"],
      ["      attempted = true;", "      attempted = false;"],
      [
        'if (phase === "provision") provisionObservation.emitFailure((line) => console.error(line));',
        "provisionObservation.emitFailure((line) => console.log(line));",
      ],
    ] as const) {
      expect(source.split(before)).toHaveLength(2);
      expect(() => assertTask10Preserved(source.replace(before, after))).toThrow();
    }
  });
  it("rejects parent construction stages event owners and recorder displacement before erasure", () => {
    const source = task10Source();
    task15AssertFixturePlacement(source);
    for (const [addition, later] of [
      [
        "  observation: ReturnType<typeof createViewerProvisionObservation>,\n",
        "  installation: Installation,\n",
      ],
      [
        "  observation.enter(1);\n",
        "  const drained = childDrain(child);\n  observation.enter(2);\n",
      ],
      [
        "  observation.mark(1);\n",
        "  const drained = childDrain(child);\n  observation.enter(2);\n",
      ],
      ["  observation.enter(2);\n", "    failed = false;\n"],
      ["      observation.mark(32);\n", '  child.stdin.on("error", () => {\n'],
      ["    observation.mark(64);\n", '  child.on("error", () => {\n'],
      ["    observation.mark(2);\n", '  child.stdin.on("error", () => {\n'],
      ["    observation.mark(4);\n", '  child.on("error", () => {\n'],
      ["    observation.mark(8);\n", '  child.stdout.on("data", (bytes: Buffer) => {\n'],
      ["  observation.enter(3);\n", "  child.stdin.end(`${password}\\n`);\n"],
      ["  observation.enter(4);\n", "  clearTimeout(timer);\n  clearTimeout(kill);\n"],
      [
        "  observation.enter(5);\n",
        '  const parsed: unknown = JSON.parse(stdout.toString("utf8"));\n',
      ],
      ["  observation.enter(6);\n", "  const result = viewerResult.parse(parsed);\n"],
      [
        "  observation.enter(7);\n",
        '    throw viewerBrowserFailure("provision");\n  return result;\n',
      ],
      [
        "  const provisionObservation = createViewerProvisionObservation();\n",
        "export async function startUsDemoViewerBrowserFixture() {\n",
      ],
      ["        provisionObservation,\n", "        owned,\n"],
    ] as const) {
      expect(source.split(addition)).toHaveLength(2);
      expect(source.split(later)).toHaveLength(2);
      const displaced = source.replace(addition, "").replace(later, later + addition);
      // Assert the placement gate itself rejects, before any inverse/hash can hide a move.
      expect(() => task15AssertFixturePlacement(displaced)).toThrow();
    }
  });
  it("actual stderr handler forwards bounded bytes without changing failure or stop behavior", () => {
    const bytes = Buffer.from("US_VIEWER_PROVISION_OBSERVATION 1 0\n");
    const received: Uint8Array[] = [];
    const stop = vi.fn();
    expect(
      task15RunStderr(
        bytes,
        {
          mark() {},
          stderr(chunk: Uint8Array) {
            received.push(chunk);
          },
        },
        stop,
      ),
    ).toEqual({ count: bytes.length, failed: true });
    expect(received).toEqual([bytes]);
    expect(stop).not.toHaveBeenCalled();
  });

  const refusal =
    "US synthetic viewer command refused. Check exact arguments, isolated migrated database, trusted owner/profile and password input. Existing identities are never repaired or reset.";
  const wire = `${refusal}\nUS_VIEWER_PROVISION_OBSERVATION 5 1\n`;
  const emitted = (observation: ReturnType<typeof fixture.createViewerProvisionObservation>) => {
    const lines: string[] = [];
    observation.emitFailure((line) => lines.push(line));
    observation.emitFailure(() => {
      throw new Error("must not retry");
    });
    expect(lines).toHaveLength(1);
    return lines[0];
  };

  it("recognizes only two complete lines across every split and one-byte chunks", () => {
    for (const ending of ["\n", "\r\n"]) {
      const bytes = Buffer.from(wire.replaceAll("\n", ending));
      for (let split = 0; split <= bytes.length; split++) {
        const observation = fixture.createViewerProvisionObservation();
        observation.stderr(bytes.subarray(0, split));
        observation.stderr(bytes.subarray(split));
        observation.closed(1);
        expect(emitted(observation)).toBe("US_DEMO_VIEWER_PROVISION_OBSERVATION 0 128 2 5 1");
      }
      const observation = fixture.createViewerProvisionObservation();
      for (const byte of bytes) observation.stderr(Uint8Array.of(byte));
      observation.closed(null);
      expect(emitted(observation)).toBe("US_DEMO_VIEWER_PROVISION_OBSERVATION 0 128 3 5 1");
    }
  });

  it("invalidates malformed, duplicate, extra, incomplete, secret or overflowing stderr forever", () => {
    const secret = "private-password-factor-token-sentinel";
    for (const text of [
      "",
      wire.slice(0, -1),
      wire + wire,
      wire + "\n",
      "\n" + wire,
      wire.replace("5 1", "8 1"),
      wire.replace("5 1", "5 2"),
      wire.replace("5 1", "05 1"),
      wire.replace("5 1", "5 1 "),
      wire.replace("\n", "\r"),
      wire.split("\n").reverse().join("\n"),
      "\u001b[31m" + wire,
      "é" + wire,
      secret,
      wire + secret,
      secret + wire,
      "x".repeat(4096),
      "x".repeat(4097),
    ]) {
      const observation = fixture.createViewerProvisionObservation();
      observation.stderr(Buffer.from(text));
      observation.closed(1);
      const line = emitted(observation);
      expect(line).toBe("US_DEMO_VIEWER_PROVISION_OBSERVATION 0 128 2 0 0");
      expect(inspect(observation, { depth: 10 })).not.toContain(secret);
    }
    const overflow = fixture.createViewerProvisionObservation();
    overflow.stderr(Buffer.from(wire));
    overflow.overflow();
    overflow.stderr(Buffer.from(wire));
    overflow.closed(1);
    expect(emitted(overflow)).toBe("US_DEMO_VIEWER_PROVISION_OBSERVATION 0 128 2 0 0");
    const unclosed = fixture.createViewerProvisionObservation();
    unclosed.stderr(Buffer.from(wire));
    expect(emitted(unclosed)).toBe("US_DEMO_VIEWER_PROVISION_OBSERVATION 0 0 0 0 0");
  });

  it("does not retain caller chunks and maps only finite stages flags and close categories", () => {
    for (const stage of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const observation = fixture.createViewerProvisionObservation();
      observation.enter(stage);
      for (const bit of [1, 2, 4, 8, 16, 32, 64]) observation.mark(bit);
      const bytes = Buffer.from(wire);
      observation.stderr(bytes);
      bytes.fill(0);
      observation.closed(0);
      expect(emitted(observation)).toBe(`US_DEMO_VIEWER_PROVISION_OBSERVATION ${stage} 255 1 5 1`);
    }
    for (const [code, expected] of [
      [0, 1],
      [1, 2],
      [-1, 2],
      [null, 3],
      [NaN, 3],
      [undefined, 3],
    ] as const) {
      const observation = fixture.createViewerProvisionObservation();
      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error("private");
          },
          ownKeys() {
            throw new Error("private");
          },
        },
      );
      observation.enter(hostile);
      observation.mark(hostile);
      observation.mark(255);
      observation.closed(code);
      expect(emitted(observation)).toBe(
        `US_DEMO_VIEWER_PROVISION_OBSERVATION 0 128 ${expected} 0 0`,
      );
    }
  });

  it("actual stderr handler keeps combined cap and exact stop counts with a real recorder", () => {
    for (const count of [4095, 4096]) {
      const observation = fixture.createViewerProvisionObservation();
      const stop = vi.fn();
      expect(task15RunStderr(Uint8Array.of(85), observation, stop, count)).toEqual({
        count: count + 1,
        failed: true,
      });
      expect(stop).toHaveBeenCalledTimes(count === 4096 ? 1 : 0);
      expect(emitted(observation)).toBe(
        `US_DEMO_VIEWER_PROVISION_OBSERVATION 0 ${count === 4096 ? 24 : 8} 0 0 0`,
      );
    }
  });

  it("latches its sole failure emission attempt even when the output sink throws", () => {
    const observation = fixture.createViewerProvisionObservation();
    let calls = 0;
    expect(() =>
      observation.emitFailure(() => {
        calls++;
        throw new Error("private");
      }),
    ).not.toThrow();
    observation.emitFailure(() => {
      calls++;
    });
    expect(calls).toBe(1);
  });

  it("requires an observed close category as well as the close bit for native recognition", () => {
    const observation = fixture.createViewerProvisionObservation();
    observation.stderr(Buffer.from(wire));
    observation.mark(128);
    expect(emitted(observation)).toBe("US_DEMO_VIEWER_PROVISION_OBSERVATION 0 128 0 0 0");
  });

  it("actual timer error and close callbacks preserve stop signal and completion counts", () => {
    for (const [kind, expectedMask, expectedStops, signal, expectedFailed] of [
      ["timer", 32, 1, null, false],
      ["kill", 64, 0, "SIGKILL", true],
      ["stdin", 4, 1, null, false],
      ["error", 2, 0, null, true],
      ["close", 128, 0, null, false],
    ] as const) {
      const observation = fixture.createViewerProvisionObservation();
      const stop = vi.fn(),
        kill = vi.fn(),
        done = vi.fn();
      const failed = task15PureCode(
        `let failed = false; (${task15ProvisionCallback(kind)})(1); failed`,
        { observation, stop, child: { kill }, done },
      );
      expect(failed).toBe(expectedFailed);
      expect(stop).toHaveBeenCalledTimes(expectedStops);
      expect(kill.mock.calls).toEqual(signal ? [[signal]] : []);
      expect(done.mock.calls).toEqual(kind === "close" ? [[1]] : []);
      expect(emitted(observation)).toBe(
        `US_DEMO_VIEWER_PROVISION_OBSERVATION 0 ${expectedMask} ${kind === "close" ? 2 : 0} 0 0`,
      );
    }
    for (const initialCount of [4095, 4096]) {
      const observation = fixture.createViewerProvisionObservation();
      const stop = vi.fn();
      const result = task15PureCode(
        `let count = initialCount, stdout = Buffer.alloc(0);
        (${task15ProvisionCallback("stdout")})(Uint8Array.of(1)); ({count, length: stdout.length})`,
        { observation, stop, Buffer, Uint8Array, initialCount },
      );
      expect(result).toEqual({ count: initialCount + 1, length: initialCount === 4095 ? 1 : 0 });
      expect(stop).toHaveBeenCalledTimes(initialCount === 4096 ? 1 : 0);
    }
  });

  it("actual outer failure emits only after close settles and preserves both original final errors", async () => {
    const source = ts.createSourceFile("fixture.ts", task10Source(), ts.ScriptTarget.Latest, true);
    const start = source.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "startUsDemoViewerBrowserFixture",
    );
    const regions = start?.body?.statements.filter(ts.isTryStatement) ?? [];
    expect(regions).toHaveLength(1);
    const body = regions[0]?.catchClause?.block.getText(source);
    if (!body) throw new Error("Missing actual outer catch");
    for (const failedClose of [false, true])
      for (const phase of ["provision", "initialize", "descriptors"]) {
        const order: string[] = [];
        const provisionObservation = fixture.createViewerProvisionObservation();
        let message = "";
        try {
          await task15PureCode(`(async () => ${body})()`, {
            phase,
            provisionObservation,
            viewerBrowserFailure: fixture.viewerBrowserFailure,
            setup: { pendingCount: () => 1 },
            close: async () => {
              order.push("close");
              await Promise.resolve();
              order.push("settled");
              if (failedClose) throw false;
            },
            console: {
              error(line: string) {
                order.push(line);
                throw new Error("private");
              },
            },
          });
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof error.message === "string"
          )
            message = error.message;
        }
        expect(order).toEqual(
          phase === "provision"
            ? ["close", "settled", "US_DEMO_VIEWER_PROVISION_OBSERVATION 0 0 0 0 0"]
            : ["close", "settled"],
        );
        expect(message).toBe(
          `Viewer browser failed: ${phase}${failedClose ? "; disposal incomplete: pending-setup=1" : ""}`,
        );
      }
  });
});
function assertTask10Preserved(source: string) {
  source = task15RestoreFixture(source);
  // Validate the entire introduced structure/wiring before any exact inverse erasure.
  expect(source.split(task10Helper)).toHaveLength(2);
  expect(source.split(task10Branch)).toHaveLength(2);
  const original = source.replace(task10Helper, "").replace(task10Branch, task10OriginalBranch);
  expect(createHash("sha256").update(original).digest("hex")).toBe(task10OriginalSha256);
}

describe("Task10 guard observation", () => {
  const valid: Record<string, string | undefined> = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_JOB: "demo_viewer_acceptance",
    RUNNER_ENVIRONMENT: "github-hosted",
    US_TEST_DATABASE_URL:
      "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
  };

  it("maps each independent predicate to its fixed bit without authorizing entry", () => {
    // Synthetic PURE formatter data only: never call the actual entry with this object.
    expect(fixture.viewerGuardObservation(valid, "linux")).toBe(
      "US_DEMO_VIEWER_GUARD_OBSERVATION 0",
    );
    for (const [key, value, expected] of [
      ["CI", "false", 1],
      ["GITHUB_ACTIONS", "false", 2],
      ["GITHUB_JOB", "other", 4],
      ["RUNNER_ENVIRONMENT", "other", 8],
      ["US_TEST_DATABASE_URL", "private-sentinel-url", 32],
      ["NODE_OPTIONS", "private-sentinel-options", 64],
      ["NODE_PATH", "private-sentinel-path", 128],
      ["DEBUG", "private-sentinel-debug", 256],
      ["PWDEBUG", "private-sentinel-pwdebug", 512],
    ] as const) {
      expect(fixture.viewerGuardObservation({ ...valid, [key]: value }, "linux")).toBe(
        `US_DEMO_VIEWER_GUARD_OBSERVATION ${expected}`,
      );
    }
    expect(fixture.viewerGuardObservation(valid, "darwin")).toBe(
      "US_DEMO_VIEWER_GUARD_OBSERVATION 16",
    );
    expect(
      fixture.viewerGuardObservation(
        { CI: "false", NODE_OPTIONS: "x", NODE_PATH: "x", DEBUG: "x", PWDEBUG: "x" },
        "darwin",
      ),
    ).toBe("US_DEMO_VIEWER_GUARD_OBSERVATION 1023");
    expect(fixture.viewerGuardObservation({ ...valid, CI: "false", DEBUG: "x" }, "darwin")).toBe(
      "US_DEMO_VIEWER_GUARD_OBSERVATION 273",
    );
  });

  it("distinguishes exact identity strings from empty and truthy forbidden strings", () => {
    for (const [key, bit] of [
      ["CI", 1],
      ["GITHUB_ACTIONS", 2],
      ["GITHUB_JOB", 4],
      ["RUNNER_ENVIRONMENT", 8],
      ["US_TEST_DATABASE_URL", 32],
    ] as const) {
      for (const value of [undefined, "", "false", "0", "true "])
        expect(fixture.viewerGuardObservation({ ...valid, [key]: value }, "linux")).toBe(
          `US_DEMO_VIEWER_GUARD_OBSERVATION ${bit}`,
        );
    }
    for (const [key, bit] of [
      ["NODE_OPTIONS", 64],
      ["NODE_PATH", 128],
      ["DEBUG", 256],
      ["PWDEBUG", 512],
    ] as const) {
      for (const value of [undefined, ""])
        expect(fixture.viewerGuardObservation({ ...valid, [key]: value }, "linux")).toBe(
          "US_DEMO_VIEWER_GUARD_OBSERVATION 0",
        );
      for (const value of ["false", "0", " ", "secret\nforged-observation"])
        expect(fixture.viewerGuardObservation({ ...valid, [key]: value }, "linux")).toBe(
          `US_DEMO_VIEWER_GUARD_OBSERVATION ${bit}`,
        );
    }
  });

  it("never reads unknown keys or serializes sentinel values, causes or getters", () => {
    const env = { ...valid, NODE_PATH: "private-sentinel\nforged-log", DEBUG: "session-secret" };
    Object.defineProperty(env, "unknown", {
      enumerable: true,
      get() {
        throw new Error("unknown-private-sentinel");
      },
    });
    Object.defineProperty(env, "toJSON", {
      get() {
        throw new Error("serializer-private-sentinel");
      },
    });
    const line = fixture.viewerGuardObservation(env, "linux");
    expect(line).toBe("US_DEMO_VIEWER_GUARD_OBSERVATION 384");
    expect(line).not.toMatch(/sentinel|secret|session|unknown|forged/);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(37);
  });

  it("retains the exact real negative refusal if the synchronous output sink throws", async () => {
    vi.stubEnv("CI", "false");
    const output = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("private-output-sentinel", { cause: "private-cause" });
    });
    try {
      await expect(fixture.startUsDemoViewerBrowserFixture()).rejects.toEqual(
        new Error("us_demo_viewer_ci_only"),
      );
      expect(output).toHaveBeenCalledTimes(1);
    } finally {
      output.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("pins the complete original guard and post-branch bytes after an exact two-part inverse", () => {
    assertTask10Preserved(task10Source());
  });

  it("rejects finite predicate, wiring, emission, catch, throw and acquisition mutants before erasure", () => {
    const source = task10Source();
    assertTask10Preserved(source);
    const mutations: [string, string][] = [
      ['    env.CI !== "true",', '    env.CI !== "false",'],
      ["Boolean(env.NODE_PATH),", "false,"],
      ["failed ? 1 << index : 0", "failed ? 1 << (index + 1) : 0"],
      ["CI: process.env.CI,", 'CI: "true",'],
      ["NODE_PATH: process.env.NODE_PATH,", "NODE_PATH: process.env.NODE_OPTIONS,"],
      ["          process.platform,", '          "linux",'],
      [
        "console.error(\n        viewerGuardObservation(",
        "console.log(\n        viewerGuardObservation(",
      ],
      [
        "    try {\n      console.error(",
        '    console.error("duplicate");\n    try {\n      console.error(',
      ],
      [
        "    } catch {\n      // Observation",
        "    } catch (error) {\n      throw error;\n      // Observation",
      ],
      ['    throw new Error("us_demo_viewer_ci_only");', "    return undefined;"],
      ['    throw new Error("us_demo_viewer_ci_only");', '    throw new Error("changed");'],
      [
        '    throw new Error("us_demo_viewer_ci_only");',
        '    if (false) throw new Error("us_demo_viewer_ci_only");',
      ],
      [
        "  let installation: Installation | undefined, app: OwnedServer | undefined;",
        '  console.error("success-output");\n  let installation: Installation | undefined, app: OwnedServer | undefined;',
      ],
      ['    process.env.CI !== "true" ||', '    process.env.CI !== "false" ||'],
      ["    process.env.NODE_PATH ||", "    false ||"],
      ["  const remaining = () => setup.remaining();", "  const remaining = () => 60_000;"],
      [
        '    vite = startOwnedServer("vite", process.env, cleanupDeadline);',
        '    vite = startOwnedServer("vite", {}, cleanupDeadline);',
      ],
    ];
    for (const [before, after] of mutations) {
      expect(source.split(before)).toHaveLength(2);
      expect(() => assertTask10Preserved(source.replace(before, after))).toThrow();
    }
    for (const candidate of [
      source.replace(task10Helper, ""),
      source.replace(task10Helper, task10Helper + task10Helper),
      source.replace(task10Branch, ""),
      source.replace(task10Branch, task10Branch + task10Branch),
      source + "\n",
    ])
      expect(() => assertTask10Preserved(candidate)).toThrow();
  });

  it("emits one bounded failure observation while retaining the exact real negative refusal", async () => {
    vi.stubEnv("CI", "false");
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(fixture.startUsDemoViewerBrowserFixture()).rejects.toEqual(
        new Error("us_demo_viewer_ci_only"),
      );
      expect(output).toHaveBeenCalledTimes(1);
      const args: unknown[] | undefined = output.mock.calls[0];
      expect(args).toHaveLength(1);
      const line: unknown = args?.[0];
      expect(typeof line).toBe("string");
      if (typeof line !== "string") throw new Error("Missing finite guard observation");
      expect(line).toMatch(/^US_DEMO_VIEWER_GUARD_OBSERVATION [0-9]{1,4}$/);
      const mask = Number(line.split(" ")[1]);
      expect(mask).toBeLessThanOrEqual(1023);
      expect(mask & 1).toBe(1);
    } finally {
      output.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe("viewer browser failure-only boundaries", () => {
  it("keeps dependent browser normal order while held context does not block independent cleanup or cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const calls: string[] = [];
    let failContext!: () => void, drained!: () => void;
    const server = {
      close: async () => {
        calls.push("server");
      },
    };
    const browser = {
      close: async () => {
        calls.push("client");
      },
    };
    const context = {
      close: () => {
        calls.push("context");
        return new Promise<void>((_, reject) => {
          failContext = () => reject(new Error("sentinel-private"));
        });
      },
    };
    const owner = fixture.viewerOwnedShutdown({
      normal: () => fixture.closeViewerBrowserSession(server, context, browser),
      terminate: () => {
        calls.push("owned-kill");
        failContext();
        drained();
      },
      kill: () => {
        calls.push("owned-kill-again");
      },
      drained: new Promise<void>((done) => {
        drained = done;
      }),
    });
    const close = fixture
      .disposeViewerBrowserResources([
        { phase: "browser", dispose: owner },
        {
          phase: "vite",
          dispose: () => {
            calls.push("vite");
          },
        },
        {
          phase: "application",
          dispose: () => {
            calls.push("api");
          },
        },
        {
          phase: "installation",
          dispose: () => {
            calls.push("installation");
          },
        },
      ])
      .catch((error: unknown) => error);
    try {
      expect(calls).toEqual(["context", "vite", "api"]);
      await vi.advanceTimersByTimeAsync(50_000);
      expect(calls).toEqual([
        "context",
        "vite",
        "api",
        "owned-kill",
        "client",
        "server",
        "installation",
      ]);
      expect(await close).toBeInstanceOf(AggregateError);
      expect(inspect(await close)).not.toContain("sentinel-private");
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects a same-tick late handle before the timer callback can run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const cancel = vi.fn(),
      close = vi.fn(async () => {});
    const owner = new fixture.ViewerSetupDeadline(cancel);
    let release!: () => void;
    const work = owner.run(
      "browser",
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
      close,
    );
    const failed = expect(work).rejects.toThrow("browser");
    await Promise.resolve();
    const clock = vi.spyOn(performance, "now").mockReturnValue(60_000);
    try {
      release();
      await failed;
      await owner.drain();
      expect(close).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
      owner.stop();
      vi.useRealTimers();
    }
  });
  it("fails a pending native initialize at its single 900000 cap without restoring setup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const owner = new fixture.ViewerSetupDeadline(() => {});
    let release!: () => void;
    const work = owner.initialize(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const failed = expect(work).rejects.toThrow("initialize");
    try {
      await vi.advanceTimersByTimeAsync(900_000);
      await failed;
      expect(() => owner.remaining()).toThrow();
      release();
      await owner.drain();
      expect(() => owner.finish()).toThrow();
    } finally {
      owner.stop();
      vi.useRealTimers();
    }
  });
  it("late owner shutdown uses the existing disposal deadline instead of resetting it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const end = performance.now() + 60_000;
    let drain!: () => void;
    const calls: string[] = [];
    const close = fixture.viewerOwnedShutdown(
      {
        normal: () => {
          calls.push("normal");
        },
        terminate: () => {
          calls.push("TERM");
        },
        kill: () => {
          calls.push("KILL");
        },
        drained: new Promise<void>((done) => {
          drain = done;
        }),
      },
      () => end,
    );
    try {
      await vi.advanceTimersByTimeAsync(49_000);
      const failed = expect(close()).rejects.toThrow("disposal");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toEqual(["normal", "TERM"]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toEqual(["normal", "TERM", "KILL"]);
      drain();
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });
  it("latches common setup expiry, cancels once, closes late acquisition and forbids next stage", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const cancel = vi.fn(),
      close = vi.fn(async () => {}),
      next = vi.fn();
    let release!: (value: { close(): Promise<void> }) => void;
    const owner = new fixture.ViewerSetupDeadline(cancel);
    const work = owner.run(
      "installation",
      () =>
        new Promise<{ close(): Promise<void> }>((done) => {
          release = done;
        }),
      (value) => value.close(),
    );
    const failed = expect(work).rejects.toThrow("installation");
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await failed;
      expect(cancel).toHaveBeenCalledTimes(1);
      await expect(owner.run("application", async () => next())).rejects.toThrow();
      release({ close });
      await owner.drain();
      owner.stop();
      expect(close).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(() => owner.finish()).toThrow();
    } finally {
      owner.stop();
      vi.useRealTimers();
    }
  });
  it("observes late rejection and same-tick fulfillment without leaking original errors", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      for (const rejectLate of [false, true]) {
        const owner = new fixture.ViewerSetupDeadline(() => {});
        let settle!: () => void;
        const close = vi.fn(async () => {});
        const work = owner.run(
          "browser",
          () =>
            new Promise<object>((resolve, reject) => {
              settle = () => (rejectLate ? reject(new Error("sentinel-private")) : resolve({}));
            }),
          close,
        );
        const caught = work.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(60_000);
        settle();
        await owner.drain();
        expect(inspect(await caught)).not.toContain("sentinel-private");
        expect(close).toHaveBeenCalledTimes(rejectLate ? 0 : 1);
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it("charges one common budget and only one bounded native initialize pause", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const owner = new fixture.ViewerSetupDeadline(() => {});
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      let release!: () => void;
      const initialization = owner.initialize(
        () =>
          new Promise<void>((done) => {
            release = done;
          }),
      );
      await vi.advanceTimersByTimeAsync(800_000);
      release();
      await initialization;
      expect(owner.remaining()).toBe(50_000);
      await expect(owner.initialize(async () => {})).rejects.toThrow("initialize");
      expect(() => owner.finish()).toThrow();
    } finally {
      owner.stop();
      vi.useRealTimers();
    }
  });
  it("attempts all independent closers and retains late dependency cleanup after disposal deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const installation = vi.fn(),
      other = vi.fn(() => {
        throw new Error("sentinel-private");
      });
    const closing = fixture.disposeViewerBrowserResources([
      { phase: "context", dispose: () => pending },
      { phase: "vite", dispose: other },
      { phase: "installation", dispose: installation },
    ]);
    const caught = closing.catch((error: unknown) => error);
    try {
      expect(other).toHaveBeenCalledTimes(1);
      expect(installation).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(inspect(await caught)).toContain("disposal incomplete");
      expect(installation).not.toHaveBeenCalled();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(installation).toHaveBeenCalledTimes(1);
      expect(inspect(await caught)).not.toContain("sentinel-private");
    } finally {
      release();
      vi.useRealTimers();
    }
  });
  it("uses exact owned normal TERM KILL order once, drains before installation and permanently fails force", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const calls: string[] = [];
    let drain!: () => void;
    const close = fixture.viewerOwnedShutdown({
      normal: () => {
        calls.push("normal");
      },
      terminate: () => {
        calls.push("TERM");
      },
      kill: () => {
        calls.push("KILL");
      },
      drained: new Promise<void>((done) => {
        drain = done;
      }),
    });
    const first = close();
    expect(close()).toBe(first);
    const caught = first.catch((error: unknown) => error);
    const installation = vi.fn();
    const disposal = fixture
      .disposeViewerBrowserResources([
        { phase: "browser", dispose: close },
        { phase: "installation", dispose: installation },
      ])
      .catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(55_000);
      expect(calls).toEqual(["normal", "TERM", "KILL"]);
      expect(installation).not.toHaveBeenCalled();
      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(await caught).toBeInstanceOf(Error);
      expect(await disposal).toBeInstanceOf(AggregateError);
      expect(installation).toHaveBeenCalledTimes(1);
    } finally {
      drain();
      vi.useRealTimers();
    }
  });
  it("starts independent cleanup even when an earlier owned close remains pending", async () => {
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const next = vi.fn();
    const closing = fixture.disposeViewerBrowserResources([
      { phase: "context", dispose: () => pending },
      { phase: "vite", dispose: next },
    ]);
    try {
      expect(next).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await closing;
    }
  });
  it.each([
    ["amended", "2026-06-10", "Amended · Jun 10, 2026"],
    ["void", "2026-08-10", "Void · Aug 10, 2026"],
  ] as const)(
    "matches exact combined %s history node and rejects wrong historical identity",
    (status, eventDate, text) => {
      const expected: fixture.ViewerHistoryExpectation = {
        eventId: "a0000000-0000-4000-8000-000000000001",
        rootId: "a0000000-0000-4000-8000-000000000001",
        type: "receiving",
        eventNumber: "REC-26-0001",
        revision: 1,
        status,
        eventDate,
        previousRevisionId: null,
        nextRevisionId: status === "amended" ? "a0000000-0000-4000-8000-000000000002" : null,
      };
      const row = {
        ...expected,
        reason: "Synthetic history",
        createdAt: "2026-10-22T00:00:00.000Z",
      };
      const page = { items: [row], nextCursor: null };
      expect(fixture.viewerHistoryPresentation(page, expected)).toEqual({
        eventLabel: "Event REC-26-0001 · rev 1",
        statusDate: text,
      });
      for (const wrong of [
        { eventId: "b0000000-0000-4000-8000-000000000001" },
        { rootId: "b0000000-0000-4000-8000-000000000001" },
        { revision: 2 },
        { status: "draft" },
        { eventDate: "2026-06-09" },
        { eventNumber: "REC-26-0002" },
      ])
        expect(() =>
          fixture.viewerHistoryPresentation({ ...page, items: [{ ...row, ...wrong }] }, expected),
        ).toThrow();
      expect(() =>
        fixture.viewerHistoryPresentation({ ...page, items: [row, row] }, expected),
      ).toThrow();
      expect(() => fixture.viewerHistoryPresentation({ ...page, items: [] }, expected)).toThrow();
    },
  );
  it("drops auth call logs, causes, DOM, hostile getters and unknown phase values", async () => {
    const secret = "sentinel-password-token-factor";
    for (const error of [
      new Error(`fill(${secret})`, { cause: secret }),
      {
        get message() {
          throw new Error(secret);
        },
      },
      secret,
    ]) {
      let caught: unknown;
      try {
        await fixture.viewerBrowserPhase("authentication", async () => {
          throw error;
        });
      } catch (failure) {
        caught = failure;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("Viewer browser failed: authentication");
      expect(inspect(caught, { depth: 10 })).not.toContain(secret);
      expect(Object.hasOwn(caught as Error, "cause")).toBe(false);
    }
    expect(fixture.viewerBrowserFailure(secret).message).toBe("Viewer browser failed: unknown");
  });

  it("continues every owned disposal boundary and emits only finite failures", async () => {
    for (let failed = 0; failed < 6; failed++) {
      const closed: string[] = [];
      const phases = [
        "context",
        "browser",
        "vite",
        "application",
        "private-stores",
        "installation",
      ] as const;
      const stages = phases.map((phase, index) => ({
        phase,
        async dispose() {
          closed.push(phase);
          if (index === failed) throw new Error("sentinel-private");
        },
      }));
      let failure: unknown;
      try {
        await fixture.disposeViewerBrowserResources(stages);
      } catch (error) {
        failure = error;
      }
      expect(closed).toEqual(phases);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(inspect(failure, { depth: 10 })).not.toContain("sentinel-private");
    }
  });

  it("refuses before import/acquisition/listen when actual CI identity is absent", async () => {
    vi.stubEnv("CI", "false");
    try {
      await expect(fixture.startUsDemoViewerBrowserFixture()).rejects.toThrow(
        "us_demo_viewer_ci_only",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses an occupied invocation-owned ephemeral port without closing its owner", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Owned ephemeral address missing");
      await expect(fixture.requireViewerFreePort(address.port, "127.0.0.1")).rejects.toThrow(
        "Viewer browser failed: ports",
      );
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(server.listening).toBe(false);
  });
});
