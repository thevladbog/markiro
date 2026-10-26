import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { Script } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  createUsViewerCommandObservation,
  viewerCommandEnvironment,
} from "../src/deployment/us-viewer-command";
import { readOwnerPassword } from "../src/deployment/us-owner-command";

const raw = () => parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8"));
const tenantId = "11111111-1111-4111-8111-111111111111";
const originalOwnerId = "22222222-2222-4222-8222-222222222222";
const verify = ["verify", "--tenant-id", tenantId, "--owner-id", originalOwnerId];
const provision = ["provision", ...verify.slice(1), "--confirm-local-synthetic-viewer"];
const marker = "Synthetic-stdin-secret-not-for-output-42!";

const task15NativePairs: readonly (readonly [string, string])[] = [
  [
    'import { viewerCommandEnvironment } from "./deployment/us-viewer-command";\n',
    'import {\n  createUsViewerCommandObservation,\n  viewerCommandEnvironment,\n} from "./deployment/us-viewer-command";\n',
  ],
  ["", "const observation = createUsViewerCommandObservation();\n\n"],
  ["", '  observation.enter("arguments");\n'],
  ["", '  observation.enter("stdin");\n'],
  ["", '  observation.enter("connect");\n'],
  ["", '    observation.enter("database_identity");\n'],
  ["", '    observation.enter("store");\n'],
  ["", '    observation.enter("result_output");\n'],
  ["", "  } catch (error) {\n    observation.fail();\n    throw error;\n"],
  [
    "    await connection.pool.end();\n",
    '    observation.enter("pool_close");\n    let poolClosed = false;\n    try {\n      await connection.pool.end();\n      poolClosed = true;\n    } finally {\n      if (!poolClosed) observation.closeFailed();\n    }\n',
  ],
  ["void main().catch(() => {\n", "void main().catch(() => {\n  observation.fail();\n"],
  ["", "  observation.emitFailure((line) => console.error(line));\n"],
];
const task15CommandAddition =
  '\n/** Failure-only scalar observation; never receives an exception or command input. */\nexport function createUsViewerCommandObservation() {\n  let phase = 0,\n    first = 0,\n    hasFailure = false,\n    cleanupFailed = false,\n    attempted = false;\n  const fail = () => {\n    if (!hasFailure) {\n      hasFailure = true;\n      first = phase;\n    }\n  };\n  return {\n    enter(value: unknown) {\n      phase =\n        value === "arguments"\n          ? 1\n          : value === "stdin"\n            ? 2\n            : value === "connect"\n              ? 3\n              : value === "database_identity"\n                ? 4\n                : value === "store"\n                  ? 5\n                  : value === "result_output"\n                    ? 6\n                    : value === "pool_close"\n                      ? 7\n                      : 0;\n    },\n    fail,\n    closeFailed() {\n      fail();\n      cleanupFailed = true;\n    },\n    emitFailure(sink: (line: string) => void) {\n      if (!hasFailure || attempted) return;\n      attempted = true;\n      try {\n        sink(`US_VIEWER_PROVISION_OBSERVATION ${first} ${cleanupFailed ? 1 : 0}`);\n      } catch {\n        // Observation must not mask the original refusal or finally precedence.\n      }\n    },\n  };\n}\n';
function task15ExactInverse(source: string, pairs: readonly (readonly [string, string])[]) {
  for (const [, after] of pairs) expect(source.split(after)).toHaveLength(2);
  for (const [before, after] of pairs) source = source.replace(after, before);
  return source;
}

