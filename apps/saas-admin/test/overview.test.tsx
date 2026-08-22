import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import i18n from "../src/i18n/index.js";

import { ACCOUNTANT_ME, renderSaasApp } from "./render.js";
import {
  DEGRADED_PLATFORM,
  installOperationsApi,
  OPERATIONS_OVERVIEW,
} from "./operationsFixtures.js";

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

describe("operational overview", () => {
  it("renders server-defined metrics and exact decision destinations", async () => {
    installOperationsApi();
    renderSaasApp({ initialEntry: "/" });

    expect(await screen.findByRole("heading", { name: "Операционный обзор" })).toBeDefined();
    const metrics = await screen.findByRole("group", { name: "Ключевые показатели" });
    expect(metrics.textContent).toContain("12");
    expect(metrics.textContent).toContain("3");
    expect(metrics.textContent).toContain("2");
    expect(screen.getByRole("link", { name: /MK-42/ }).getAttribute("href")).toBe(
      "/invoices/11111111-1111-4111-8111-111111111111",
    );
    expect(screen.getByRole("link", { name: /Подписка.*Первый завод/ }).getAttribute("href")).toBe(
      "/tenants/21111111-1111-4111-8111-111111111111#tenant-subscription",
    );
    expect(
      screen.getByRole("link", { name: /Юридические данные.*Первый завод/ }).getAttribute("href"),
    ).toBe("/tenants/21111111-1111-4111-8111-111111111111?tab=legal");
    expect(
      screen
        .getByRole("link", { name: "Наша организация · реквизиты и счета" })
        .getAttribute("href"),
    ).toBe("/settings/organization");
    expect(screen.getByText("tenant.created")).toBeDefined();
  });

  it("keeps health visible when the overview contract is invalid", async () => {
    installOperationsApi({ overview: { activeTenants: "not-a-number" } });
    renderSaasApp({ initialEntry: "/" });

    expect(await screen.findByText("Формат ответа платформы изменился")).toBeDefined();
    expect(screen.getByText("Все системы работают штатно")).toBeDefined();
  });

  it("shows degraded components without turning configuration into an outage", async () => {
    installOperationsApi({ monitoring: DEGRADED_PLATFORM });
    renderSaasApp({ initialEntry: "/" });

    expect(await screen.findByText("Есть отклонения")).toBeDefined();
    expect(screen.getByText("SMTP").parentElement?.textContent).toContain("Задержка ответа");
    expect(screen.getByText("DaData").parentElement?.textContent).toContain("Подключена");
  });

  it("renders an empty decision queue as a confirmed state", async () => {
    installOperationsApi({ overview: { ...OPERATIONS_OVERVIEW, decisionQueue: [] } });
    renderSaasApp({ initialEntry: "/" });

    expect(await screen.findByText("Решений, требующих внимания, нет")).toBeDefined();
  });

  it("can retry an unavailable overview independently", async () => {
    const user = userEvent.setup();
    let overviewCalls = 0;
    installOperationsApi();
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/platform/operations/overview")) {
        overviewCalls += 1;
        if (overviewCalls === 1) return new Response(null, { status: 503 });
      }
      if (!original) throw new Error("Missing fixture implementation");
      return original(input, init);
    });
    renderSaasApp({ initialEntry: "/" });

    await user.click(await screen.findByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("tenant.created")).toBeDefined();
    expect(overviewCalls).toBe(2);
  });

  it("does not request diagnostics for a role without the capability", async () => {
    const api = installOperationsApi({ me: ACCOUNTANT_ME });
    renderSaasApp({ initialEntry: "/" });

    expect(await screen.findByText("tenant.created")).toBeDefined();
    expect(api.requests.some((url) => url.endsWith("/operations/monitoring"))).toBe(false);
    expect(screen.queryByRole("heading", { name: "Состояние платформы" })).toBeNull();
  });

  it("formats activity timestamps with the active interface language", async () => {
    await i18n.changeLanguage("en");
    const format = vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("localized-time");
    installOperationsApi();
    renderSaasApp({ initialEntry: "/" });

    expect(await screen.findByText("localized-time")).toBeDefined();
    expect(format).toHaveBeenCalledWith("en-GB");
  });

  it("renders a supplied overview without billing metrics or decisions", async () => {
    installOperationsApi({
      overview: {
        ...OPERATIONS_OVERVIEW,
        overdueInvoices: null,
        decisionQueue: OPERATIONS_OVERVIEW.decisionQueue.filter(
          (item) => item.kind === "subscription_ending",
        ),
      },
    });
    renderSaasApp({ initialEntry: "/" });

    const metrics = await screen.findByRole("group", { name: "Ключевые показатели" });
    expect(metrics.textContent).not.toContain("Просроченные счета");
    expect(screen.queryByRole("link", { name: /MK-42/ })).toBeNull();
    expect(screen.queryByText(/Юридические данные/)).toBeNull();
  });
});
