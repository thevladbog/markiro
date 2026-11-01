import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  officeSearchRequestSchema,
  officeSearchResponseSchema,
} from "../src/host/office-search.js";
import { createHostApi } from "../src/host/api.js";
import type { HostClient } from "../src/host/client.js";

const testModuleUrl = import.meta.url;
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));

describe("office global search protocol", () => {
  it("parses shared Rust fixtures", () => {
    for (const [name, schema] of [
      ["office-search-request.json", officeSearchRequestSchema],
      ["office-search-response.json", officeSearchResponseSchema],
    ] as const) {
      const value = fixture(name);
      expect(schema.parse(value)).toEqual(value);
    }
  });
  it("rejects unsafe or unbounded requests", () => {
    for (const value of [
      { kind: "code", codeHash: "raw" },
      { kind: "text", text: "x" },
      { kind: "text", text: "x".repeat(121) },
      { kind: "text", text: "valid", raw: "secret" },
    ])
      expect(officeSearchRequestSchema.safeParse(value).success).toBe(false);
  });
  it("posts normalized queries only in a body", async () => {
    const request = vi.fn().mockResolvedValue({ items: [], truncated: false });
    const api = createHostApi({ request } as unknown as HostClient);
    await api.searchOffice("session", { kind: "text", text: "Молоко" });
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/v1/office/search",
      expect.objectContaining({ officeToken: "session", body: { kind: "text", text: "Молоко" } }),
    );
    await expect(api.searchOffice("session", { kind: "code", codeHash: "raw" })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