function task15AssertNativePlacement(source: string) {
  // Bind each addition to its operation and owner before inverse erasure.
  for (const anchor of [
    'import { UsDevelopmentViewerStore } from "./deployment/us-development-viewer";\n\nconst observation = createUsViewerCommandObservation();\n\nasync function main() {\n  observation.enter("arguments");\n  const command = viewerCommandEnvironment(process.argv.slice(2), process.env);',
    '  const command = viewerCommandEnvironment(process.argv.slice(2), process.env);\n  observation.enter("stdin");\n  if (process.stdin.isTTY) throw new Error("stdin_pipe_required");\n  const password = await readOwnerPassword(process.stdin);\n  observation.enter("connect");\n  const connection = createDb(command.env.DATABASE_URL, {',
    '  connection.pool.on("error", () => {});\n  try {\n    observation.enter("database_identity");\n    const identity = await connection.pool.query<{ name: string; owner: string }>(',
    '      throw new Error("database_identity_mismatch");\n    observation.enter("store");\n    const context = {',
    '        : await store.verify(context, password);\n    observation.enter("result_output");\n    console.log(JSON.stringify(result));\n  } catch (error) {\n    observation.fail();\n    throw error;\n  } finally {\n    observation.enter("pool_close");\n    let poolClosed = false;\n    try {\n      await connection.pool.end();\n      poolClosed = true;\n    } finally {\n      if (!poolClosed) observation.closeFailed();\n    }\n  }\n}',
    "void main().catch(() => {\n  observation.fail();\n  // Driver, configuration and password errors must never escape into logs.\n  console.error(",
    "  process.exitCode = 1;\n  observation.emitFailure((line) => console.error(line));\n});",
  ])
    expect(source.split(anchor)).toHaveLength(2);
}

function task15NativeSource() {
  return readFileSync(resolve(__dirname, "../src/main.us-viewer.ts"), "utf8");
}

