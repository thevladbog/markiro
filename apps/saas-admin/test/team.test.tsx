import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SUPPORT_ME, jsonResponse, renderSaasApp } from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("platform team", () => {
  it("keeps role controls disabled and invitation hidden without team write access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, SUPPORT_ME);
        if (url.endsWith("/api/platform/team")) {
          return jsonResponse(200, [
            {
              id: "team-user-1",
              name: "Accountant User",
              email: "accountant@example.invalid",
              role: "accountant",
              status: "active",
              twoFactorReady: true,
              createdAt: "2026-08-12T08:00:00.000Z",
            },
          ]);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderSaasApp({ initialEntry: "/team" });

    expect(await screen.findByRole("heading", { name: "Команда платформы" })).toBeDefined();
    expect(
      (
        screen.getByRole("combobox", {
          name: "Роль для accountant@example.invalid",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByText("Пригласить коллегу")).toBeNull();
    expect(document.querySelector('select:not([aria-hidden="true"])')).toBeNull();
  });
});
