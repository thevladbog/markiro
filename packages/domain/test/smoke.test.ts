import { describe, expect, it } from "vitest";
import { DOMAIN_PACKAGE } from "../src/index.js";

describe("package wiring", () => {
  it("exports the package marker", () => {
    expect(DOMAIN_PACKAGE).toBe("@markiro/domain");
  });
});
