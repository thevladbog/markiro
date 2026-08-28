import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";
import { AccessProvider } from "../src/access/context.js";
import type { AccessDocument } from "../src/access/api.js";
import { SubscriptionBanner } from "../src/subscription/SubscriptionBanner.js";

const base: AccessDocument = {
  roles: ["owner"],
  capabilities: [CABINET_CAPABILITY.BILLING_READ],
  subscription: {
    access: "managed",
    status: "trial",
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    plan: { id: "p", version: 1, nameRu: "Демо", nameEn: "Demo" },
    addons: [],
  },
  scheduled: null,
  usage: { lines: 0, stations: 0, kiosks: 0, cabinetUsers: 1 },
  quotas: { lines: 1, stations: 1, kiosks: 1, cabinetUsers: 2 },
  features: { labelEditor: true, publicApi: false, pallets: false },
};

it("shows trial days and links to subscription limits", () => {
  render(
    <ThemeProvider defaultTheme="light">
      <MemoryRouter>
        <AccessProvider value={base}>
          <SubscriptionBanner />
        </AccessProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
  expect(screen.getByRole("alert").textContent).toContain("Демо закончится через 3 дн.");
  expect(screen.getByRole("link", { name: "Посмотреть лимиты" }).getAttribute("href")).toBe(
    "/billing/subscription",
  );
});
