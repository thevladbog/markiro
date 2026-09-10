import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(new URL("../../apps/admin/package.json", import.meta.url));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const source = readFileSync(
  new URL(
    "../../docs/design-briefs/design_handoff_markiro/design-system/components/forms/Input.jsx",
    import.meta.url,
  ),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
});
const exports = {};
runInNewContext(outputText, { require, exports, Math });
const { Input } = exports;

test("handoff inputs keep distinct label targets without relying on random numbers", (t) => {
  t.mock.method(Math, "random", () => 0.5);
  const html = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Input, { label: "First" }),
      React.createElement(Input, { label: "Second" }),
    ),
  );
  const ids = [...html.matchAll(/<input id="([^"]+)"/g)].map((match) => match[1]);
  const labels = [...html.matchAll(/<label for="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(labels, ids);
});

test("handoff input preserves an explicit label target", () => {
  const html = renderToStaticMarkup(
    React.createElement(Input, { id: "scan-input", label: "Scan" }),
  );
  assert.match(html, /<label for="scan-input"/);
  assert.match(html, /<input id="scan-input"/);
});
