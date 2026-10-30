import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ServiceUnavailableException } from "@nestjs/common";
import { expect, it } from "vitest";
import { UsHostedRequestHttpCommands } from "../src/modules/traceability/requests/us-hosted-request-http-commands";

it("requires actual hosted resources before constructing DB command stores", () => {
  // @ts-expect-error Invalid DB and resource inputs must fail at the provenance boundary.
  expect(() => new UsHostedRequestHttpCommands(undefined, {})).toThrow(ServiceUnavailableException);
});

it("preserves complete authorization, rejection audit, preflight and retry orchestration bytes", () => {
  const folder = resolve(__dirname, "../src/modules/traceability/requests");
  const local = readFileSync(resolve(folder, "us-request-http-commands.ts"), "utf8");
  let source = readFileSync(resolve(folder, "us-hosted-request-http-commands.ts"), "utf8");
  const replace = (before: string, after: string) => {
    expect(source.split(before)).toHaveLength(2);
    source = source.replace(before, after);
  };
  replace(
    `import {
  assertUsHostedRequestHttpResources,
  type UsHostedRequestHttpResources,
} from "../../../deployment/us-hosted-request-http-resources";`,
    `import {
  assertLoadedUsRequestBuildDescriptor,
  type LoadedUsRequestBuildDescriptor,
} from "../../../deployment/us-request-build-descriptor";`,
  );
  replace(
    "import { UsRequestStore }",
    'import type { UsRequestPackageArtifactStore } from "./us-request-package-artifacts";\nimport { UsRequestStore }',
  );
  replace(
    'type UsHostedRequestBuild = Awaited<ReturnType<UsHostedRequestHttpResources["checkedBuild"]>>;',
    `export interface UsRequestHttpGates {
  loadBuild(): Promise<LoadedUsRequestBuildDescriptor>;
  requirePackageStore(): UsRequestPackageArtifactStore;
}`,
  );
  replace("export class UsHostedRequestHttpCommands {", "export class UsRequestHttpCommands {");
  replace(
    "private readonly gates: UsHostedRequestHttpResources",
    "private readonly gates: UsRequestHttpGates",
  );
  replace("    assertUsHostedRequestHttpResources(gates);\n", "");
  replace(
    `      assertUsHostedRequestHttpResources(this.gates);
      const loaded = await this.gates.checkedBuild();
      assertUsHostedRequestHttpResources(this.gates);
      return loaded;`,
    `      const loaded = await this.gates.loadBuild();
      assertLoadedUsRequestBuildDescriptor(loaded);
      return loaded;`,
  );
  replace(
    `  private packageStore(): void {
    try {
      assertUsHostedRequestHttpResources(this.gates);`,
    `  private packageStore(): void {
    try {`,
  );
  expect(source.split("UsHostedRequestBuild")).toHaveLength(4);
  source = source.replaceAll("UsHostedRequestBuild", "LoadedUsRequestBuildDescriptor");
  expect(source.split("loaded.build")).toHaveLength(3);
  source = source.replaceAll("loaded.build", "loaded.document.build");
  expect(source).toBe(local);
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    "4fa97599236d95aaec173f5601a4997837aca141afe245a88db60474234fcfb9",
  );
});
