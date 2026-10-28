import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { observeViewerJourney } from "./support/us-viewer-journey-observation";

const checkpoints = [
  "preflight-snapshots",
  "preflight-authfacts",
  "preflight-privatebytes",
  "signin-page",
  "signin-submit",
  "mfa-enroll",
  "mfa-key",
  "mfa-verify",
  "organization",
  "authenticated-facts",
  "postauth-invariance",
  "reference-navigation",
  "first-events",
  "next-events",
  "readonly-controls",
  "lot-search",
  "lot-card-history",
  "regular-lot",
  "backward-trace",
  "forward-trace",
  "correction-history",
  "orphan-history",
  "readiness",
  "plan-download",
  "request-frozenrun",
  "request-detail",
  "browser-zip",
  "individual-artifact",
  "ui-variants",
  "audit-correlation",
  "business-provider-invariance",
  "privatebyte-invariance",
  "final-budget",
] as const;
async function outcome(action: () => Promise<unknown>) {
  try {
    return { value: await action() };
  } catch (error) {
    return { error };
  }
}
const line = (checkpoint: number) =>
  `US_DEMO_VIEWER_JOURNEY_OBSERVATION ${JSON.stringify({ checkpoint })}`;

describe("one private numeric journey witness", () => {
  it.each(checkpoints)(
    "reports only the ordinal for %s and preserves failure identity",
    async (name) => {
      const output: string[] = [];
      const primary = Object.freeze({});
      let calls = 0;
      const wrapped = observeViewerJourney(
        (value) => output.push(value),
        async (enter) => {
          calls++;
          enter(name);
          throw primary;
        },
      );
      expect(Object.isFrozen(wrapped)).toBe(true);
      const result = await outcome(wrapped);
      expect(result.error === primary).toBe(true);
      expect(calls).toBe(1);
      expect(output).toEqual([line(checkpoints.indexOf(name) + 1)]);
    },
  );

  it("preserves successful result identity without emitting or registering timers", async () => {
    vi.useFakeTimers();
    try {
      const value = Object.freeze({});
      const emit = vi.fn();
      let calls = 0;
      const wrapped = observeViewerJourney(emit, async (enter) => {
        calls++;
        enter("final-budget");
        return value;
      });
      expect(await wrapped()).toBe(value);
      expect(calls).toBe(1);
      expect(emit).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not read error getters or coerce invalid checkpoint objects", async () => {
    let effects = 0;
    const trap = () => {
      effects++;
      throw new Error("Synthetic private canary");
    };
    const primary: object = Object.create(null);
    for (const key of ["message", "stack", "cause", "toJSON", "toString"])
      Object.defineProperty(primary, key, { get: trap });
    const hostile = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
    const outputs: string[] = [];
    for (const value of [
      hostile,
      Symbol("synthetic"),
      null,
      undefined,
      1,
      new String("signin-page"),
      "foreign",
    ])
      await outcome(
        observeViewerJourney(
          (text) => outputs.push(text),
          async (enter) => {
            enter("signin-page");
            enter(value);
            throw primary;
          },
        ),
      );
    expect(effects).toBe(0);
    expect(outputs).toEqual(Array.from({ length: 7 }, () => line(0)));
  });

  it("latches before a throwing emitter and ignores late checkpoint writes", async () => {
    const primary = Object.freeze({});
    let late: ((value: unknown) => void) | undefined;
    const output: string[] = [];
    const emit = vi.fn((text: string) => {
      late?.("final-budget");
      output.push(text);
      throw new Error("Synthetic emitter failure");
    });
    const result = await outcome(
      observeViewerJourney(emit, async (enter) => {
        late = enter;
        enter("mfa-verify");
        throw primary;
      }),
    );
    late?.("request-detail");
    expect(result.error === primary).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(output).toEqual([line(8)]);
  });

  it("starts each invocation at zero and does not retain caller inputs", async () => {
    const outputs: string[] = [];
    let invocation = 0;
    const wrapped = observeViewerJourney(
      (text) => outputs.push(text),
      async (enter) => {
        if (invocation++ === 0) enter("first-events");
        throw null;
      },
    );
    await outcome(wrapped);
    await outcome(wrapped);
    expect(outputs).toEqual([line(13), line(0)]);
  });
});

const insertionPairs: readonly (readonly [string, string])[] = [
  [
    "\n          const before = await f.snapshot(),",
    '\n          enter("preflight-snapshots");\n          const before = await f.snapshot(),',
  ],
  [
    "\n          assert.deepEqual(await f.authFacts(), {",
    '\n          enter("preflight-authfacts");\n          assert.deepEqual(await f.authFacts(), {',
  ],
  [
    "\n          const privateBefore = await f.privateSnapshot();",
    '\n          enter("preflight-privatebytes");\n          const privateBefore = await f.privateSnapshot();',
  ],
  [
    "\n            await page.goto(f.origin);",
    '\n            enter("signin-page");\n            await page.goto(f.origin);',
  ],
  [
    '\n            await page.getByRole("button", { name: "Sign in", exact: true }).click();',
    '\n            enter("signin-submit");\n            await page.getByRole("button", { name: "Sign in", exact: true }).click();',
  ],
  [
    '\n            await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();',
    '\n            enter("mfa-enroll");\n            await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();',
  ],
  [
    "\n            const key = page",
    '\n            enter("mfa-key");\n            const key = page',
  ],
  [
    '\n            await page.getByRole("button", { name: "Verify", exact: true }).click();',
    '\n            enter("mfa-verify");\n            await page.getByRole("button", { name: "Verify", exact: true }).click();',
  ],
  [
    '\n            await page\n              .getByRole("button", { name: "Synthetic US development", exact: true })',
    '\n            enter("organization");\n            await page\n              .getByRole("button", { name: "Synthetic US development", exact: true })',
  ],
  [
    "\n            assert.deepEqual(await f.authFacts(), {",
    '\n            enter("authenticated-facts");\n            assert.deepEqual(await f.authFacts(), {',
  ],
  [
    "\n          const afterAuth = await f.snapshot();",
    '\n          enter("postauth-invariance");\n          const afterAuth = await f.snapshot();',
  ],
  [
    '\n          await page.getByRole("button", { name: "Open reference data", exact: true }).click();',
    '\n          enter("reference-navigation");\n          await page.getByRole("button", { name: "Open reference data", exact: true }).click();',
  ],
  [
    "\n          const events = usEventListSchema.parse(",
    '\n          enter("first-events");\n          const events = usEventListSchema.parse(',
  ],
  [
    "\n          const next = usEventListSchema.parse(",
    '\n          enter("next-events");\n          const next = usEventListSchema.parse(',
  ],
  [
    '\n          await webExpect(\n            page.getByRole("button", { name: "New receiving", exact: true }),',
    '\n          enter("readonly-controls");\n          await webExpect(\n            page.getByRole("button", { name: "New receiving", exact: true }),',
  ],
  [
    '\n            await navigate("Search");',
    '\n            enter("lot-search");\n            await navigate("Search");',
  ],
  [
    "\n            const card = usLotCardSchema.parse(",
    '\n            enter("lot-card-history");\n            const card = usLotCardSchema.parse(',
  ],
  [
    "\n          const scenario = makeUsSixMonthRegularChain(259);",
    '\n          enter("regular-lot");\n          const scenario = makeUsSixMonthRegularChain(259);',
  ],
  [
    "\n          const back = usCurrentTraceResultSchema.parse(",
    '\n          enter("backward-trace");\n          const back = usCurrentTraceResultSchema.parse(',
  ],
  [
    "\n          const forward = usCurrentTraceResultSchema.parse(",
    '\n          enter("forward-trace");\n          const forward = usCurrentTraceResultSchema.parse(',
  ],
  [
    "\n          const special = makeUsSixMonthSpecialExamples();",
    '\n          enter("correction-history");\n          const special = makeUsSixMonthSpecialExamples();',
  ],
  [
    "\n          const orphanLine = special.orphan.receiving.lines[0];",
    '\n          enter("orphan-history");\n          const orphanLine = special.orphan.receiving.lines[0];',
  ],
  [
    '\n          await navigate("Data readiness");',
    '\n          enter("readiness");\n          await navigate("Data readiness");',
  ],
  [
    '\n          await navigate("Plan");',
    '\n          enter("plan-download");\n          await navigate("Plan");',
  ],
  [
    '\n            await navigate("Requests");',
    '\n            enter("request-frozenrun");\n            await navigate("Requests");',
  ],
  [
    "\n            const detailResponse = await context.request.get(",
    '\n            enter("request-detail");\n            const detailResponse = await context.request.get(',
  ],
  [
    "\n            const browserZip = await browserDownload(",
    '\n            enter("browser-zip");\n            const browserZip = await browserDownload(',
  ],
  [
    "\n            for (const artifact of selected.publication.artifacts) {",
    '\n            enter("individual-artifact");\n            for (const artifact of selected.publication.artifacts) {',
  ],
  [
    "\n          const evidence = resolve(",
    '\n          enter("ui-variants");\n          const evidence = resolve(',
  ],
  [
    "\n          assert.equal(pageErrors, 0);",
    '\n          enter("audit-correlation");\n          assert.equal(pageErrors, 0);',
  ],
  [
    "\n          assert.deepEqual(withoutAudit(await f.snapshot()), withoutAudit(afterAuth));",
    '\n          enter("business-provider-invariance");\n          assert.deepEqual(withoutAudit(await f.snapshot()), withoutAudit(afterAuth));',
  ],
  [
    "\n          const privateAfter = await f.privateSnapshot();",
    '\n          enter("privatebyte-invariance");\n          const privateAfter = await f.privateSnapshot();',
  ],
  [
    "\n          assert.ok(performance.now() - start <= 300_000);",
    '\n          enter("final-budget");\n          assert.ok(performance.now() - start <= 300_000);',
  ],
];
const formatPairs: readonly (readonly [string, string])[] = [
  [
    '              page.getByRole("checkbox", { name: "I saved these backup codes", exact: true }),\n            ).toHaveCount(0);\n            enter("organization");\n            await page.getByRole("button", { name: "Synthetic US development", exact: true }).click();\n            await webExpect(\n              page.getByText("Synthetic demo data \u2014 not real customer activity.", { exact: true }),\n',
    '              page.getByRole("checkbox", { name: "I saved these backup codes", exact: true }),\n            ).toHaveCount(0);\n            await page\n              .getByRole("button", { name: "Synthetic US development", exact: true })\n              .click();\n            await webExpect(\n              page.getByText("Synthetic demo data \u2014 not real customer activity.", { exact: true }),\n',
  ],
  [
    '          }\n          const apiPath = (value: ViewerResponse, path: string) =>\n            new URL(value.url()).pathname === `/api/us${path}` && value.request().method() === "GET";\n          const events = usEventListSchema.parse(\n            await jsonAction(\n',
    '          }\n          const apiPath = (value: ViewerResponse, path: string) =>\n            new URL(value.url()).pathname === `/api/us${path}` &&\n            value.request().method() === "GET";\n          const events = usEventListSchema.parse(\n            await jsonAction(\n',
  ],
  [
    '                row.getByRole("button", { name: presentation.eventLabel, exact: true }),\n              ).toBeVisible();\n              await webExpect(row.getByText(presentation.statusDate, { exact: true })).toBeVisible();\n            }\n            await webExpect(\n',
    '                row.getByRole("button", { name: presentation.eventLabel, exact: true }),\n              ).toBeVisible();\n              await webExpect(\n                row.getByText(presentation.statusDate, { exact: true }),\n              ).toBeVisible();\n            }\n            await webExpect(\n',
  ],
  [
    '            forward.edges.filter(\n              (edge) =>\n                edge.kind === "shipping" && edge.quantity === "100" && edge.unitOfMeasure === "case",\n            ).length,\n            1,\n',
    '            forward.edges.filter(\n              (edge) =>\n                edge.kind === "shipping" &&\n                edge.quantity === "100" &&\n                edge.unitOfMeasure === "case",\n            ).length,\n            1,\n',
  ],
  [
    '          );\n          assert.ok(readiness.findings.some((finding) => finding.code === "origin_gap"));\n          await webExpect(page.getByText("Current origin is missing", { exact: true })).toBeVisible();\n\n          const expectedAudits: {\n',
    '          );\n          assert.ok(readiness.findings.some((finding) => finding.code === "origin_gap"));\n          await webExpect(\n            page.getByText("Current origin is missing", { exact: true }),\n          ).toBeVisible();\n\n          const expectedAudits: {\n',
  ],
  [
    '              "Retry",\n            ])\n              await webExpect(page.getByRole("button", { name: forbidden, exact: true })).toHaveCount(\n                0,\n              );\n            const detailResponse = await context.request.get(\n              `${f.origin}/api/us/traceability/export-runs/${selected.result.run.id}`,\n',
    '              "Retry",\n            ])\n              await webExpect(\n                page.getByRole("button", { name: forbidden, exact: true }),\n              ).toHaveCount(0);\n            const detailResponse = await context.request.get(\n              `${f.origin}/api/us/traceability/export-runs/${selected.result.run.id}`,\n',
  ],
  [
    "            try {\n              assert.equal(detailResponse.status(), 200);\n              detail = usRequestRunDetailSchema.parse(await boundedRead(() => detailResponse.json()));\n            } finally {\n              await detailResponse.dispose();\n",
    "            try {\n              assert.equal(detailResponse.status(), 200);\n              detail = usRequestRunDetailSchema.parse(\n                await boundedRead(() => detailResponse.json()),\n              );\n            } finally {\n              await detailResponse.dispose();\n",
  ],
  [
    '            const browserZip = await browserDownload(\n              `/traceability/export-runs/${selected.result.run.id}/artifacts/package_zip`,\n              () => frozen.getByRole("button", { name: "Download Package ZIP", exact: true }).click(),\n              zip,\n            );\n',
    '            const browserZip = await browserDownload(\n              `/traceability/export-runs/${selected.result.run.id}/artifacts/package_zip`,\n              () =>\n                frozen.getByRole("button", { name: "Download Package ZIP", exact: true }).click(),\n              zip,\n            );\n',
  ],
  [
    '                ).toBeVisible();\n                await webExpect(\n                  page.getByText(language === "en" ? "Read-only access" : "Acceso de solo lectura", {\n                    exact: true,\n                  }),\n                ).toBeVisible();\n                const themeControl = page.getByRole("button", {\n',
    '                ).toBeVisible();\n                await webExpect(\n                  page.getByText(\n                    language === "en" ? "Read-only access" : "Acceso de solo lectura",\n                    { exact: true },\n                  ),\n                ).toBeVisible();\n                const themeControl = page.getByRole("button", {\n',
  ],
];
const originalEnvelope = {
  header:
    'it(\n      "uses normal UI MFA, browses six months and verifies all 18 releases plus Plan and three ZIP downloads without business writes",\n      async () =>\n        viewerBrowserPhase("journey", async () => {',
  footer: "}),\n      300_000,\n    );",
};
const originalSha = "c1c2c2b4071e5b328eac3c383ebbaa76cd6aef4c6efec68fa4bf742d16ec5e4b";
const observationImport =
  'import { observeViewerJourney } from "./support/us-viewer-journey-observation";\n';
const browserSource = () =>
  readFileSync(resolve(__dirname, "us-demo-viewer-browser.e2e.test.ts"), "utf8");
function inverseJourney(source: string) {
  const ast = ts.createSourceFile("journey.ts", source, ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "observeViewerJourney")
      calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) throw new Error("Missing witness integration");
  expect(call.arguments).toHaveLength(2);
  expect(call.arguments[0]?.getText(ast)).toBe("console.error");
  const action = call.arguments[1];
  if (!action || !ts.isArrowFunction(action) || !ts.isBlock(action.body))
    throw new Error("Invalid witness action");
  expect(action.parameters.map((parameter) => parameter.getText(ast))).toEqual(["enter"]);
  const entered: string[] = [];
  const checkEnter = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "enter") {
      expect(node.arguments).toHaveLength(1);
      const value = node.arguments[0];
      if (!value || !ts.isStringLiteral(value)) throw new Error("Nonliteral checkpoint");
      entered.push(value.text);
    }
    ts.forEachChild(node, checkEnter);
  };
  checkEnter(action.body);
  expect(entered).toHaveLength(33);
  expect([...entered].sort()).toEqual([...checkpoints].sort());
  const declaration = call.parent;
  if (!ts.isVariableDeclaration(declaration)) throw new Error("Missing callback binding");
  expect(declaration.name.getText(ast)).toBe("journey");
  const block = declaration.parent.parent.parent;
  if (!ts.isBlock(block)) throw new Error("Invalid integration owner");
  expect(block.statements).toHaveLength(2);
  expect(block.statements[1]?.getText(ast)).toBe('return viewerBrowserPhase("journey", journey);');
  const callback = block.parent;
  if (!ts.isArrowFunction(callback)) throw new Error("Invalid outer callback");
  expect(callback.parameters).toHaveLength(0);
  const it = callback.parent;
  if (!ts.isCallExpression(it) || !ts.isExpressionStatement(it.parent))
    throw new Error("Invalid test owner");
  expect(it.expression.getText(ast)).toBe("it");
  expect(it.arguments).toHaveLength(3);
  expect(it.arguments[1]).toBe(callback);
  expect(it.arguments[2]?.getText(ast)).toBe("300_000");
  let body = source
    .slice(action.body.getStart(ast) + 1, action.body.end - 1)
    .split("\n")
    .map((line) => (line.length ? `  ${line}` : line))
    .join("\n");
  // Formatter reduced the enclosing it block by two columns. Restore columns
  // only; nine exact small token-preserving formatting pairs handle reflow.
  for (const [old, inserted] of insertionPairs) {
    if (inserted.includes('enter("organization")')) continue;
    expect(body.split(inserted)).toHaveLength(2);
    body = body.replace(inserted, old);
  }
  // Every anchor is checked before erasure, including organization placement.
  for (const [formatted] of formatPairs) expect(body.split(formatted)).toHaveLength(2);
  for (const [formatted, original] of formatPairs) body = body.replace(formatted, original);
  expect(body).not.toMatch(/\benter\(/);
  const statement = it.parent;
  const restored =
    source.slice(0, statement.getStart(ast)) +
    originalEnvelope.header +
    body +
    originalEnvelope.footer +
    source.slice(statement.end);
  expect(restored.split(observationImport)).toHaveLength(2);
  const original = restored.replace(observationImport, "");
  expect(createHash("sha256").update(original).digest("hex")).toBe(originalSha);
  return original;
}

