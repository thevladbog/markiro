import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import { AccessProvider } from "../src/access/context.js";
import type { AccessDocument } from "../src/access/api.js";
import { SubscriptionPage } from "../src/pages/settings/SubscriptionPage.js";

const access: AccessDocument = {
  roles: ["owner"],
  capabilities: [],
  subscription: {
    access: "read_only",
    status: "expired",
    startsAt: "2026-01-01T00:00:00Z",
    endsAt: "2026-08-10T00:00:00Z",
    plan: { id: "p", version: 2, nameRu: "Профи", nameEn: "Pro" },
    addons: [{ catalogVersionId: "addon-1", quantity: 2, quotas: { lines: 1 }, features: [] }],
  },
  scheduled: null,
  usage: { lines: 2, stations: 0, kiosks: 0, cabinetUsers: 1 },
  quotas: { lines: 1, stations: 2, kiosks: 2, cabinetUsers: 5 },
  features: { labelEditor: false, publicApi: false, pallets: false },
};

it("renders read-only status and quota progress with add-ons", () => {
  render(
    <ThemeProvider defaultTheme="light">
      <MemoryRouter>
        <AccessProvider value={access}>
          <SubscriptionPage />
        </AccessProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
  expect(screen.getByRole("status").textContent).toContain("Срок истёк");
  expect(screen.getByText("2 / 1")).toBeTruthy();
  expect(screen.getByText(/addon-1/)).toBeTruthy();
});
