import { describe, expect, it } from "vitest";
import { resolveUsAccess, hasUsCapabilities, resolveCabinetAccess } from "../src/index.js";

const full = [
  "traceability.read",
  "traceability.master_data.write",
  "traceability.receiving.write",
  "traceability.transformation.write",
  "traceability.shipping.write",
  "traceability.qa.manage",
  "traceability.export.read",
  "tenant.settings.manage",
  "members.manage",
];

describe("isolated US role capabilities", () => {
  it("provides a US resolver without replacing the RU resolver", () => {
    expect(resolveUsAccess).toBeTypeOf("function");
    expect(resolveCabinetAccess("manager").capabilities).toEqual([
      "operations.read",
      "operations.write",
    ]);
  });

  it.each([
    ["traceability_receiving", ["traceability.read", "traceability.receiving.write"]],
    ["traceability_production", ["traceability.read", "traceability.transformation.write"]],
    ["traceability_shipping", ["traceability.read", "traceability.shipping.write"]],
    ["traceability_auditor", ["traceability.read", "traceability.export.read"]],
    [
      "traceability_qa",
      [
        "traceability.read",
        "traceability.master_data.write",
        "traceability.receiving.write",
        "traceability.transformation.write",
        "traceability.shipping.write",
        "traceability.qa.manage",
        "traceability.export.read",
      ],
    ],
    [
      "manager",
      [
        "traceability.read",
        "traceability.master_data.write",
        "traceability.receiving.write",
        "traceability.transformation.write",
        "traceability.shipping.write",
      ],
    ],
    ["admin", full],
    ["owner", full],
    ["member", []],
  ])("grants exactly the permitted actions to %s", (role, capabilities) => {
    expect(resolveUsAccess(String(role))).toEqual({ roles: [role], capabilities });
  });

  it.each(["", "unknown", "OWNER", "traceability.read", "__proto__", "constructor"])(
    "fails closed for unknown membership role %s",
    (role) => {
      expect(resolveUsAccess(role)).toEqual({ roles: [], capabilities: [] });
    },
  );

  it("unions and deduplicates recognized roles without granting administration", () => {
    expect(
      resolveUsAccess(
        " traceability_receiving,traceability_auditor,traceability_receiving,unknown ",
      ),
    ).toEqual({
      roles: ["traceability_receiving", "traceability_auditor"],
      capabilities: [
        "traceability.read",
        "traceability.receiving.write",
        "traceability.export.read",
      ],
    });
  });

  it("requires every requested capability and does not mutate prior resolutions", () => {
    const access = resolveUsAccess("traceability_auditor");
    expect(
      hasUsCapabilities(access.capabilities, ["traceability.read", "traceability.export.read"]),
    ).toBe(true);
    expect(
      hasUsCapabilities(access.capabilities, ["traceability.read", "traceability.qa.manage"]),
    ).toBe(false);
    expect(hasUsCapabilities([], ["traceability.read"])).toBe(false);
    access.capabilities.length = 0;
    expect(resolveUsAccess("traceability_auditor").capabilities).toEqual([
      "traceability.read",
      "traceability.export.read",
    ]);
  });

  it("does not make US-only roles recognizable to the RU resolver", () => {
    for (const role of [
      "traceability_receiving",
      "traceability_production",
      "traceability_shipping",
      "traceability_qa",
      "traceability_auditor",
    ]) {
      expect(resolveCabinetAccess(role)).toEqual({ roles: [], capabilities: [] });
    }
  });
});