function task15TerminalCallback() {
  const source = ts.createSourceFile("main.ts", task15NativeSource(), ts.ScriptTarget.Latest, true);
  const found: ts.ArrowFunction[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "main().catch") {
      const callback = node.arguments[0];
      if (callback && ts.isArrowFunction(callback)) found.push(callback);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(found).toHaveLength(1);
  const callback = found[0];
  if (!callback) throw new Error("Missing actual terminal callback");
  return callback.getText(source);
}

function task15Evaluate(code: string, context: Record<string, unknown>): unknown {
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Script(compiled).runInNewContext(context, { timeout: 1000 });
}

describe("Task15 provision observation", () => {
  it("restores the exact original native command and validator before accepting observation edits", () => {
    const verify = (source: string) => {
      task15AssertNativePlacement(source);
      expect(
        createHash("sha256").update(task15ExactInverse(source, task15NativePairs)).digest("hex"),
      ).toBe("d9377de56902fe8e043299248f35c45e44af7b5c23ad98bb4fc536c4d567be91");
    };
    const source = task15NativeSource();
    verify(source);
    const stdinPhase = '  observation.enter("stdin");\n';
    const passwordRead = "  const password = await readOwnerPassword(process.stdin);\n";
    expect(source.split(stdinPhase)).toHaveLength(2);
    expect(source.split(passwordRead)).toHaveLength(2);
    expect(() =>
      verify(source.replace(stdinPhase, "").replace(passwordRead, passwordRead + stdinPhase)),
    ).toThrow();
    for (const [, after] of task15NativePairs) {
      expect(() => verify(source.replace(after, ""))).toThrow();
      expect(() => verify(source.replace(after, after + after))).toThrow();
    }
    for (const [before, after] of [
      ['observation.enter("stdin");', 'observation.enter("store");'],
      [
        "    observation.fail();\n    throw error;",
        "    observation.fail();\n    throw undefined;",
      ],
      ["if (!poolClosed) observation.closeFailed();", "if (poolClosed) observation.closeFailed();"],
      ["      poolClosed = true;", "      poolClosed = false;"],
      ["process.exitCode = 1;", "process.exitCode = 0;"],
      ["max: 1,", "max: 2,"],
      ["console.log(JSON.stringify(result));", "console.log(JSON.stringify({}));"],
      ["observation.emitFailure((line) => console.error(line));", 'console.error("success");'],
    ] as const) {
      expect(source.split(before)).toHaveLength(2);
      expect(() => verify(source.replace(before, after))).toThrow();
    }
    expect(() => verify(source + "\n")).toThrow();
    const command = readFileSync(
      resolve(__dirname, "../src/deployment/us-viewer-command.ts"),
      "utf8",
    );
    expect(command.endsWith(task15CommandAddition)).toBe(true);
    const restored = task15ExactInverse(command, [["", task15CommandAddition]]);
    expect(createHash("sha256").update(restored).digest("hex")).toBe(
      "7d75f010e27420f62b3b7e11f8ff22e50e0137ba0d14f24f58396e06787de8d2",
    );
    for (const [before, after] of [
      ["if (!hasFailure)", "if (!first)"],
      ["attempted = true;", "attempted = false;"],
      ['value === "stdin"', 'value === "password"'],
      ["cleanupFailed = true;", "cleanupFailed = false;"],
    ] as const) {
      expect(command.split(before)).toHaveLength(2);
      expect(() =>
        task15ExactInverse(command.replace(before, after), [["", task15CommandAddition]]),
      ).toThrow();
    }
  });
  it("rejects construction and every native phase displacement before inverse erasure", () => {
    const source = task15NativeSource();
    task15AssertNativePlacement(source);
    for (const [addition, later] of [
      ["const observation = createUsViewerCommandObservation();\n\n", "async function main() {\n"],
      [
        '  observation.enter("arguments");\n',
        "  const command = viewerCommandEnvironment(process.argv.slice(2), process.env);\n",
      ],
      [
        '  observation.enter("stdin");\n',
        "  const password = await readOwnerPassword(process.stdin);\n",
      ],
      ['  observation.enter("connect");\n', '  connection.pool.on("error", () => {});\n'],
      [
        '    observation.enter("database_identity");\n',
        '      throw new Error("database_identity_mismatch");\n',
      ],
      [
        '    observation.enter("store");\n',
        "    const store = new UsDevelopmentViewerStore(connection.db);\n",
      ],
      ['    observation.enter("result_output");\n', "    console.log(JSON.stringify(result));\n"],
      ['    observation.enter("pool_close");\n', "      await connection.pool.end();\n"],
      [
        "  observation.emitFailure((line) => console.error(line));\n",
        "  // Driver, configuration and password errors must never escape into logs.\n",
      ],
    ] as const) {
      expect(source.split(addition)).toHaveLength(2);
      expect(source.split(later)).toHaveLength(2);
      const displaced = source.replace(addition, "").replace(later, later + addition);
      // Assert the placement gate itself rejects, before any inverse/hash can hide a move.
      expect(() => task15AssertNativePlacement(displaced)).toThrow();
    }
  });
  it("actual terminal callback emits finite evidence after the unchanged refusal and exit", () => {
    const lines: string[] = [];
    const processCell: { exitCode?: number } = {};
    task15Evaluate(`(${task15TerminalCallback()})(undefined)`, {
      console: { error: (line: string) => lines.push(line) },
      process: processCell,
      observation: {
        fail() {},
        emitFailure(sink: (line: string) => void) {
          expect(processCell.exitCode).toBe(1);
          sink("US_VIEWER_PROVISION_OBSERVATION 1 0");
        },
      },
    });
    expect(lines).toEqual([
      "US synthetic viewer command refused. Check exact arguments, isolated migrated database, trusted owner/profile and password input. Existing identities are never repaired or reset.",
      "US_VIEWER_PROVISION_OBSERVATION 1 0",
    ]);
    expect(processCell.exitCode).toBe(1);
  });

  it("projects every native phase and refuses to coerce private unknown inputs", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(marker);
        },
        ownKeys() {
          throw new Error(marker);
        },
      },
    );
    for (const [phase, code] of [
      ["arguments", 1],
      ["stdin", 2],
      ["connect", 3],
      ["database_identity", 4],
      ["store", 5],
      ["result_output", 6],
      ["pool_close", 7],
      [undefined, 0],
      [null, 0],
      [false, 0],
      [marker, 0],
      [hostile, 0],
    ] as const) {
      const observation = createUsViewerCommandObservation();
      const lines: string[] = [];
      observation.enter(phase);
      observation.emitFailure((line) => lines.push(line));
      expect(lines).toEqual([]);
      observation.fail();
      observation.enter("pool_close");
      observation.closeFailed();
      observation.emitFailure((line) => lines.push(line));
      observation.emitFailure(() => {
        throw new Error("must not retry");
      });
      expect(lines).toEqual([`US_VIEWER_PROVISION_OBSERVATION ${code} 1`]);
      expect(JSON.stringify(observation)).not.toContain(marker);
    }
  });

  it("latches before a diagnostic sink throws and never masks or retries", () => {
    const observation = createUsViewerCommandObservation();
    observation.enter("stdin");
    observation.fail();
    let attempts = 0;
    expect(() =>
      observation.emitFailure(() => {
        attempts++;
        throw new Error(marker);
      }),
    ).not.toThrow();
    observation.emitFailure(() => {
      attempts++;
    });
    expect(attempts).toBe(1);
  });

  it("actual terminal callback preserves generic-first exit and both sink failure semantics", () => {
    for (const value of [undefined, null, false, 0, "", new Error(marker)]) {
      const observation = createUsViewerCommandObservation();
      observation.enter("stdin");
      const processCell: { exitCode?: number } = {};
      const lines: string[] = [];
      expect(() =>
        task15Evaluate(`(${task15TerminalCallback()})(value)`, {
          value,
          observation,
          process: processCell,
          console: {
            error(line: string) {
              lines.push(line);
              if (lines.length === 2) {
                expect(processCell.exitCode).toBe(1);
                throw value;
              }
            },
          },
        }),
      ).not.toThrow();
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^US synthetic viewer command refused\./);
      expect(lines[1]).toBe("US_VIEWER_PROVISION_OBSERVATION 2 0");
      expect(lines.join("\n")).not.toContain(marker);
      expect(processCell.exitCode).toBe(1);

      const originalSinkFailure = { private: marker };
      const failedProcess: { exitCode?: number } = {};
      let calls = 0,
        caught: unknown;
      try {
        task15Evaluate(`(${task15TerminalCallback()})(value)`, {
          value,
          observation: createUsViewerCommandObservation(),
          process: failedProcess,
          console: {
            error() {
              calls++;
              throw originalSinkFailure;
            },
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(originalSinkFailure);
      expect(calls).toBe(1);
      expect(failedProcess.exitCode).toBeUndefined();
    }
  });

  it("actual native catch/finally retains falsy rejection identity and first phase", async () => {
    const source = ts.createSourceFile(
      "main.ts",
      task15NativeSource(),
      ts.ScriptTarget.Latest,
      true,
    );
    const main = source.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "main",
    );
    const regions = main?.body?.statements.filter(ts.isTryStatement) ?? [];
    expect(regions).toHaveLength(1);
    const region = regions[0];
    if (!region || !region.catchClause || !region.finallyBlock)
      throw new Error("Missing actual owned region");
    // Replace only original operations, not the actual new catch/nested finally.
    const actual = region
      .getText(source)
      .replace(region.tryBlock.getText(source), "{ await body(); }");
    const values = [undefined, null, false, 0, "", new Error(marker)];
    for (const closeKind of ["sync", "async", "then-getter", "then-callback"])
      for (const bodyFails of [false, true])
        for (const closeFails of [false, true]) {
          for (const bodyError of values)
            for (const closeError of values) {
              const observation = createUsViewerCommandObservation();
              observation.enter("store");
              let bodyCalls = 0,
                closeCalls = 0,
                rejected = false,
                rejection: unknown;
              try {
                await task15Evaluate(`(async () => { ${actual} })()`, {
                  observation,
                  body: async () => {
                    bodyCalls++;
                    if (bodyFails) throw bodyError;
                  },
                  connection: {
                    pool: {
                      end: () => {
                        closeCalls++;
                        if (closeKind === "sync") {
                          if (closeFails) throw closeError;
                          return;
                        }
                        if (closeKind === "then-getter")
                          return Object.defineProperty({}, "then", {
                            get() {
                              if (closeFails) throw closeError;
                              return undefined;
                            },
                          });
                        if (closeKind === "then-callback")
                          return {
                            then(
                              accept: (value: undefined) => void,
                              reject: (reason: unknown) => void,
                            ) {
                              if (closeFails) reject(closeError);
                              else accept(undefined);
                            },
                          };
                        return closeFails ? Promise.reject(closeError) : Promise.resolve();
                      },
                    },
                  },
                });
              } catch (error) {
                rejected = true;
                rejection = error;
              }
              expect([bodyCalls, closeCalls]).toEqual([1, 1]);
              expect(rejected).toBe(bodyFails || closeFails);
              if (rejected) expect(rejection).toBe(closeFails ? closeError : bodyError);
              const lines: string[] = [];
              observation.emitFailure((line) => lines.push(line));
              expect(lines).toEqual(
                rejected
                  ? [`US_VIEWER_PROVISION_OBSERVATION ${bodyFails ? 5 : 7} ${closeFails ? 1 : 0}`]
                  : [],
              );
            }
        }
  });
});

