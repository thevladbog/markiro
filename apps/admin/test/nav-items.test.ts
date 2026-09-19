import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "../src/layout/AppShell.js";

describe("sidebar navigation", () => {
  it("groups routes as in mockup variant B", () => {
    const bySection = new Map<string, string[]>();
    for (const item of NAV_ITEMS)
      bySection.set(item.sectionKey, [...(bySection.get(item.sectionKey) ?? []), item.to]);
    expect([...bySection.entries()]).toEqual([
      ["shell.sections.production", ["/", "/shifts", "/lines", "/conflicts"]],
      [
        "shell.sections.marking",
        ["/km-orders", "/codes", "/inventory", "/pickup", "/disaggregation"],
      ],
      ["shell.sections.reference", ["/catalog", "/labels", "/counterparties", "/employees"]],
      ["shell.sections.equipment", ["/devices", "/integrations"]],
      ["shell.sections.organization", ["/team", "/billing", "/settings"]],
    ]);
  });
});
