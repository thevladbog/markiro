import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, PLATFORM_ADMIN_ME, renderSaasApp } from "./render";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("organization settings", () => {
  it("loads our legal profile, multiple accounts, and DaData health independently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith("/api/platform/billing/operator-profile")) return jsonResponse(200, null);
        if (url.endsWith("/api/platform/billing/operator/accounts")) return jsonResponse(200, []);
        if (url.endsWith("/api/platform/suggestions/status")) {
          return jsonResponse(200, { status: "unconfigured" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderSaasApp({ initialEntry: "/settings/organization" });

    expect(await screen.findByRole("heading", { name: "Наша организация" })).toBeDefined();
    expect(
      screen.getByText("Юридические данные продавца и расчётные счета для документов"),
    ).toBeDefined();
    expect(await screen.findByText("Реквизиты продавца")).toBeDefined();
    expect(await screen.findByText("Расчётные счета")).toBeDefined();
    expect(await screen.findByText("DaData не настроена — ручной ввод доступен")).toBeDefined();
    expect(screen.getByText("Настройки")).toBeDefined();
  });

  it("keeps legal and bank settings usable when optional DaData health is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith("/api/platform/billing/operator-profile")) return jsonResponse(200, null);
        if (url.endsWith("/api/platform/billing/operator/accounts")) return jsonResponse(200, []);
        if (url.endsWith("/api/platform/suggestions/status")) {
          return jsonResponse(503, { code: "dadata_unavailable" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderSaasApp({ initialEntry: "/settings/organization" });

    expect(await screen.findByText("Реквизиты продавца")).toBeDefined();
    expect(await screen.findByText("Расчётные счета")).toBeDefined();
    expect(
      await screen.findByText("DaData временно недоступна — ручной ввод доступен"),
    ).toBeDefined();
  });
});
