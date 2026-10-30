import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ServiceUnavailableException } from "@nestjs/common";
import { expect, it } from "vitest";
import {
  assertUsRequestWorkerExecutionIdentity,
  createHostedUsRequestExecutionIdentity,
  createSyntheticUsRequestExecutionIdentity,
  disposeUsHostedRequestExecutionIdentity,
} from "../src/modules/traceability/requests/us-request-worker-execution";

it("refuses structural owners for hosted execution identity", () => {
  expect(() => createHostedUsRequestExecutionIdentity({}, {})).toThrow(ServiceUnavailableException);
});
it("keeps synthetic authority separate and copied identity unregistered", () => {
  const identity = createSyntheticUsRequestExecutionIdentity(
    { apiVersion: "synthetic-test", gitSha: "a".repeat(40), dirty: false },
    { NODE_ENV: "test", MARKIRO_DEPLOYMENT_EDITION: "US" },
  );
  const copied = { ...identity };
  disposeUsHostedRequestExecutionIdentity(identity);
  expect(() => assertUsRequestWorkerExecutionIdentity(identity)).not.toThrow();
  expect(() => assertUsRequestWorkerExecutionIdentity(copied)).toThrow();
  disposeUsHostedRequestExecutionIdentity(copied);
  expect(() => assertUsRequestWorkerExecutionIdentity(copied)).toThrow();
});

it("preserves the entire original local/synthetic execution source", () => {
  let source = readFileSync(
    resolve(__dirname, "../src/modules/traceability/requests/us-request-worker-execution.ts"),
    "utf8",
  );
  const remove = (start: string, end: string, replacement = "") => {
    expect(source.split(start)).toHaveLength(2);
    expect(source.split(end)).toHaveLength(2);
    const a = source.indexOf(start);
    const b = source.indexOf(end, a);
    expect(b).toBeGreaterThan(a);
    source = source.slice(0, a) + replacement + source.slice(b + end.length);
  };
  remove("// Hosted execution imports.\n", "// End hosted execution imports.\n");
  remove("// Hosted execution authority.\n", "// End hosted execution authority.\n\n");
  remove(
    "  // Hosted assertion branch.\n",
    "  // End hosted assertion branch.\n",
    '  if (!identity || typeof identity !== "object" || !loaded.has(identity)) throw invalid();\n',
  );
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    "4ec98dc6ebc35ca12285a64b5f240a1d785ede61080a0fe2ca424b9c5e4a08d5",
  );
});