describe("complete original viewer preservation", () => {
  it("inverts only observer insertions and exact formatter reflow to the frozen original SHA", () => {
    inverseJourney(browserSource());
  });
  it.each([
    ["5000", "5001"],
    ["300_000", "300_001"],
    ["960_000", "960_001"],
    ["60_000", "60_001"],
    ['getByLabel("Password"', 'getByLabel("Changed password"'],
    [".fill(f.password)", '.fill("changed")'],
    ["context.request.get(", "context.request.post("],
    ["assert.equal(expectedAudits.length, 22)", "assert.equal(expectedAudits.length, 23)"],
    ["assert.equal(added.length, 22)", "assert.equal(added.length, 23)"],
    ["individualReleases: 18", "individualReleases: 17"],
    ["browserZipReleases: 3", "browserZipReleases: 2"],
    ["browserPlanReleases: 1", "browserPlanReleases: 2"],
    ["await fixture?.close()", "void fixture"],
    ['enter("signin-page")', 'enter("foreign")'],
    ['enter("signin-page");', 'enter("signin-page"); enter("signin-page");'],
  ])("rejects an original behavior or checkpoint mutation %s", (before, after) => {
    const source = browserSource();
    expect(source.includes(before)).toBe(true);
    expect(() => inverseJourney(source.replace(before, after))).toThrow();
  });
  it("feeds the identical failure only into the existing outer redaction boundary", async () => {
    const { viewerBrowserPhase } = await import("./support/us-demo-viewer-browser-fixture");
    let getterReads = 0;
    const primary: object = Object.create(null);
    Object.defineProperty(primary, "message", {
      get() {
        getterReads++;
        throw new Error("Synthetic private");
      },
    });
    const outputs: string[] = [];
    const result = await outcome(() =>
      viewerBrowserPhase(
        "journey",
        observeViewerJourney(
          (value) => outputs.push(value),
          async (enter) => {
            enter("signin-submit");
            throw primary;
          },
        ),
      ),
    );
    expect(getterReads).toBe(0);
    expect(outputs).toEqual([line(5)]);
    expect(result.error).toBeInstanceOf(Error);
    if (result.error instanceof Error) {
      expect(result.error.message).toBe("Viewer browser failed: journey");
      expect(Object.hasOwn(result.error, "cause")).toBe(false);
    }
  });
});
