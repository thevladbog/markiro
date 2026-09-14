import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../src/i18n/index.js";
import { ACCOUNTANT_ME, SUPPORT_ME, jsonResponse, renderSaasApp } from "./render.js";

const period = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "tenant-a",
  orderedServiceId: "22222222-2222-4222-8222-222222222222",
  catalogItemId: "33333333-3333-4333-8333-333333333333",
  catalogVersionId: "44444444-4444-4444-8444-444444444444",
  nameRu: "Сервисное сопровождение",
  nameEn: "Service support",
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: "2026-10-01T00:00:00.000Z",
  state: "active",
  revision: 2,
  balance: { included: 180, externallyApproved: 0, consumed: 45, remaining: 135 },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await i18n.changeLanguage("ru");
});

function install(principal: typeof SUPPORT_ME | typeof ACCOUNTANT_ME) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, principal);
      if (url.includes("/api/platform/service-periods?"))
        return jsonResponse(200, { items: [period], nextCursor: null });
      if (url.endsWith(`/api/platform/service-periods/${period.id}`))
        return jsonResponse(200, {
          ...period,
          invoiceId: "55555555-5555-4555-8555-555555555555",
          invoiceLineId: "66666666-6666-4666-8666-666666666666",
          paymentId: "77777777-7777-4777-8777-777777777777",
          entries: [],
          approvals: [],
        });
      return jsonResponse(404, { code: "not_found" });
    }),
  );
}

describe("service period workspace", () => {
  it("lets support post usage without exposing allowance approval", async () => {
    install(SUPPORT_ME);
    renderSaasApp({ initialEntry: `/service-periods` });
    expect(await screen.findByRole("heading", { name: "Периоды услуг" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Услуги" })).toBeDefined();
    await screen.findByText("Сервисное сопровождение");
    screen.getByRole("button", { name: "Открыть" }).click();
    expect(await screen.findByRole("button", { name: "Списать работу" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Добавить согласование" })).toBeNull();
  });

  it("lets accounting approve allowance without posting usage", async () => {
    install(ACCOUNTANT_ME);
    renderSaasApp({ initialEntry: `/service-periods` });
    await screen.findByText("Сервисное сопровождение");
    screen.getByRole("button", { name: "Открыть" }).click();
    expect(await screen.findByRole("button", { name: "Добавить согласование" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Списать работу" })).toBeNull();
  });

  it("localizes the workspace and restores focus after closing the service drawer", async () => {
    await i18n.changeLanguage("en");
    install(SUPPORT_ME);
    renderSaasApp({ initialEntry: "/service-periods" });
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Service periods" })).toBeDefined();
    await screen.findByText("Service support");
    const open = screen.getByRole("button", { name: "Open" });
    await user.click(open);
    expect(await screen.findByRole("dialog", { name: "Service support" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Close service period" }));
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("retries the exact usage request after a lost response and locks edits", async () => {
    const bodies: unknown[] = [];
    let postCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, SUPPORT_ME);
        if (url.includes("/api/platform/service-periods?"))
          return jsonResponse(200, { items: [period], nextCursor: null });
        if (url.endsWith(`/api/platform/service-periods/${period.id}`))
          return jsonResponse(200, {
            ...period,
            invoiceId: "55555555-5555-4555-8555-555555555555",
            invoiceLineId: "66666666-6666-4666-8666-666666666666",
            paymentId: "77777777-7777-4777-8777-777777777777",
            entries: [],
            approvals: [],
          });
        if (url.endsWith(`/api/platform/service-periods/${period.id}/usage`)) {
          bodies.push(JSON.parse(String(init.body)));
          postCount += 1;
          if (postCount === 1) throw new TypeError("response lost");
          return jsonResponse(200, { revision: 3, balance: period.balance });
        }
        return jsonResponse(404, { code: "not_found" });
      }),
    );
    renderSaasApp({ initialEntry: "/service-periods" });
    const user = userEvent.setup();
    await screen.findByText("Сервисное сопровождение");
    await user.click(screen.getByRole("button", { name: "Открыть" }));
    await user.type(await screen.findByLabelText("Фактические минуты"), "45");
    await user.type(screen.getByLabelText("Ссылка на работу"), "SUP-42");
    await user.type(screen.getByLabelText("Описание работы"), "Настройка");
    await user.click(screen.getByRole("button", { name: "Списать работу" }));
    expect(await screen.findByText(/Результат не подтверждён/)).toBeDefined();
    expect(screen.getByLabelText("Фактические минуты")).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Повторить исходный запрос" }));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });
});
