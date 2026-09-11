import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  EntitlementSnapshotView,
  SourceEffects,
  type EntitlementTranslate,
} from "../src/entitlements/index.js";
import { ENTITLEMENT_SNAPSHOT } from "./entitlements-fixture.js";

afterEach(cleanup);
const translate: EntitlementTranslate = (key, options) =>
  `${key}${options?.value === undefined ? "" : `:${options.value}`}`;
it("presents exact safe facts with injected language, dates and consumer classes", () => {
  const { container } = render(
    <EntitlementSnapshotView
      snapshot={ENTITLEMENT_SNAPSHOT}
      translate={translate}
      formatDate={(value) => `date:${value ?? "open"}`}
      classNames={{
        quotaGrid: "quota-grid",
        quotaItem: "quota-item",
        facts: "facts",
        sources: "sources",
      }}
    />,
  );
  expect(screen.getByText("17 / 20")).toBeDefined();
  expect(screen.getByText("17 / 25")).toBeDefined();
  expect(screen.getByText("entitlements.quotas.kiosks: 0")).toBeDefined();
  expect(
    screen.getByText("entitlements.quotas.cabinetUsers: entitlements.unlimited"),
  ).toBeDefined();
  expect(screen.getAllByText("entitlements.remaining:entitlements.unlimited")).toHaveLength(2);
  expect(screen.getByText("entitlements.features.inventory: entitlements.unknown")).toBeDefined();
  expect(screen.getByText("entitlements.nextChange:date:2026-10-01T00:00:00.000Z")).toBeDefined();
  expect(screen.getByText("entitlements.calculatedAt:date:2026-09-11T12:00:00.000Z")).toBeDefined();
  expect(screen.getByText("entitlements.usageAt:date:2026-09-11T12:00:00.000Z")).toBeDefined();
  expect(screen.getByText("entitlements.operationsLabels.nk_lookup_v1")).toBeDefined();
  expect(container.querySelectorAll(".quota-grid > .quota-item")).toHaveLength(4);
  expect(container.querySelector("dl.facts")?.children).toHaveLength(7);
  expect(container.querySelector("ul.sources")).not.toBeNull();
});
it("classifies source intervals against snapshot time and preserves prepared state and effects", () => {
  const source = ENTITLEMENT_SNAPSHOT.sources[1]!;
  render(
    <EntitlementSnapshotView
      snapshot={{
        ...ENTITLEMENT_SNAPSHOT,
        sources: [
          source,
          {
            ...source,
            id: "future",
            kind: "addon",
            prepared: false,
            startsAt: "2026-09-20T00:00:00.000Z",
            endsAt: null,
          },
          {
            ...source,
            id: "ended",
            kind: "addon",
            prepared: false,
            startsAt: "2026-09-01T00:00:00.000Z",
            endsAt: "2026-09-11T12:00:00.000Z",
          },
        ],
      }}
      translate={translate}
      formatDate={(value) => value ?? "open"}
      classNames={{ quotaGrid: "", quotaItem: "", facts: "", sources: "" }}
    />,
  );
  expect(screen.getByText("entitlements.prepared")).toBeDefined();
  expect(screen.getByText("entitlements.scheduled")).toBeDefined();
  expect(screen.getByText("entitlements.ended")).toBeDefined();
});
it("shares source-effect labels without reading authority or internal metadata", () => {
  render(
    <SourceEffects
      source={{
        effects: [
          { key: "lines", quotaIncrement: 2 },
          { key: "chzIntegration", featureEnabled: true },
        ],
      }}
      translate={translate}
    />,
  );
  expect(screen.getByText("entitlements.quotas.lines: +2")).toBeDefined();
  expect(screen.getByText("entitlements.features.chzIntegration")).toBeDefined();
});
