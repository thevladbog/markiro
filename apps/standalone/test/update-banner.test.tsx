import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { UpdateBanner } from "../src/office/banners/UpdateBanner.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import type { HostUpdateOffer } from "../src/update/host-offer.js";
import { UpdateOfferProvider } from "../src/update/offer-context.js";
import { fakeOfficeSession, TECHNOLOGIST } from "./support/office.js";

const AVAILABLE: HostUpdateOffer = {
  kind: "available",
  hostVersion: "0.3.0",
  required: false,
  manifest: {
    version: "0.3.0",
    channel: "stable",
    releasedAt: "2026-11-02T10:00:00Z",
    notes: [],
    minUpgradeFrom: "0.2.0",
    protocol: 4,
    minProtocol: 3,
    sizeBytes: 200,
  },
};

function show(offer: HostUpdateOffer, user?: typeof TECHNOLOGIST) {
  const session = fakeOfficeSession(user === undefined ? {} : { user });
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <OfficeSessionProvider value={session}>
          <UpdateOfferProvider value={offer}>
            <UpdateBanner />
            <main tabIndex={-1} />
          </UpdateOfferProvider>
        </OfficeSessionProvider>
      ),
    },
  ]);
  render(
    <ThemeProvider defaultTheme="dark">
      <RouterProvider router={router} />
    </ThemeProvider>,
  );
}

describe("the office's strip «Доступно обновление» (spec §10.11.5, T6)", () => {
  it("leads the administrator to «Информация» → «Обновление» and closes for the session", () => {
    show(AVAILABLE);
    expect(screen.getByText(/Доступно обновление 0\.3\.0 с хоста\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Установить" }).getAttribute("href")).toBe(
      "/about#update",
    );
    fireEvent.click(screen.getByRole("button", { name: "Скрыть до следующего входа" }));
    expect(screen.queryByText(/Доступно обновление/)).toBeNull();
  });

  it("tells the technologist that an administrator installs it, with no link", () => {
    show(AVAILABLE, TECHNOLOGIST);
    expect(screen.getByText("Доступно обновление; установит администратор.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Установить" })).toBeNull();
  });

  it("is nothing without an available update", () => {
    show({ kind: "none" });
    expect(screen.queryByText(/обновление/i)).toBeNull();
  });
});