describe("reserved synthetic viewer command boundary", () => {
  it.each([
    [verify, "verify"],
    [provision, "provision"],
  ] as const)("accepts the exact %j syntax and isolated environment", (args, mode) => {
    const result = viewerCommandEnvironment(args, raw());
    expect(result).toEqual({ env: expect.any(Object), mode, tenantId, originalOwnerId });
    expect(new URL(result.env.DATABASE_URL).username).toBe("markiro_us");
  });

  it.each(
    [
      [],
      ["initialize", ...provision.slice(1)],
      verify.slice(0, -1),
      provision.slice(0, -1),
      [...verify, "--confirm-local-synthetic-viewer"],
      [...provision, "--confirm-local-synthetic-viewer"],
      ["verify", "--owner-id", originalOwnerId, "--tenant-id", tenantId],
      ["--confirm-local-synthetic-viewer", ...provision.slice(0, -1)],
      [...verify, "--tenant-id", tenantId],
      [...verify, "--owner-id", originalOwnerId],
      ...["--email", "--role", "--password", "--reset", "--force", "--url"].map((flag) => [
        ...provision,
        flag,
        marker,
      ]),
      ...["", "not-a-uuid", `${tenantId} `, tenantId.replaceAll("-", ""), marker].flatMap(
        (value) => [
          ["verify", "--tenant-id", value, "--owner-id", originalOwnerId],
          ["verify", "--tenant-id", tenantId, "--owner-id", value],
        ],
      ),
    ].map((args) => [args]),
  )("refuses malformed or widened arguments #%#", (args) => {
    expect(() => viewerCommandEnvironment(args, raw())).toThrow("us_viewer_arguments_invalid");
    try {
      viewerCommandEnvironment(args, raw());
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });

  it.each([
    { NODE_ENV: "production" },
    { NODE_ENV: "" },
    { MARKIRO_DEPLOYMENT_EDITION: "RU" },
    { VITE_DEPLOYMENT_EDITION: "RU" },
    ...[
      "postgres://markiro_us:synthetic@127.0.0.1:5432/markiro_us_dev",
      "postgres://other:synthetic@127.0.0.1:55432/markiro_us_dev",
      "postgres://markiro_us:synthetic@remote.example:55432/markiro_us_dev",
      "postgres://markiro_us:synthetic@127.0.0.1:55432/markiro",
      "postgres://markiro_us:synthetic@127.0.0.1:55432/markiro_us_dev?sslmode=require",
    ].map((DATABASE_URL) => ({ DATABASE_URL })),
    { PORT: "3000" },
    { BETTER_AUTH_URL: "https://remote.example" },
  ])("refuses an unsafe environment #%# without echoing it", (overrides) => {
    expect(() => viewerCommandEnvironment(provision, { ...raw(), ...overrides })).toThrow(
      "us_viewer_environment_invalid",
    );
  });

  it.each(["", "\n", "\r\n"])("reuses bounded stdin with one final ending %j", async (ending) => {
    async function* input() {
      yield Buffer.from(marker.slice(0, 10));
      yield Buffer.from(marker.slice(10) + ending);
    }
    expect(await readOwnerPassword(input())).toBe(marker);
  });
  it.each(["x".repeat(12), "x".repeat(128), "é".repeat(128)])(
    "accepts the password character boundary #%#",
    async (password) => {
      async function* input() {
        yield Buffer.from(password);
      }
      expect(await readOwnerPassword(input())).toBe(password);
    },
  );
  it.each([
    "",
    "x".repeat(11),
    "x".repeat(129),
    `${marker}\n\n`,
    `${marker}\r`,
    `${marker}\ninside`,
    `${marker}\rinside`,
    `${marker}\0`,
    "😀".repeat(128) + "\n",
  ])("refuses invalid or over-512-byte stdin #%#", async (password) => {
    async function* input() {
      yield Buffer.from(password);
    }
    await expect(readOwnerPassword(input())).rejects.toThrow("us_development_password_invalid");
  });
  it("stops accumulating after 512 bytes", async () => {
    async function* input() {
      yield Buffer.alloc(513, 120);
      throw new Error("must not continue");
    }
    await expect(readOwnerPassword(input())).rejects.toThrow("us_development_password_invalid");
  });
});
