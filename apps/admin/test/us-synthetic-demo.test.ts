import { describe, expect, it } from "vitest";
import { isUsReadOnlyAccess, isUsSyntheticDemoOrganization } from "../src/us/synthetic-demo.js";

const stamp = { synthetic: true, seedVersion: "us-development-owner-v1" };
const organization = {
  id: "tenant",
  name: "Synthetic US development",
  slug: "us-development-demo",
  metadata: JSON.stringify(stamp),
};

describe("US synthetic organization presentation", () => {
  it("recognizes only the exact owner stamp, independent of JSON key order", () => {
    expect(isUsSyntheticDemoOrganization(organization)).toBe(true);
    expect(
      isUsSyntheticDemoOrganization({
        ...organization,
        metadata: JSON.stringify({ seedVersion: stamp.seedVersion, synthetic: true }),
      }),
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    [],
    "Synthetic US development",
    {},
    { ...organization, name: "Synthetic Foods" },
    { ...organization, slug: "us-development-demo-other" },
    { ...organization, metadata: undefined },
    { ...organization, metadata: stamp },
    { ...organization, metadata: "{" },
    { ...organization, metadata: "null" },
    { ...organization, metadata: "[]" },
    { ...organization, metadata: JSON.stringify({ ...stamp, extra: true }) },
    { ...organization, metadata: JSON.stringify({ ...stamp, synthetic: "true" }) },
    {
      ...organization,
      metadata: JSON.stringify({ ...stamp, seedVersion: "us-development-viewer-v1" }),
    },
    { ...organization, metadata: JSON.stringify({ synthetic: true }) },
    { ...organization, metadata: " ".repeat(513) + organization.metadata },
    { ...organization, metadata: "é".repeat(260) },
  ])("rejects absent, foreign or malformed markers %#", (value) => {
    expect(isUsSyntheticDemoOrganization(value)).toBe(false);
  });

  it("bounds metadata by UTF-8 bytes including JSON whitespace", () => {
    const exact = organization.metadata.padEnd(512, " ");
    expect(isUsSyntheticDemoOrganization({ ...organization, metadata: exact })).toBe(true);
    expect(isUsSyntheticDemoOrganization({ ...organization, metadata: exact + " " })).toBe(false);
  });

  it("labels only the exact current read/export capability set, regardless of order", () => {
    expect(isUsReadOnlyAccess(["traceability.read", "traceability.export.read"])).toBe(true);
    expect(isUsReadOnlyAccess(["traceability.export.read", "traceability.read"])).toBe(true);
    for (const capabilities of [
      null,
      [],
      ["traceability.read"],
      ["traceability.export.read"],
      ["traceability.read", "traceability.read"],
      ["traceability.read", "traceability.export.read", "traceability.qa.manage"],
      ["traceability.read", "traceability.export.read", "members.manage"],
    ])
      expect(isUsReadOnlyAccess(capabilities)).toBe(false);
  });
});
