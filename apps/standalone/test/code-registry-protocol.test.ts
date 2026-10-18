import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createHostApi } from "../src/host/api.js";
import type { HostClient } from "../src/host/client.js";
import {
  codeRegistryPath,
  codeRegistryCardSchema,
  codeRegistryPageSchema,
} from "../src/host/code-registry.js";

const testModuleUrl = import.meta.url;
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));

describe("unified code registry contract", () => {
  it("mirrors source-discriminated Rust pages and cards without dropping fields", () => {
    const page = fixture("code-registry-page.json");
    const card = fixture("code-registry-card.json");
    expect(codeRegistryPageSchema.parse(page)).toEqual(page);
    expect(codeRegistryCardSchema.parse(card)).toEqual(card);
  });
  it("uses a fixed source-aware query path and refuses unsafe values", () => {
    expect(codeRegistryPath({ page: 2, source: "cloud", shift: "OCT26-004/S" })).toBe(
      "/v1/office/code-registry?shift=OCT26-004/S&page=2&source=cloud",
    );
    expect(() => codeRegistryPath({ shift: "../ users" })).toThrow(RangeError);
  });
  it("sends the office session and validates each response", async () => {
    const sent: string[] = [];
    const page = fixture("code-registry-page.json");
    const card = codeRegistryCardSchema.parse(fixture("code-registry-card.json"));
    const client: HostClient = {
      request: async (_, path, options) => {
        expect(options.officeToken).toBe("session");
        sent.push(path);
        return options.schema.parse(path.includes("?") ? page : card);
      },
    };
    const api = createHostApi(client);
    await expect(
      api.searchCodeRegistry("session", { gtin: "04600682000013", source: "all" }),
    ).resolves.toEqual(page);
    await expect(api.getCodeRegistryCard("session", card.codeHash)).resolves.toEqual(card);
    await expect(api.getCodeRegistryCard("session", "../users")).rejects.toThrow(RangeError);
    expect(sent).toHaveLength(2);
  });
});
