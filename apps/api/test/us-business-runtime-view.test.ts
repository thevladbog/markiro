import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { UsRuntime } from "../src/deployment/us-runtime";
import type { UsBusinessRuntimeView } from "../src/deployment/us-business-runtime-view";
type Assert<T extends true> = T;
const noEnvironment: Assert<"env" extends keyof UsBusinessRuntimeView ? false : true> = true;
const noPool: Assert<"pool" extends keyof UsBusinessRuntimeView["connection"] ? false : true> =
  true;
const noResources: Assert<
  "resources" extends keyof UsBusinessRuntimeView["requestHttp"] ? false : true
> = true;
const noShutdown: Assert<
  "onApplicationShutdown" extends keyof UsBusinessRuntimeView ? false : true
> = true;
const existingAccepted: Assert<UsRuntime extends UsBusinessRuntimeView ? true : false> = true;
type StructuralRequest = Readonly<{
  reads: Pick<UsRuntime["requestHttp"]["reads"], "list" | "listRuns" | "getRun" | "listAttempts">;
  commands: Pick<
    UsRuntime["requestHttp"]["commands"],
    "create" | "update" | "close" | "validate" | "acknowledgeWarnings" | "prepare" | "retry"
  >;
  downloads: Pick<UsRuntime["requestHttp"]["downloads"], "download">;
  get: UsRuntime["requestHttp"]["get"];
}>;
const structuralAccepted: Assert<
  StructuralRequest extends UsBusinessRuntimeView["requestHttp"] ? true : false
> = true;
const genericPreserved: Assert<
  UsBusinessRuntimeView["databaseOperation"] extends <T>(operation: () => Promise<T>) => Promise<T>
    ? true
    : false
> = true;
it("accepts the existing runtime and structural request methods without ownership authority", () => {
  expect([
    noEnvironment,
    noPool,
    noResources,
    noShutdown,
    existingAccepted,
    structuralAccepted,
    genericPreserved,
  ]).toEqual(Array(7).fill(true));
});
vi.mock("../src/deployment/us-runtime", () => {
  throw new Error("Runtime module evaluated");
});
it("importing only the erased view does not evaluate the runtime", async () => {
  expect(Object.keys(await import("../src/deployment/us-business-runtime-view"))).toEqual([]);
});
const originals = [
  [
    "us-development.module.ts",
    "899abda230f5b61abff24ec0f8b1177a284fc8fca6b251724462d4806ad5f126",
    1,
  ],
  ["us-case.controller.ts", "7af58d6e2acdb969cf08d2a069f7e047c4b5cf5fe6ce20b6b881c4a0fe33283b", 1],
  [
    "us-catalog.controller.ts",
    "40e0b441c45ea4c8a69673e0aa30188e4481db646cb48f1d5799c4042172b1f6",
    1,
  ],
  [
    "us-events.controller.ts",
    "ea7c93fe0469fb91785d68454b81cd0c7dab4d9f563c2b65de1468c51341a47f",
    1,
  ],
  [
    "us-export-runs.controller.ts",
    "2005f93032199ccbe91ba9f338a1510ad8e313954ac667c15582d2d68886a34f",
    1,
  ],
  ["us-lot.controller.ts", "6a4ab5831140d836229ce725c4e07c012c6ed1d0595591b5782fadb8fe9cb892", 1],
  [
    "us-master-data.controller.ts",
    "322c3f96e33edd730417c18ae9b9270b15020b67da0c5efc4be7621dec6a5d8e",
    1,
  ],
  ["us-plans.controller.ts", "8ed325f9f913a5671916c7d3dae4463217c5b6be9ca1d37d105dfec84edfd914", 1],
  [
    "us-product-profile.controller.ts",
    "f3b26884940f7c05eaa95de53b4be91b7b276d18d55ecdab5a9435d0942eb9ca",
    1,
  ],
  [
    "us-profile.controller.ts",
    "97994eb0bb2718dab043f481e3ecb72d79c80d3a7f50bfad5c71bb21cc739064",
    2,
  ],
  [
    "us-readiness.controller.ts",
    "073a944458758a199a91e4552f53e55d7af9de3be0341652ac180e44a49f5bbb",
    1,
  ],
  [
    "us-receiving.controller.ts",
    "e6305a1e60043c5f52cfa5e9cfff817afbb7be04c0adff8bd83d9830f8d9a015",
    1,
  ],
  [
    "us-receiving-csv.controller.ts",
    "a1e37a01722bb792283f4e5f39d9a78ba30fff21aa350a798c678f0afefb2f54",
    1,
  ],
  [
    "us-reference-document.controller.ts",
    "31d3c014e26833f3738eac98aea2b40874be8c64266f397f7f656c3db932aeef",
    1,
  ],
  [
    "us-requests.controller.ts",
    "515d52b300d5ce2daf62b6db492f253ec5503465ad55028c190978e7d9cc7507",
    1,
  ],
  [
    "us-search-lot-card.controller.ts",
    "8501795ee5d569b931dfbf9caec5e9d400504776df707fbe6ba27677f3bcf914",
    1,
  ],
  [
    "us-shipping.controller.ts",
    "7aba9b8c5fda49b800ee26e0060dc241f8311414f7f24fe091dfd2fdc0069623",
    1,
  ],
  [
    "us-shipping-balance.controller.ts",
    "996af78c1f95dc19190e78c42baa232e1391d308ce81d14f4d39991a1c421322",
    1,
  ],
  ["us-trace.controller.ts", "ff7f2723224111c0dc1201d3dc81d7003b5e973c9533cce6c0f4a07180b2edf2", 1],
  [
    "us-transformation.controller.ts",
    "1e757afb67e20898ddf0f97c817d8864e03ebd63bdd6afa7d0b6e8095e2d0573",
    1,
  ],
] as const;
const viewImport = 'import type { UsBusinessRuntimeView } from "./us-business-runtime-view";\n';
function restore(file: string, source: string, sha: string, count: number) {
  expect(source.split(viewImport)).toHaveLength(2);
  expect(source.split("runtime: UsBusinessRuntimeView")).toHaveLength(count + 1);
  expect(source.includes("runtime: UsRuntime")).toBe(false);
  const original = source
    .replace(viewImport, "")
    .replaceAll("runtime: UsBusinessRuntimeView", "runtime: UsRuntime");
  expect(createHash("sha256").update(original).digest("hex"), file).toBe(sha);
}
const read = (file: string) => readFileSync(resolve(__dirname, "../src/deployment", file), "utf8");
it.each(originals)("preserves every original source byte in %s", (file, sha, count) => {
  restore(file, read(file), sha, count);
});
it.each([
  ["us-development.module.ts", "provide: UsRuntime", "provide: Object"],
  ["us-profile.controller.ts", "@Inject(UsRuntime)", "@Inject(Object)"],
  [
    "us-requests.controller.ts",
    "this.runtime.databaseOperation",
    "void this.runtime.databaseOperation",
  ],
])("rejects executable mutation in %s", (file, before, after) => {
  const entry = originals.find(([name]) => name === file);
  if (!entry) throw new Error("Missing original pin");
  const source = read(file);
  expect(source.includes(before)).toBe(true);
  expect(() => restore(file, source.replace(before, after), entry[1], entry[2])).toThrow();
});
